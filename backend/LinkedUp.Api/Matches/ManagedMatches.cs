using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using LinkedUp.Simulation;
using Microsoft.Extensions.Options;
using SimColor = LinkedUp.Simulation.RobotColor;

namespace LinkedUp.Api.Matches;

public interface ISimulationMatchClient
{
    Task<CreatedMatch> CreateMatchAsync(Rooms.Room room, CancellationToken cancellationToken);
    Task DestroyMatchAsync(Guid matchId, CancellationToken cancellationToken);
}

public sealed class SimulationUnavailableException(string message, Exception? inner = null) : Exception(message, inner);
public sealed record CreatedMatch(Guid MatchId, IReadOnlyList<MatchLaunch> Launches);

public sealed class MatchOptions
{
    public string GameplayUrl { get; set; } = "ws://127.0.0.1:5100/gameplay";
    public int MaxMatches { get; set; } = 8;
}

public sealed class ManagedMatches(IOptions<MatchOptions> options, ILogger<ManagedMatches> logger)
    : BackgroundService, ISimulationMatchClient
{
    private readonly ConcurrentDictionary<Guid, LiveMatch> _matches = new();
    private readonly object _creationGate = new();

    public bool Contains(Guid id) => _matches.ContainsKey(id);

    public Task<CreatedMatch> CreateMatchAsync(Rooms.Room room, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_creationGate)
        {
            if (_matches.Count >= options.Value.MaxMatches)
                throw new SimulationUnavailableException("All game slots are occupied. Try again shortly.");
            var match = new LiveMatch(room, options.Value.GameplayUrl);
            _matches[match.Id] = match;
            return Task.FromResult(new CreatedMatch(match.Id, match.IssueLaunches()));
        }
    }

    public Task DestroyMatchAsync(Guid matchId, CancellationToken cancellationToken)
    {
        if (_matches.TryRemove(matchId, out var match)) match.Dispose();
        return Task.CompletedTask;
    }

    public MatchLaunch? Launch(Guid matchId, Guid playerId) =>
        _matches.TryGetValue(matchId, out var match) ? match.IssueLaunch(playerId) : null;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var previous = Stopwatch.GetTimestamp();
        double accumulated = 0;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(8));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = Stopwatch.GetTimestamp();
                accumulated = Math.Min(accumulated + Stopwatch.GetElapsedTime(previous, now).TotalSeconds, 8d / 60);
                previous = now;
                while (accumulated >= 1d / 60)
                {
                    accumulated -= 1d / 60;
                    foreach (var (id, match) in _matches)
                    {
                        try
                        {
                            if (!match.Step()) await DestroyMatchAsync(id, stoppingToken);
                        }
                        catch (Exception error)
                        {
                            logger.LogError(error, "Match {MatchId} failed", id);
                            await DestroyMatchAsync(id, stoppingToken);
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            foreach (var id in _matches.Keys) await DestroyMatchAsync(id, CancellationToken.None);
        }
    }

    public async Task ConnectAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        LiveMatch? match = null;
        PlayerConnection? player = null;
        try
        {
            using var authentication = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            authentication.CancelAfter(TimeSpan.FromSeconds(10));
            var join = JsonSerializer.Deserialize<JoinMatchMessage>(await ReadAsync(socket, authentication.Token), Wire.Json);
            if (join is null || join.Type != "join" || join.Ticket is null || join.Ticket.Length > 128
                || !_matches.TryGetValue(join.MatchId, out match)
                || (player = match.Attach(join.Ticket)) is null)
                throw new InvalidDataException("Invalid match credentials.");
            await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(
                new WelcomeMessage(player.Color, match.Roster, match.MapId), Wire.Json),
                WebSocketMessageType.Text, true, lifetime.Token);
            match.Ready(player);
            var sender = SendAsync(socket, player.Outgoing.Reader, lifetime.Token);
            var receiver = ReceiveInputsAsync(socket, match, player, lifetime.Token);
            await Task.WhenAny(sender, receiver);
            lifetime.Cancel();
            try { await Task.WhenAll(sender, receiver); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        }
        catch (Exception error) when (error is JsonException or InvalidDataException or WebSocketException or OperationCanceledException)
        {
            // Never log the authentication payload or credentials.
        }
        finally
        {
            if (match is not null && player is not null) match.Detach(player);
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Match connection ended", closeTimeout.Token); }
                catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
            }
        }
    }

    private static async Task SendAsync(WebSocket socket, ChannelReader<byte[]> outgoing, CancellationToken token)
    {
        await foreach (var message in outgoing.ReadAllAsync(token))
            await socket.SendAsync(message, WebSocketMessageType.Text, true, token);
    }

    private static async Task ReceiveInputsAsync(WebSocket socket, LiveMatch match, PlayerConnection player, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var input = JsonSerializer.Deserialize<ClientInput>(await ReadAsync(socket, token), Wire.Json);
            if (input is null || !input.IsValid() || !match.Input(player, input))
                throw new InvalidDataException("Invalid input.");
        }
    }

    internal static async Task<byte[]> ReadAsync(WebSocket socket, CancellationToken token)
    {
        var buffer = new byte[2048];
        int count = 0;
        while (true)
        {
            if (count == buffer.Length) throw new InvalidDataException("Message too large.");
            var result = await socket.ReceiveAsync(buffer.AsMemory(count), token);
            if (result.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("Expected text.");
            count += result.Count;
            if (result.EndOfMessage) return buffer[..count];
        }
    }

    private sealed class PlayerConnection(Guid id, SimColor color)
    {
        public Guid Id { get; } = id;
        public SimColor SimColor { get; } = color;
        public string Color => Wire.Color((int)SimColor);
        public byte[] TicketHash { get; set; } = [];
        public DateTimeOffset TicketExpiry { get; set; }
        public bool Connected { get; set; }
        public bool Ready { get; set; }
        public long Sequence { get; set; }
        public long LastInput { get; set; } = Stopwatch.GetTimestamp();
        public long RateStart { get; set; } = Stopwatch.GetTimestamp();
        public int InputCount { get; set; }
        public Channel<byte[]> Outgoing { get; set; } = NewChannel();
        public static Channel<byte[]> NewChannel() => Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(2) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    private sealed class LiveMatch : IDisposable
    {
        private readonly object _gate = new();
        private readonly PrototypeSimulation _simulation;
        private readonly PlayerConnection[] _players;
        private readonly string _url;
        private readonly long _created = Stopwatch.GetTimestamp();
        private long _countdown;
        private long _emptySince;
        private long _finishedAt;
        private bool _disposed;
        private int _countdownSeconds = -1;
        private int _broadcastTicks;
        public Guid Id { get; } = Guid.NewGuid();
        public string MapId { get; }
        public string[] Roster => _players.Select(player => player.Color).ToArray();

        public LiveMatch(Rooms.Room room, string url)
        {
            MapId = room.MapId;
            _url = url;
            _players = room.Players.Select(player => new PlayerConnection(player.Id, (SimColor)player.Color)).ToArray();
            _simulation = new PrototypeSimulation(_players.Select(player => player.SimColor), Routes.RouteConfig(MapId));
        }

        public MatchLaunch[] IssueLaunches() => _players.Select(player => IssueLaunch(player.Id)!).ToArray();

        public MatchLaunch? IssueLaunch(Guid playerId)
        {
            lock (_gate)
            {
                if (_disposed) return null;
                var player = _players.FirstOrDefault(player => player.Id == playerId);
                if (player is null) return null;
                var ticket = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
                player.TicketHash = SHA256.HashData(Encoding.UTF8.GetBytes(ticket));
                player.TicketExpiry = DateTimeOffset.UtcNow.AddMinutes(2);
                return new MatchLaunch(Id, _url, 3, player.TicketExpiry, player.Id, player.Color, ticket);
            }
        }

        public PlayerConnection? Attach(string ticket)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ticket));
            lock (_gate)
            {
                if (_disposed) return null;
                var player = _players.FirstOrDefault(player => !player.Connected
                    && player.TicketExpiry > DateTimeOffset.UtcNow
                    && CryptographicOperations.FixedTimeEquals(player.TicketHash, hash));
                if (player is null) return null;
                player.TicketHash = [];
                player.Connected = true;
                player.Ready = false;
                player.Sequence = 0;
                player.InputCount = 0;
                player.LastInput = player.RateStart = Stopwatch.GetTimestamp();
                player.Outgoing = PlayerConnection.NewChannel();
                return player;
            }
        }

        public void Ready(PlayerConnection player) { lock (_gate) player.Ready = true; }

        public void Detach(PlayerConnection player)
        {
            lock (_gate)
            {
                player.Connected = player.Ready = false;
                player.Outgoing.Writer.TryComplete();
                if (!_disposed) _simulation.SetInput(player.SimColor, new PlayerInput());
            }
        }

        public bool Input(PlayerConnection player, ClientInput input)
        {
            lock (_gate)
            {
                if (_disposed || input.Sequence <= player.Sequence) return false;
                if (Stopwatch.GetElapsedTime(player.RateStart).TotalSeconds >= 1)
                {
                    player.RateStart = Stopwatch.GetTimestamp();
                    player.InputCount = 0;
                }
                if (++player.InputCount > 120) return false;
                player.Sequence = input.Sequence;
                player.LastInput = Stopwatch.GetTimestamp();
                _simulation.SetInput(player.SimColor, new PlayerInput(input.MoveX, input.MoveZ, input.Jump));
                return true;
            }
        }

        public bool Step()
        {
            lock (_gate)
            {
                if (_disposed || Stopwatch.GetElapsedTime(_created).TotalMinutes > 30) return false;
                if (_players.All(player => !player.Connected))
                {
                    if (_emptySince == 0) _emptySince = Stopwatch.GetTimestamp();
                    if (Stopwatch.GetElapsedTime(_emptySince).TotalSeconds > 30) return false;
                }
                else _emptySince = 0;
                if (_countdown == 0)
                {
                    if (_players.All(player => player.Ready)) _countdown = Stopwatch.GetTimestamp();
                    else return Stopwatch.GetElapsedTime(_created).TotalMinutes < 2;
                }
                var remaining = Math.Max(0, 3 - (int)Stopwatch.GetElapsedTime(_countdown).TotalSeconds);
                if (remaining != _countdownSeconds)
                {
                    _countdownSeconds = remaining;
                    Broadcast(new CountdownMessage(remaining));
                }
                if (remaining > 0) return true;
                foreach (var player in _players)
                    if (!player.Connected || Stopwatch.GetElapsedTime(player.LastInput).TotalSeconds > .5)
                        _simulation.SetInput(player.SimColor, new PlayerInput());
                _simulation.Step();
                var snapshot = _simulation.Snapshot();
                if (snapshot.MatchState == MatchState.Finished)
                {
                    if (_finishedAt == 0) _finishedAt = Stopwatch.GetTimestamp();
                    if (Stopwatch.GetElapsedTime(_finishedAt).TotalMinutes >= 2) return false;
                }
                if (++_broadcastTicks % 3 == 0)
                    Broadcast(new ServerSnapshot((long)snapshot.Tick, (long)snapshot.ResetCount, snapshot.TetherTension,
                        snapshot.Players.Select(player => new NetworkPlayer(Wire.Color((int)player.Id),
                            _players.Single(connection => connection.SimColor == player.Id).Sequence,
                            Vector(player.Position), Vector(player.Velocity), player.Grounded)).ToArray(),
                        snapshot.MatchState == MatchState.Finished ? "finished" : "running", (long)snapshot.ElapsedTicks,
                        snapshot.Checkpoint, snapshot.Obstacles.Select(obstacle => new NetworkObstacle(obstacle.Id,
                            JsonNamingPolicy.CamelCase.ConvertName(obstacle.Kind.ToString()),
                            JsonNamingPolicy.CamelCase.ConvertName(obstacle.Zone.ToString()),
                            JsonNamingPolicy.CamelCase.ConvertName(obstacle.Phase.ToString()),
                            Vector(obstacle.HalfExtent), Vector(obstacle.Position), Vector(obstacle.Rotation))).ToArray()));
                return true;
            }
        }

        private static VectorState Vector(Vec3 vector) => new(vector.X, vector.Y, vector.Z);
        private void Broadcast<T>(T message)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(message, Wire.Json);
            foreach (var player in _players.Where(player => player.Ready)) player.Outgoing.Writer.TryWrite(bytes);
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                foreach (var player in _players) player.Outgoing.Writer.TryComplete();
                _simulation.Dispose();
            }
        }
    }
}
