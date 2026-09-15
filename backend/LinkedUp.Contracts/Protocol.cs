using System.Text.Json;
using System.Text.Json.Serialization;

namespace LinkedUp.Contracts;

public sealed record PublicPlayer(Guid Id, string Name, string Color, bool IsHost);
public sealed record PublicRoom(Guid Id, string Code, int Capacity, string Status,
    DateTimeOffset CreatedAt, long Version, Guid? MatchId, string MapId, IReadOnlyList<PublicPlayer> Players);
public sealed record PlayerSession(Guid PlayerId, string Token);
public sealed record RoomSessionResponse(PublicRoom Room, PlayerSession Session);
public sealed record CreateRoomRequest(int Capacity);
public sealed record SetRoomMapRequest(string MapId);
public sealed record MatchLaunch(Guid MatchId, string GameplayUrl, int CountdownSeconds,
    DateTimeOffset ExpiresAt, Guid PlayerId, string Color, string Ticket);

public readonly record struct VectorState(float X, float Y, float Z);
public sealed record NetworkPlayer(string Id, long AcknowledgedInput, VectorState Position,
    VectorState Velocity, bool Grounded);
public sealed record NetworkObstacle(string Id, string Kind, string Zone, string Phase,
    VectorState HalfExtent, VectorState Position, VectorState Rotation);
public sealed record WelcomeMessage(string Player, string[] Players, string MapId)
{
    public string Type => "welcome";
    public int ProtocolVersion => 2;
    public int TickRate => 60;
    public int SnapshotRate => 20;
}
public sealed record ServerSnapshot(long Tick, long ResetCount, float TetherTension,
    NetworkPlayer[] Players, string MatchState, long ElapsedTicks, int Checkpoint, NetworkObstacle[] Obstacles)
{
    public string Type => "snapshot";
}
public sealed record GameError(string Code, string Message)
{
    public string Type => "error";
}
public sealed record CountdownMessage(int Seconds)
{
    public string Type => "countdown";
}
public sealed record JoinMatchMessage(string Type, Guid MatchId, string Ticket);
public sealed record ClientInput(string Type, long Sequence, long ClientTick, float MoveX, float MoveZ, bool Jump)
{
    public bool IsValid() => Type == "input" && Sequence > 0 && Sequence <= 9_007_199_254_740_991
        && ClientTick >= 0 && ClientTick <= 9_007_199_254_740_991
        && float.IsFinite(MoveX) && float.IsFinite(MoveZ)
        && Math.Abs(MoveX) <= 1 && Math.Abs(MoveZ) <= 1;
}

public static class Wire
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 16
    };
    public static string Color(int color) => color switch
    {
        0 => "blue", 1 => "orange", 2 => "green", 3 => "purple",
        _ => throw new ArgumentOutOfRangeException(nameof(color))
    };
}
