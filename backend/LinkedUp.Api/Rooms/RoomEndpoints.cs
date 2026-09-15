using LinkedUp.Api.Matches;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Primitives;
using StackExchange.Redis;

namespace LinkedUp.Api.Rooms;

public static class RoomEndpoints
{
    public static IEndpointRouteBuilder MapRoomEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var rooms = endpoints.MapGroup("/api/rooms")
            .AddEndpointFilter<RoomProblemFilter>()
            .RequireRateLimiting("rooms");

        rooms.MapPost("", CreateAsync);
        rooms.MapGet("/{code}", GetAsync);
        rooms.MapPost("/{code}/join", JoinAsync);
        rooms.MapPost("/{code}/leave", LeaveAsync);
        rooms.MapPost("/{code}/map", SetMapAsync);
        rooms.MapPost("/{code}/start", StartAsync);
        rooms.MapPost("/{code}/launch", LaunchAsync);
        return endpoints;
    }

    private static async Task<IResult> LaunchAsync(string code, HttpRequest request,
        RedisRoomStore store, ManagedMatches matches, CancellationToken token)
    {
        var (room, player) = await store.ResolveSessionAsync(code, RequireToken(request), token);
        var launch = room.MatchId is { } id ? matches.Launch(id, player.Id) : null;
        return launch is null
            ? Results.Problem(statusCode: 410, title: "Match ended", detail: "This match has ended. Create a new room to play again.")
            : Results.Ok(launch);
    }

    private static async Task<IResult> CreateAsync(
        CreateRoomRequest request,
        RedisRoomStore store,
        ILoggerFactory loggerFactory,
        CancellationToken token)
    {
        var session = await store.CreateAsync(request.Capacity, token);
        loggerFactory.CreateLogger("LinkedUp.RoomLifecycle").LogInformation(
            "Room {RoomCode} created with capacity {Capacity} by host {HostPlayerId}",
            session.Room.Code, session.Room.Capacity, session.Player.Id);
        return TypedResults.Created(
            $"/api/rooms/{session.Room.Code}", ToResponse(session));
    }

    private static async Task<IResult> GetAsync(
        string code, RedisRoomStore store, CancellationToken token)
    {
        var room = await store.GetAsync(code, token)
            ?? throw new RoomException(RoomError.NotFound, "The room was not found.");
        return TypedResults.Ok(PublicRooms.From(room));
    }

    private static async Task<IResult> JoinAsync(
        string code,
        RedisRoomStore store,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        ILoggerFactory loggerFactory,
        CancellationToken token)
    {
        var session = await store.JoinAsync(code, token);
        loggerFactory.CreateLogger("LinkedUp.RoomLifecycle").LogInformation(
            "Player {PlayerId} joined room {RoomCode}; player count is {PlayerCount}",
            session.Player.Id, session.Room.Code, session.Room.Players.Count);
        await lobby.Clients.Group(session.Room.Code)
            .RoomUpdated(PublicRooms.From(session.Room));
        return TypedResults.Ok(ToResponse(session));
    }

    private static async Task<IResult> LeaveAsync(
        string code,
        HttpRequest request,
        RedisRoomStore store,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        ILoggerFactory loggerFactory,
        CancellationToken token)
    {
        var rawToken = RequireToken(request);
        var (room, player) = await store.ResolveSessionAsync(code, rawToken, token);
        var wasHost = player.Id == room.HostPlayerId;
        var remaining = await store.LeaveAsync(code, rawToken, token);
        var logger = loggerFactory.CreateLogger("LinkedUp.RoomLifecycle");
        logger.LogInformation(
            "Player {PlayerId} left room {RoomCode}", player.Id, room.Code);
        if (wasHost && remaining is not null)
        {
            logger.LogInformation(
                "Host migrated in room {RoomCode} from {PreviousHostPlayerId} to {HostPlayerId}",
                room.Code, player.Id, remaining.HostPlayerId);
        }

        if (remaining is not null)
        {
            await lobby.Clients.Group(remaining.Code)
                .RoomUpdated(PublicRooms.From(remaining));
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> StartAsync(
        string code,
        HttpRequest request,
        RedisRoomStore store,
        RoomPresence presence,
        ISimulationMatchClient simulation,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        ILoggerFactory loggerFactory,
        CancellationToken token)
    {
        var logger = loggerFactory.CreateLogger("LinkedUp.RoomLifecycle");
        logger.LogInformation(
            "Start requested for room {RoomCode}", code);
        var starting = await store.StartAsync(code, RequireToken(request), token);
        if (!await presence.AllPlayersConnected(
                starting.Code, starting.Players.Select(player => player.Id).ToArray(), token))
        {
            await RollbackAndBroadcastAsync(starting, store, lobby, token);
            throw new RoomException(RoomError.PlayersNotPresent,
                "Every player must be connected before starting.");
        }

        CreatedMatch created;
        try
        {
            created = await simulation.CreateMatchAsync(starting, token);
        }
        catch (Exception error) when (error is SimulationUnavailableException or OperationCanceledException)
        {
            await RollbackAndBroadcastAsync(starting, store, lobby, CancellationToken.None);
            throw;
        }

        Room? inGame;
        try
        {
            inGame = await store.CompleteStartAsync(
                starting, created.MatchId, CancellationToken.None);
        }
        catch (RoomException)
        {
            await CancelAfterFinalizationFailureAsync(
                starting, created.MatchId, store, simulation, lobby, logger);
            throw new RoomException(RoomError.MatchStartCancelled, "The room start changed.");
        }
        catch
        {
            await CancelAfterFinalizationFailureAsync(
                starting, created.MatchId, store, simulation, lobby, logger);
            throw;
        }
        if (inGame is null)
        {
            await CancelAfterFinalizationFailureAsync(
                starting, created.MatchId, store, simulation, lobby, logger);
            throw new RoomException(RoomError.MatchStartCancelled, "The room start changed.");
        }

        var publicRoom = PublicRooms.From(inGame);
        await lobby.Clients.Group(inGame.Code).RoomUpdated(publicRoom);
        foreach (var launch in created.Launches)
        {
            await lobby.Clients.Clients(await presence.ConnectionIds(
                    inGame.Code, launch.PlayerId, CancellationToken.None))
                .MatchReady(launch);
        }

        return TypedResults.Ok(publicRoom);
    }

    private static async Task<IResult> SetMapAsync(
        string code,
        SetRoomMapRequest request,
        HttpRequest httpRequest,
        RedisRoomStore store,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        ILoggerFactory loggerFactory,
        CancellationToken token)
    {
        var room = await store.SetMapAsync(
            code, RequireToken(httpRequest), request.MapId, token);
        loggerFactory.CreateLogger("LinkedUp.RoomLifecycle").LogInformation(
            "Map {MapId} selected for room {RoomCode}", room.MapId, room.Code);
        var publicRoom = PublicRooms.From(room);
        await lobby.Clients.Group(room.Code).RoomUpdated(publicRoom);
        return TypedResults.Ok(publicRoom);
    }

    private static async Task RollbackAndBroadcastAsync(
        Room starting,
        RedisRoomStore store,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        CancellationToken token)
    {
        var waiting = await store.RollbackStartAsync(starting, token);
        if (waiting is not null)
        {
            await lobby.Clients.Group(waiting.Code).RoomUpdated(PublicRooms.From(waiting));
        }
    }

    private static async Task CancelAfterFinalizationFailureAsync(
        Room starting,
        Guid matchId,
        RedisRoomStore store,
        ISimulationMatchClient simulation,
        IHubContext<LobbyHub, ILobbyClient> lobby,
        ILogger logger)
    {
        await DestroyBestEffortAsync(simulation, matchId, starting.Id, logger);
        try
        {
            await RollbackAndBroadcastAsync(starting, store, lobby, CancellationToken.None);
        }
        catch (RoomException exception) when (exception.Error == RoomError.NotFound)
        {
            logger.LogDebug("Room {RoomId} was gone while rolling back a cancelled start", starting.Id);
        }
    }

    private static async Task DestroyBestEffortAsync(
        ISimulationMatchClient simulation,
        Guid matchId,
        Guid roomId,
        ILogger logger)
    {
        try
        {
            await simulation.DestroyMatchAsync(matchId, CancellationToken.None);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception,
                "Failed to destroy simulation match {MatchId} for room {RoomId}", matchId, roomId);
        }
    }

    private static RoomSessionResponse ToResponse(RoomSession session) => new(
        PublicRooms.From(session.Room),
        new PlayerSession(session.Player.Id, session.Token));

    private static string RequireToken(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("X-Player-Token", out var token)
            || StringValues.IsNullOrEmpty(token)
            || token.Count != 1)
        {
            throw new RoomException(
                RoomError.InvalidSession, "The room session is invalid.");
        }

        return token.ToString();
    }
}

