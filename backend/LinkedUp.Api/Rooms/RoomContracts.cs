namespace LinkedUp.Api.Rooms;

public static class PublicRooms
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
