using LinkedUp.Contracts;
using System.Text.Json;

namespace LinkedUp.Client;

public static class GameplayProtocol
{
    public static object Parse(string json, WelcomeMessage? welcome = null)
    {
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            var value = document.RootElement;
            switch (value.GetProperty("type").GetString())
            {
                case "welcome":
                    var greeting = value.Deserialize<WelcomeMessage>(Wire.Json)!;
                    if (value.GetProperty("protocolVersion").GetInt32() != 2
                        || value.GetProperty("tickRate").GetInt32() != 60 || value.GetProperty("snapshotRate").GetInt32() != 20
                        || greeting.Players is not { Length: >= 2 and <= 4 }
                        || !greeting.Players.All(Color) || greeting.Players.Distinct().Count() != greeting.Players.Length
                        || !greeting.Players.Contains(greeting.Player)
                        || greeting.MapId is not ("classic-ascent" or "relay-ridge" or "crane-shift" or "windworks")) break;
                    return greeting;
                case "snapshot":
                    var snapshot = value.Deserialize<ServerSnapshot>(Wire.Json)!;
                    if (welcome is null || !Count(snapshot.Tick) || !Count(snapshot.ResetCount) || !Count(snapshot.ElapsedTicks)
                        || snapshot.Checkpoint is < 0 or > 4 || !float.IsFinite(snapshot.TetherTension)
                        || snapshot.TetherTension is < 0 or > 1 || snapshot.MatchState is not ("running" or "finished")
                        || snapshot.Players is null || snapshot.Players.Any(p => p is null)
                        || !snapshot.Players.Select(p => p.Id).SequenceEqual(welcome.Players)
                        || snapshot.Players.Any(p => !Count(p.AcknowledgedInput) || !Finite(p.Position) || !Finite(p.Velocity))
                        || snapshot.Obstacles is null || snapshot.Obstacles.Length > 256
                        || snapshot.Obstacles.Any(o => o is null || string.IsNullOrEmpty(o.Id) || o.Id.Length > 128
                            || o.Kind is not ("staticPlatform" or "movingPlatform" or "rotatingBeam" or "swingingBeam" or "fan" or "conveyor" or "fallingPlatform")
                            || o.Zone is not ("grass" or "construction" or "industrial" or "sky" or "summit")
                            || o.Phase is not ("armed" or "warning" or "falling")
                            || !Finite(o.HalfExtent) || o.HalfExtent.X <= 0 || o.HalfExtent.Y <= 0 || o.HalfExtent.Z <= 0
                            || !Finite(o.Position) || !Finite(o.Rotation))
                        || snapshot.Obstacles.Select(o => o.Id).Distinct().Count() != snapshot.Obstacles.Length) break;
                    return snapshot;
                case "countdown":
                    var countdown = value.Deserialize<CountdownMessage>(Wire.Json)!;
                    if (countdown.Seconds is >= 0 and <= 3) return countdown;
                    break;
                case "error":
                    var error = value.Deserialize<GameError>(Wire.Json)!;
                    if (error.Code is not null && error.Message is not null) return error;
                    break;
            }
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        {
            throw new InvalidDataException("Invalid gameplay message.", error);
        }
        throw new InvalidDataException("Invalid gameplay message.");
    }

    private static bool Color(string color) => color is "blue" or "orange" or "green" or "purple";
    private static bool Count(long value) => value is >= 0 and <= 9_007_199_254_740_991;
    private static bool Finite(VectorState vector) => float.IsFinite(vector.X) && float.IsFinite(vector.Y) && float.IsFinite(vector.Z);
}
