using System.Text.Json;
using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameplayProtocolTests
{
    private const string Greeting = """
        {"type":"welcome","protocolVersion":2,"player":"blue","players":["blue","orange"],"mapId":"relay-ridge","tickRate":60,"snapshotRate":20}
        """;

    [Fact]
    public void Parses_shared_wire_contracts_and_rejects_wrong_protocol_and_roster()
    {
        var welcome = Assert.IsType<WelcomeMessage>(GameplayProtocol.Parse(Greeting));
        Assert.Equal("relay-ridge", welcome.MapId);
        var snapshot = new ServerSnapshot(3, 0, .9f,
            [new("blue", 1, new(0, 1, 0), default, true), new("orange", 1, new(2, 1, 0), default, true)],
            "running", 3, 0, [new("platform", "staticPlatform", "grass", "armed", new(1, 1, 1), default, default)]);
        var json = JsonSerializer.Serialize(snapshot, Wire.Json);
        var parsed = Assert.IsType<ServerSnapshot>(GameplayProtocol.Parse(json, welcome));
        Assert.Equal(.9f, parsed.TetherTension);
        Assert.Equal(2, parsed.Players.Length);
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(Greeting.Replace("\"protocolVersion\":2", "\"protocolVersion\":1")));
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(json.Replace("orange", "green"), welcome));
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(json.Replace("staticPlatform", "teleporter"), welcome));
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(json.Replace("\"halfExtent\":{\"x\":1", "\"halfExtent\":{\"x\":-1"), welcome));
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(json));
    }

    [Theory]
    [InlineData("{\"type\":\"snapshot\"}")]
    [InlineData("{\"type\":\"countdown\",\"seconds\":-1}")]
    [InlineData("{\"type\":\"countdown\",\"seconds\":3,\"unexpected\":true}")]
    [InlineData("null")]
    [InlineData("[]")]
    public void Malformed_messages_are_rejected(string json) =>
        Assert.Throws<InvalidDataException>(() => GameplayProtocol.Parse(json));
}
