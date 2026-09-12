namespace LinkedUp.Api.Rooms;

public sealed record PublicPlayer(Guid Id, string Name, string Color, bool IsHost);

public sealed record PublicRoom(
    Guid Id, string Code, int Capacity, string Status, DateTimeOffset CreatedAt,
    long Version, Guid? MatchId, string MapId, IReadOnlyList<PublicPlayer> Players)
{
    public static PublicRoom From(Room room) => new(
        room.Id,
        room.Code,
        room.Capacity,
        room.Status switch
        {
            RoomStatus.Waiting => "waiting",
            RoomStatus.Starting => "starting",
            RoomStatus.InGame => "inGame",
            _ => throw new InvalidOperationException($"Unsupported room status: {room.Status}")
        },
        room.CreatedAt,
        room.Version,
        room.Status == RoomStatus.InGame ? room.MatchId : null,
        room.MapId,
        room.Players.Select(player => new PublicPlayer(
            player.Id,
            player.Name,
            player.Color.ToString().ToLowerInvariant(),
            player.Id == room.HostPlayerId)).ToArray());
}

public sealed record PlayerSession(Guid PlayerId, string Token);

public sealed record RoomSessionResponse(PublicRoom Room, PlayerSession Session);

public sealed record CreateRoomRequest(int Capacity);

public sealed record SetRoomMapRequest(string MapId);
