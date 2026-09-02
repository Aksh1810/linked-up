using LinkedUp.Api.Matches;
using Microsoft.AspNetCore.SignalR;

namespace LinkedUp.Api.Rooms;

public interface ILobbyClient
{
    Task RoomUpdated(PublicRoom room);
    Task MatchReady(MatchLaunch launch);
}

public sealed class LobbyHub(
    RedisRoomStore rooms,
    RoomPresence presence,
    ILogger<LobbyHub> logger) : Hub<ILobbyClient>
{
    public Task<PublicRoom> Subscribe(string roomCode, string sessionToken) =>
        presence.AddAsync(
            Context.ConnectionId,
            async () =>
            {
                var (room, player) = await rooms.ResolveSessionAsync(
                    roomCode, sessionToken, Context.ConnectionAborted);
                return (room.Code, player.Id, PublicRoom.From(room));
            },
            canonicalCode => Groups.AddToGroupAsync(
                Context.ConnectionId, canonicalCode, Context.ConnectionAborted),
            Context.ConnectionAborted);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        try
        {
            var removal = await presence.RemoveAsync(
                Context.ConnectionId,
                (roomCode, playerId) => rooms.RemovePlayerAsync(
                    roomCode, playerId, CancellationToken.None));
            if (removal is { IsLast: true, Result: not null })
            {
                await Clients.Group(removal.Result.Code)
                    .RoomUpdated(PublicRoom.From(removal.Result));
            }
        }
        catch (RoomException error) when (error.Error == RoomError.NotFound)
        {
            logger.LogDebug(
                "Room was already gone when connection {ConnectionId} disconnected",
                Context.ConnectionId);
        }
        finally
        {
            await base.OnDisconnectedAsync(exception);
        }
    }
}
