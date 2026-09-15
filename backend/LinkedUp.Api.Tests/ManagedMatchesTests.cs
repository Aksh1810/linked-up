using System.Net.WebSockets;
using System.Text.Json;
using LinkedUp.Api.Matches;
using LinkedUp.Api.Rooms;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace LinkedUp.Api.Tests;

public sealed class ManagedMatchesTests
{
    [Theory]
    [InlineData("classic-ascent", 2)]
    [InlineData("relay-ridge", 3)]
    [InlineData("crane-shift", 4)]
    [InlineData("windworks", 2)]
    public async Task Real_websocket_match_authenticates_roster_and_emits_managed_snapshots(string map, int count)
    {
        await using var factory = new WebApplicationFactory<Program>();
        var matches = factory.Services.GetRequiredService<ManagedMatches>();
        var room = FullRoom(count, map);
        var created = await matches.CreateMatchAsync(room, CancellationToken.None);
        var sockets = new List<WebSocket>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        try
        {
            foreach (var launch in created.Launches)
            {
                var socket = await factory.Server.CreateWebSocketClient().ConnectAsync(new Uri("ws://localhost/gameplay"), timeout.Token);
                sockets.Add(socket);
                await Send(socket, new JoinMatchMessage("join", created.MatchId, launch.Ticket), timeout.Token);
                var welcome = JsonSerializer.Deserialize<WelcomeMessage>(await Read(socket, timeout.Token), Wire.Json)!;
                Assert.Equal(launch.Color, welcome.Player);
                Assert.Equal(count, welcome.Players.Length);
                Assert.Equal(map, welcome.MapId);
                Assert.Equal(2, welcome.ProtocolVersion);
            }
            await Send(sockets[0], new ClientInput("input", 1, 0, 1, 0, false), timeout.Token);
            using var snapshot = await NextSnapshot(sockets[0], timeout.Token);
            Assert.Equal(count, snapshot.RootElement.GetProperty("players").GetArrayLength());
            Assert.True(snapshot.RootElement.GetProperty("tick").GetInt64() > 0);
            Assert.True(snapshot.RootElement.GetProperty("obstacles").GetArrayLength() > 0);
            Assert.Equal(1, snapshot.RootElement.GetProperty("players")[0].GetProperty("acknowledgedInput").GetInt64());

            // The redeemed ticket cannot open a second connection.
            using var duplicate = await factory.Server.CreateWebSocketClient().ConnectAsync(new Uri("ws://localhost/gameplay"), timeout.Token);
            await Send(duplicate, new JoinMatchMessage("join", created.MatchId, created.Launches[0].Ticket), timeout.Token);
            var closed = await duplicate.ReceiveAsync(new ArraySegment<byte>(new byte[2048]), timeout.Token);
            Assert.Equal(WebSocketMessageType.Close, closed.MessageType);
        }
        finally
        {
            foreach (var socket in sockets) { socket.Abort(); socket.Dispose(); }
            await matches.DestroyMatchAsync(created.MatchId, CancellationToken.None);
        }
    }

    [Fact]
    public async Task Capacity_and_destroy_bound_match_resources()
    {
        using var matches = new ManagedMatches(Options.Create(new MatchOptions { MaxMatches = 1 }), NullLogger<ManagedMatches>.Instance);
        var created = await matches.CreateMatchAsync(FullRoom(2), CancellationToken.None);
        Assert.True(matches.Contains(created.MatchId));
        Assert.Null(matches.Launch(created.MatchId, Guid.NewGuid()));
        await Assert.ThrowsAsync<SimulationUnavailableException>(() => matches.CreateMatchAsync(FullRoom(2), CancellationToken.None));
        await matches.DestroyMatchAsync(created.MatchId, CancellationToken.None);
        Assert.False(matches.Contains(created.MatchId));
        Assert.Null(matches.Launch(created.MatchId, created.Launches[0].PlayerId));
    }

    [Theory]
    [InlineData("{\"type\":\"input\",\"sequence\":1,\"clientTick\":0,\"moveX\":0,\"moveZ\":0,\"jump\":false,\"position\":{}}")]
    [InlineData("{\"type\":\"input\"}")]
    public void Protocol_rejects_extra_or_missing_fields(string json) =>
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ClientInput>(json, Wire.Json));

    [Fact]
    public void Input_validation_rejects_nonfinite_out_of_range_and_replayed_counters()
    {
        var valid = new ClientInput("input", 1, 0, 1, -1, false);
        Assert.True(valid.IsValid());
        Assert.False((valid with { MoveX = float.NaN }).IsValid());
        Assert.False((valid with { MoveZ = 2 }).IsValid());
        Assert.False((valid with { Sequence = 0 }).IsValid());
        Assert.False((valid with { Type = "snapshot" }).IsValid());
    }

    private static Room FullRoom(int count, string map = "classic-ascent")
    {
        var room = Room.Create("XK72", count, Guid.NewGuid(), new string('a', 64), DateTimeOffset.UtcNow);
        for (int index = 1; index < count; index++) room.Join(Guid.NewGuid(), new string('b', 64), DateTimeOffset.UtcNow);
        room.SetMap(new string('a', 64), map);
        return room;
    }

    private static Task Send<T>(WebSocket socket, T message, CancellationToken token) =>
        socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Wire.Json), WebSocketMessageType.Text, true, token);

    private static async Task<byte[]> Read(WebSocket socket, CancellationToken token)
    {
        using var buffer = new MemoryStream();
        var part = new byte[65536];
        while (true)
        {
            var read = await socket.ReceiveAsync(new ArraySegment<byte>(part), token);
            Assert.Equal(WebSocketMessageType.Text, read.MessageType);
            buffer.Write(part, 0, read.Count);
            if (read.EndOfMessage) return buffer.ToArray();
        }
    }

    private static async Task<JsonDocument> NextSnapshot(WebSocket socket, CancellationToken token)
    {
        while (true)
        {
            var message = JsonDocument.Parse(await Read(socket, token));
            if (message.RootElement.GetProperty("type").GetString() == "snapshot") return message;
            message.Dispose();
        }
    }
}
