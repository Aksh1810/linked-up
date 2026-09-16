using LinkedUp.Contracts;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LinkedUp.Client;

public sealed class ClientSettings
{
    public bool ReducedMotion { get; set; }
    public string CameraSensitivity { get; set; } = "medium";
    public bool InvertY { get; set; }
    [JsonIgnore] public CameraSettings Camera
    {
        get
        {
            var sensitivity = CameraSensitivity switch { "low" => 1600, "high" => 650, _ => 1000 };
            return new(sensitivity, InvertY ? -sensitivity : sensitivity, ReducedMotion);
        }
    }
    public static ClientSettings Read(string? json)
    {
        try
        {
            var settings = JsonSerializer.Deserialize<ClientSettings>(json ?? "null", new JsonSerializerOptions(JsonSerializerDefaults.Web));
            return settings?.CameraSensitivity is "low" or "medium" or "high" ? settings : new();
        }
        catch (JsonException) { return new(); }
    }
}
public sealed record CameraSettings(int AngularSensibilityX, int AngularSensibilityY, bool ReducedMotion);

public sealed record GameplayHud(string Route, string Tether, string Status, bool Finished, string Elapsed)
{
    public static GameplayHud From(ServerSnapshot snapshot, string mapId, string? localId = null, long? previousReset = null)
    {
        var map = mapId switch { "relay-ridge" => "Relay Ridge", "crane-shift" => "Crane Shift", "windworks" => "Windworks", _ => "Classic Ascent" };
        string[] zones = ["Grass", "Construction", "Industrial", "Sky", "Summit"];
        var tension = snapshot.TetherTension >= .85f ? "Taut" : snapshot.TetherTension >= .5f ? "Stretched" : "Linked";
        var finished = snapshot.MatchState == "finished";
        var hanging = snapshot.Players.FirstOrDefault(player => player.Id != localId && !player.Grounded);
        var status = finished ? "Summit reached" : hanging is not null
            ? $"{char.ToUpperInvariant(hanging.Id[0])}{hanging.Id[1..]} is hanging — hold Space to climb"
            : snapshot.ResetCount > previousReset ? $"Checkpoint {snapshot.Checkpoint} restored" : "Climb together";
        return new($"{map} · {zones[Math.Clamp(snapshot.Checkpoint, 0, 4)]} · Checkpoint {snapshot.Checkpoint}",
            $"{tension} tether", status, finished,
            TimeSpan.FromSeconds(snapshot.ElapsedTicks / 60).ToString(@"mm\:ss"));
    }
}