internal sealed class RoomProblemFilter(ILogger<RoomProblemFilter> logger) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        try
        {
            return await next(context);
        }
        catch (RoomException exception)
        {
            var (status, title) = exception.Error switch
            {
                RoomError.InvalidCapacity or RoomError.InvalidCode or RoomError.InvalidMap =>
                    (StatusCodes.Status400BadRequest, "Invalid room request"),
                RoomError.InvalidSession =>
                    (StatusCodes.Status401Unauthorized, "Invalid room session"),
                RoomError.NotHost =>
                    (StatusCodes.Status403Forbidden, "Host required"),
                RoomError.NotFound =>
                    (StatusCodes.Status404NotFound, "Room not found"),
                RoomError.Full =>
                    (StatusCodes.Status409Conflict, "Room full"),
                RoomError.AlreadyStarting =>
                    (StatusCodes.Status409Conflict, "Room already starting"),
                RoomError.AlreadyInGame =>
                    (StatusCodes.Status409Conflict, "Room already in a match"),
                RoomError.NotEnoughPlayers =>
                    (StatusCodes.Status409Conflict, "Room not full"),
                RoomError.PlayersNotPresent =>
                    (StatusCodes.Status409Conflict, "Players not present"),
                RoomError.MatchStartCancelled =>
                    (StatusCodes.Status409Conflict, "Room start cancelled"),
                RoomError.Contention =>
                    (StatusCodes.Status409Conflict, "Room update conflict"),
                _ => throw new InvalidOperationException(
                    $"Unsupported room error: {exception.Error}")
            };
            return Results.Problem(
                statusCode: status, title: title, detail: exception.Message);
        }
        catch (RedisConnectionException exception)
        {
            return RedisUnavailable(exception);
        }
        catch (RedisTimeoutException exception)
        {
            return RedisUnavailable(exception);
        }
        catch (SimulationUnavailableException exception)
        {
            logger.LogWarning(exception, "Simulation unavailable while starting a room");
            return Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Simulation unavailable",
                detail: "The simulation is temporarily unavailable.");
        }
    }

    private IResult RedisUnavailable(Exception exception)
    {
        logger.LogError(exception, "Redis unavailable while handling a room request");
        return Results.Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Room service unavailable",
            detail: "The room service is temporarily unavailable.");
    }
}

internal sealed class RedisReadinessCheck(IConnectionMultiplexer redis) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default) =>
        Task.FromResult(redis.IsConnected
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy("Redis is unavailable."));
}
