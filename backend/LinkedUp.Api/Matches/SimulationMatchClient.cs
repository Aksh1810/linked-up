using Grpc.Core;
using LinkedUp.Api.Rooms;
using LinkedUp.Contracts.Match.V1;
using Microsoft.Extensions.Options;

namespace LinkedUp.Api.Matches;

public interface ISimulationMatchClient
{
    Task<CreatedMatch> CreateMatchAsync(Room room, CancellationToken cancellationToken);
    Task DestroyMatchAsync(Guid matchId, CancellationToken cancellationToken);
}

public sealed class SimulationUnavailableException(string message, Exception? inner = null)
    : Exception(message, inner);

public sealed record MatchLaunch(
    Guid MatchId, string GameplayUrl, int CountdownSeconds,
    DateTimeOffset ExpiresAt, Guid PlayerId, string Color, string Ticket);

public sealed record CreatedMatch(Guid MatchId, IReadOnlyList<MatchLaunch> Launches);

public sealed class SimulationOptions
{
    public string Address { get; init; } = "http://127.0.0.1:50051";
    public int StartDeadlineSeconds { get; init; } = 5;
}

public sealed class SimulationMatchClient : ISimulationMatchClient
{
    private readonly Func<CreateMatchRequest, CancellationToken, Task<CreateMatchResponse>> _create;
    private readonly Func<DestroyMatchRequest, CancellationToken, Task> _destroy;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _deadline;
    private readonly ILogger<SimulationMatchClient> _logger;

    public SimulationMatchClient(
        MatchCoordinator.MatchCoordinatorClient client,
        IOptions<SimulationOptions> options,
        TimeProvider timeProvider,
        ILogger<SimulationMatchClient> logger)
        : this(
            (request, token) => client.CreateMatchAsync(
                request, deadline: DateTime.UtcNow.AddSeconds(options.Value.StartDeadlineSeconds),
                cancellationToken: token).ResponseAsync,
            async (request, token) => await client.DestroyMatchAsync(
                request, deadline: DateTime.UtcNow.AddSeconds(options.Value.StartDeadlineSeconds),
                cancellationToken: token).ResponseAsync,
            timeProvider,
            logger,
            TimeSpan.FromSeconds(options.Value.StartDeadlineSeconds))
    {
    }

    internal SimulationMatchClient(
        Func<CreateMatchRequest, CancellationToken, Task<CreateMatchResponse>> create,
        Func<DestroyMatchRequest, CancellationToken, Task> destroy,
        TimeProvider timeProvider,
        ILogger<SimulationMatchClient> logger,
        TimeSpan? deadline = null)
    {
        _create = create;
        _destroy = destroy;
        _timeProvider = timeProvider;
        _logger = logger;
        _deadline = deadline ?? TimeSpan.FromSeconds(5);
    }

    public async Task<CreatedMatch> CreateMatchAsync(Room room, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(_deadline);
        try
        {
            var request = new CreateMatchRequest
            {
                RoomId = room.Id.ToString(),
                Capacity = (uint)room.Capacity,
                MapId = room.MapId
            };
            request.Players.Add(room.Players.Select(player => new Player
            {
                Id = player.Id.ToString(), Name = player.Name, Color = player.Color.ToString().ToLowerInvariant()
            }));
            var response = await _create(request, deadline.Token);
            var created = Validate(response, room);
            _logger.LogInformation("Created simulation match {MatchId} for room {RoomId} and players {PlayerIds}",
                created.MatchId, room.Id, string.Join(',', room.Players.Select(player => player.Id)));
            return created;
        }
        catch (RpcException exception) when (exception.StatusCode is StatusCode.Unavailable or StatusCode.DeadlineExceeded)
        {
            throw new SimulationUnavailableException("Simulation is unavailable.", exception);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SimulationUnavailableException("Simulation timed out.", exception);
        }
        catch (SimulationUnavailableException)
        {
            throw;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            throw new SimulationUnavailableException("Simulation is unavailable.", exception);
        }
    }

    public async Task DestroyMatchAsync(Guid matchId, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(_deadline);
        try
        {
            await _destroy(new DestroyMatchRequest { MatchId = matchId.ToString() }, deadline.Token);
            _logger.LogInformation("Destroyed simulation match {MatchId}", matchId);
        }
        catch (RpcException exception) when (exception.StatusCode is StatusCode.Unavailable or StatusCode.DeadlineExceeded)
        {
            throw new SimulationUnavailableException("Simulation is unavailable.", exception);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SimulationUnavailableException("Simulation timed out.", exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            throw new SimulationUnavailableException("Simulation is unavailable.", exception);
        }
    }

    private CreatedMatch Validate(CreateMatchResponse response, Room room)
    {
        if (!Guid.TryParseExact(response.MatchId, "D", out var matchId) || matchId == Guid.Empty
            || !Uri.TryCreate(response.GameplayUrl, UriKind.Absolute, out var gameplayUrl)
            || gameplayUrl.Scheme != Uri.UriSchemeWs
            || response.CountdownSeconds != 3)
        {
            throw new SimulationUnavailableException("Simulation returned an invalid match launch.");
        }

        DateTimeOffset expiresAt;
        try
        {
            expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(response.ExpiresUnixMs);
        }
        catch (ArgumentOutOfRangeException exception)
        {
            throw new SimulationUnavailableException("Simulation returned an invalid match launch.", exception);
        }
        if (expiresAt <= _timeProvider.GetUtcNow() || response.Launches.Count != room.Players.Count)
        {
            throw new SimulationUnavailableException("Simulation returned an invalid match launch.");
        }

        var launches = response.Launches.ToDictionary(launch => launch.PlayerId, StringComparer.Ordinal);
        if (launches.Count != room.Players.Count)
        {
            throw new SimulationUnavailableException("Simulation returned an invalid match launch.");
        }

        try
        {
            return new CreatedMatch(matchId, room.Players.Select(player =>
            {
                if (!launches.TryGetValue(player.Id.ToString(), out var launch)
                    || launch.Color != player.Color.ToString().ToLowerInvariant()
                    || string.IsNullOrWhiteSpace(launch.Ticket)
                    || launch.ExpiresUnixMs != response.ExpiresUnixMs)
                {
                    throw new SimulationUnavailableException("Simulation returned an invalid match launch.");
                }
                return new MatchLaunch(matchId, gameplayUrl.AbsoluteUri, 3, expiresAt,
                    player.Id, launch.Color, launch.Ticket);
            }).ToArray());
        }
        catch (ArgumentException exception)
        {
            throw new SimulationUnavailableException("Simulation returned an invalid match launch.", exception);
        }
    }
}
