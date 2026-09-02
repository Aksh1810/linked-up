namespace LinkedUp.Api.Rooms;

public sealed class RoomOptions
{
    public string Redis { get; init; } = "127.0.0.1:6379";
    public string KeyPrefix { get; init; } = "linked-up:room:";
    public int RoomTtlMinutes { get; init; } = 120;
    public string ClientOrigin { get; init; } = "http://127.0.0.1:5173";
}

public sealed record RoomSession(Room Room, RoomPlayer Player, string Token);
