using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using LinkedUp.Api.Rooms;
using LinkedUp.Client;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;

namespace LinkedUp.Api.Tests;

public sealed class LobbyHubTests : IAsyncLifetime
{
    private readonly string _prefix = $"linked-up:test:{Guid.NewGuid():N}:room:";
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public LobbyHubTests()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder
            .UseSetting("LinkedUp:Redis", "127.0.0.1:6379,defaultDatabase=15")
            .UseSetting("LinkedUp:KeyPrefix", _prefix));
        _client = _factory.CreateClient();
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        var redis = _factory.Services.GetRequiredService<IConnectionMultiplexer>();
        var database = redis.GetDatabase(15);
        foreach (var endpoint in redis.GetEndPoints())
        {
            var keys = redis.GetServer(endpoint).Keys(15, $"{_prefix}*").ToArray();
            if (keys.Length > 0)
            {
                await database.KeyDeleteAsync(keys);
            }
        }

        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Two_browser_sessions_can_start_and_both_receive_gameplay()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var token = timeout.Token;
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        using var host = new GameSession(_client, hostHub);
        using var guest = new GameSession(_client, guestHub);
        var hostUpdates = Channel.CreateUnbounded<PublicRoom>();
        var guestUpdates = Channel.CreateUnbounded<PublicRoom>();
        var guestClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.RoomChanged += () => { if (host.Room is { } room) hostUpdates.Writer.TryWrite(room); };
        guest.RoomChanged += () => { if (guest.Room is { } room) guestUpdates.Writer.TryWrite(room); else guestClosed.TrySetResult(); };
        await host.CreateAsync(2, token);
        await guest.JoinAsync(host.Room!.Code, token);
        await WaitForRoomAsync(hostUpdates, room => room.Players.Count == 2, token);
        Assert.Equal(2, host.Room.Players.Count);

        // Closing and reopening a tab must remove the old presence and register the new player.
        await guestHub.StopAsync(token);
        await WaitForRoomAsync(hostUpdates, room => room.Players.Count == 1, token);
        await guestClosed.Task.WaitAsync(token);
        Assert.Null(guest.Session);
        await guest.JoinAsync(host.Room.Code, token);
        await WaitForRoomAsync(hostUpdates, room => room.Players.Count == 2, token);

        await host.StartAsync(token);
        await WaitForRoomAsync(guestUpdates, room => room.Status == "inGame", token);
        Assert.Equal("inGame", host.Room.Status);
        Assert.Equal(host.Room.MatchId, guest.Room!.MatchId);

        await using var hostGameplay = new GameplayClient(await _factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri("ws://localhost/gameplay"), token));
        await using var guestGameplay = new GameplayClient(await _factory.Server.CreateWebSocketClient()
            .ConnectAsync(new Uri("ws://localhost/gameplay"), token));
        var received = new List<Task<ServerSnapshot>>();
        foreach (var (game, gameplay) in new[] { (host, hostGameplay), (guest, guestGameplay) })
        {
            var snapshot = new TaskCompletionSource<ServerSnapshot>(TaskCreationOptions.RunContinuationsAsynchronously);
            gameplay.SnapshotChanged += value => snapshot.TrySetResult(value);
            received.Add(snapshot.Task.WaitAsync(token));
            var launch = await game.LaunchAsync(token);
            await gameplay.JoinAsync(launch, token);
            Assert.Equal(launch.Color, gameplay.Welcome!.Player);
        }
        foreach (var pending in received)
        {
            var snapshot = await pending;
            Assert.Equal(2, snapshot.Players.Length);
            Assert.True(snapshot.Tick > 0);
        }
        var initial = hostGameplay.Snapshot!;
        hostGameplay.Input.Key("KeyW", true);
        guestGameplay.Input.Key("KeyW", true);
        var now = 0d;
        while (hostGameplay.Snapshot!.Players.Any(player =>
            player.Position.Z <= initial.Players.Single(start => start.Id == player.Id).Position.Z + .25f))
        {
            await hostGameplay.FrameAsync(now, -Math.PI / 2);
            await guestGameplay.FrameAsync(now, -Math.PI / 2);
            now += 20;
            await Task.Delay(20, token);
        }
        Assert.All(hostGameplay.Snapshot.Players, player => Assert.True(player.AcknowledgedInput > 0));
        await hostGameplay.DisposeAsync();
        await guestGameplay.DisposeAsync();
        await host.LeaveAsync(token);
        Assert.Null(host.Session);
        await host.CreateAsync(2, token);
        Assert.Equal("waiting", host.Room!.Status);
        Assert.Single(host.Room.Players);
    }

    private static async Task WaitForRoomAsync(Channel<PublicRoom> updates, Func<PublicRoom, bool> matches, CancellationToken token)
    {
        while (!matches(await updates.Reader.ReadAsync(token))) { }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Delayed_room_reads_cannot_undo_start_or_replace_a_new_session(bool changeRoom)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var token = timeout.Token;
        using var delayed = new DelayedRoomRead(_factory.Server.CreateHandler());
        using var http = new HttpClient(delayed) { BaseAddress = _client.BaseAddress };
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        using var host = new GameSession(http, hostHub);
        using var guest = new GameSession(_client, guestHub);
        await host.CreateAsync(2, token);
        var refresh = host.RefreshAsync(token);
        await delayed.Captured.Task.WaitAsync(token);
        await guest.JoinAsync(host.Room!.Code, token);
        await host.StartAsync(token);
        if (changeRoom) { await host.LeaveAsync(token); await host.CreateAsync(2, token); }
        var expected = host.Session;
        delayed.Release.SetResult();
        await refresh;
        Assert.Equal(expected!.Room.Id, host.Room!.Id);
        Assert.Equal(expected.Room.Version, host.Room.Version);
        Assert.Equal(expected.Room.Status, host.Room.Status);
    }

    private sealed class DelayedRoomRead(HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        public TaskCompletionSource Captured { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var response = await base.SendAsync(request, token);
            if (request.Method == HttpMethod.Get)
            {
                // Capture the old body before a later live update or session change arrives.
                await response.Content.LoadIntoBufferAsync(token);
                Captured.TrySetResult();
                await Release.Task.WaitAsync(token);
            }
            return response;
        }
    }

    [Fact]
    public async Task Subscribed_clients_receive_join_snapshots()
    {
        var host = await CreateRoomAsync(2);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var connection = BuildHubConnection(updates);
        await connection.StartAsync();

        var initial = await connection.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code.ToLowerInvariant(), host.Session.Token);

        Assert.Single(initial.Players);
        await JoinRoomAsync(host.Room.Code);
        Assert.Equal(2, (await ReadUpdateAsync(updates)).Players.Count);
    }

    [Fact]
    public async Task Invalid_tokens_cannot_subscribe()
    {
        var host = await CreateRoomAsync(2);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var connection = BuildHubConnection(updates);
        await connection.StartAsync();

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, "wrong"));
        await JoinRoomAsync(host.Room.Code);
        Assert.False(await HasUpdateAsync(updates));
    }

    [Fact]
    public async Task Subscribe_waits_for_disconnect_cleanup_before_revalidating()
    {
        var presence = new RoomPresence();
        var playerId = Guid.NewGuid();
        await presence.AddAsync(
            "old",
            () => Task.FromResult(("XK72", playerId, true)),
            _ => Task.CompletedTask);
        var cleanupStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var allowCleanup = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var playerExists = true;
        var disconnect = presence.RemoveAsync("old", async (_, _) =>
        {
            cleanupStarted.SetResult();
            await allowCleanup.Task;
            playerExists = false;
            return true;
        });
        await cleanupStarted.Task;
        var validationStarted = false;

        var subscribe = presence.AddAsync(
            "new",
            () =>
            {
                validationStarted = true;
                return playerExists
                    ? Task.FromResult(("XK72", playerId, true))
                    : Task.FromException<(string, Guid, bool)>(new RoomException(
                        RoomError.NotFound, "The room was not found."));
            },
            _ => Task.CompletedTask);

        Assert.False(validationStarted);
        allowCleanup.SetResult();
        Assert.True((await disconnect).IsLast);
        await Assert.ThrowsAsync<RoomException>(() => subscribe);
    }

    [Fact]
    public async Task Resubscribe_to_a_different_player_preserves_original_cleanup()
    {
        var original = await CreateRoomAsync(2);
        var other = await CreateRoomAsync(2);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var connection = BuildHubConnection(updates);
        await connection.StartAsync();
        await connection.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), original.Room.Code, original.Session.Token);

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), other.Room.Code, other.Session.Token));
        await JoinRoomAsync(other.Room.Code);
        Assert.False(await HasUpdateAsync(updates));
        await connection.StopAsync();

        await WaitForStatusAsync(
            $"/api/rooms/{original.Room.Code}", System.Net.HttpStatusCode.NotFound);
        Assert.Equal(2,
            (await _client.GetFromJsonAsync<PublicRoom>(
                $"/api/rooms/{other.Room.Code}"))!.Players.Count);
    }

    [Fact]
    public async Task Host_leave_broadcasts_the_migrated_host()
    {
        var host = await CreateRoomAsync(2);
        var joined = await JoinRoomAsync(host.Room.Code);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var connection = BuildHubConnection(updates);
        await connection.StartAsync();
        await connection.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);

        using var request = WithToken(
            HttpMethod.Post, $"/api/rooms/{host.Room.Code}/leave", host.Session.Token);
        var response = await _client.SendAsync(request);

        response.EnsureSuccessStatusCode();
        var update = await ReadUpdateAsync(updates);
        Assert.Equal(joined.Session.PlayerId, Assert.Single(update.Players).Id);
        Assert.True(update.Players[0].IsHost);
    }

    [Fact]
    public async Task Closing_one_of_two_connections_keeps_the_player()
    {
        var host = await CreateRoomAsync(2);
        var joined = await JoinRoomAsync(host.Room.Code);
        await using var first = BuildHubConnection();
        await using var second = BuildHubConnection();
        await first.StartAsync();
        await second.StartAsync();
        await first.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);
        await second.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);

        await first.StopAsync();

        var room = await _client.GetFromJsonAsync<PublicRoom>($"/api/rooms/{host.Room.Code}");
        Assert.Contains(room!.Players, player => player.Id == joined.Session.PlayerId);
    }

    [Fact]
    public async Task Closing_the_last_connection_removes_the_player_and_broadcasts()
    {
        var host = await CreateRoomAsync(2);
        var joined = await JoinRoomAsync(host.Room.Code);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var observer = BuildHubConnection(updates);
        await using var first = BuildHubConnection();
        await using var second = BuildHubConnection();
        await observer.StartAsync();
        await first.StartAsync();
        await second.StartAsync();
        await observer.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, host.Session.Token);
        await first.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);
        await second.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);

        await first.StopAsync();
        await second.StopAsync();

        var update = await ReadUpdateAsync(updates);
        Assert.Equal(host.Session.PlayerId, Assert.Single(update.Players).Id);
        var room = await _client.GetFromJsonAsync<PublicRoom>($"/api/rooms/{host.Room.Code}");
        Assert.DoesNotContain(room!.Players, player => player.Id == joined.Session.PlayerId);
    }

    [Fact]
    public async Task Disconnect_after_rest_leave_does_not_broadcast_again()
    {
        var host = await CreateRoomAsync(2);
        var joined = await JoinRoomAsync(host.Room.Code);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        await using var observer = BuildHubConnection(updates);
        await using var departing = BuildHubConnection();
        await observer.StartAsync();
        await departing.StartAsync();
        await observer.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, host.Session.Token);
        await departing.InvokeAsync<PublicRoom>(
            nameof(LobbyHub.Subscribe), host.Room.Code, joined.Session.Token);
        using var request = WithToken(
            HttpMethod.Post, $"/api/rooms/{host.Room.Code}/leave", joined.Session.Token);
        (await _client.SendAsync(request)).EnsureSuccessStatusCode();
        await ReadUpdateAsync(updates);

        await departing.StopAsync();

        Assert.False(await HasUpdateAsync(updates));
    }

    private HubConnection BuildHubConnection(Channel<PublicRoom>? updates = null)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_client.BaseAddress!, "/hubs/lobby"), options =>
            {
                options.Transports = HttpTransportType.LongPolling;
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            })
            .Build();
        if (updates is not null)
        {
            connection.On<PublicRoom>(
                "RoomUpdated", room => updates.Writer.TryWrite(room));
        }

        return connection;
    }

    private async Task<RoomSessionResponse> CreateRoomAsync(int capacity)
    {
        var response = await _client.PostAsJsonAsync("/api/rooms", new { capacity });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
    }

    private async Task<RoomSessionResponse> JoinRoomAsync(string roomCode)
    {
        var response = await _client.PostAsync($"/api/rooms/{roomCode}/join", null);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
    }

    private static async Task<PublicRoom> ReadUpdateAsync(Channel<PublicRoom> updates)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        return await updates.Reader.ReadAsync(timeout.Token);
    }

    private static async Task<bool> HasUpdateAsync(Channel<PublicRoom> updates)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        try
        {
            return await updates.Reader.WaitToReadAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task WaitForStatusAsync(string url, System.Net.HttpStatusCode expected)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!timeout.IsCancellationRequested)
        {
            using var response = await _client.GetAsync(url, timeout.Token);
            if (response.StatusCode == expected)
            {
                return;
            }

            await Task.Delay(20, timeout.Token);
        }

        throw new TimeoutException($"Room did not reach {expected} after disconnect cleanup.");
    }

    private static HttpRequestMessage WithToken(HttpMethod method, string url, string token)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("X-Player-Token", token);
        return request;
    }
}
