using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace LinkedUp.Api.Rooms;

public sealed class RedisRoomStore
{
    private const string ValidCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private const int CreateAttempts = 10;
    private const int MutationAttempts = 5;
    private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();

    private readonly IDatabase _database;
    private readonly RoomOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<RedisRoomStore> _logger;
    private readonly Func<string> _codeGenerator;
    private readonly Func<string> _tokenGenerator;
    private readonly TimeSpan _ttl;

    public RedisRoomStore(
        IConnectionMultiplexer redis,
        IOptions<RoomOptions> options,
        TimeProvider timeProvider,
        ILogger<RedisRoomStore> logger)
        : this(redis, options, timeProvider, logger, GenerateCode, GenerateToken)
    {
    }

    internal RedisRoomStore(
        IConnectionMultiplexer redis,
        IOptions<RoomOptions> options,
        TimeProvider timeProvider,
        ILogger<RedisRoomStore> logger,
        Func<string> codeGenerator,
        Func<string> tokenGenerator)
    {
        _database = redis.GetDatabase();
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
        _codeGenerator = codeGenerator;
        _tokenGenerator = tokenGenerator;
        _ttl = TimeSpan.FromMinutes(_options.RoomTtlMinutes);
    }

    public async Task<RoomSession> CreateAsync(int capacity, CancellationToken token)
    {
        var rawToken = _tokenGenerator();
        var tokenHash = HashToken(rawToken);
        var hostId = Guid.NewGuid();
        var now = _timeProvider.GetUtcNow();

        for (var attempt = 0; attempt < CreateAttempts; attempt++)
        {
            token.ThrowIfCancellationRequested();
            var code = NormalizeCode(_codeGenerator());
            var room = Room.Create(code, capacity, hostId, tokenHash, now);
            if (await _database.StringSetAsync(
                    Key(code), Serialize(room), _ttl, When.NotExists).WaitAsync(token))
            {
                return new RoomSession(room, room.Players[0], rawToken);
            }
        }

        throw Contention();
    }

    public async Task<Room?> GetAsync(string code, CancellationToken token)
    {
        var key = Key(NormalizeCode(code));
        var json = await _database.StringGetAsync(key).WaitAsync(token);
        if (json.IsNull)
        {
            return null;
        }

        var room = Deserialize(json, key);
        return await _database.KeyExpireAsync(key, _ttl).WaitAsync(token) ? room : null;
    }

    public async Task<RoomSession> JoinAsync(string code, CancellationToken token)
    {
        var rawToken = _tokenGenerator();
        var tokenHash = HashToken(rawToken);
        var playerId = Guid.NewGuid();
        var now = _timeProvider.GetUtcNow();
        var (room, player) = await MutateAsync(
            code,
            current => (true, current.Join(playerId, tokenHash, now)),
            token);
        return new RoomSession(room!, player, rawToken);
    }

    public async Task<Room?> LeaveAsync(
        string code, string rawToken, CancellationToken token)
    {
        var (room, _) = await MutateAsync(
            code,
            current => (current.Leave(HashToken(rawToken)), true),
            token);
        return room;
    }

    public async Task<Room?> RemovePlayerAsync(
        string code, Guid playerId, CancellationToken token)
    {
        var (room, removed) = await MutateAsync<bool>(
            code,
            current => !current.Players.Any(player => player.Id == playerId)
                || current.Status == RoomStatus.InGame
                ? ((bool?)null, false)
                : (current.RemovePlayerForLobbyDisconnect(playerId), true),
            token);
        return removed ? room : null;
    }

    public async Task<Room> StartAsync(
        string code, string rawToken, CancellationToken token)
    {
        var (room, _) = await MutateAsync(
            code,
            current =>
            {
                current.Start(HashToken(rawToken));
                return (true, true);
            },
            token);
        return room!;
    }

    public Task<Room?> CompleteStartAsync(
        Room starting, Guid matchId, CancellationToken token) =>
        MutateStartingAsync(starting, room => room.CompleteStart(matchId), token);

    public Task<Room?> RollbackStartAsync(Room starting, CancellationToken token) =>
        MutateStartingAsync(starting, room =>
        {
            room.Status = RoomStatus.Waiting;
            room.MatchId = null;
            room.Version++;
        }, token);

    public async Task<(Room Room, RoomPlayer Player)> ResolveSessionAsync(
        string code, string rawToken, CancellationToken token)
    {
        var key = Key(NormalizeCode(code));
        var json = await _database.StringGetAsync(key).WaitAsync(token);
        if (json.IsNull)
        {
            throw NotFound();
        }

        var room = Deserialize(json, key);
        var player = room.ValidateSession(HashToken(rawToken));
        if (!await _database.KeyExpireAsync(key, _ttl).WaitAsync(token))
        {
            throw NotFound();
        }

        return (room, player);
    }

    private async Task<(Room? Room, T Result)> MutateAsync<T>(
        string code,
        Func<Room, (bool? Keep, T Result)> mutation,
        CancellationToken token)
    {
        var key = Key(NormalizeCode(code));
        for (var attempt = 0; attempt < MutationAttempts; attempt++)
        {
            var oldJson = await _database.StringGetAsync(key).WaitAsync(token);
            if (oldJson.IsNull)
            {
                throw NotFound();
            }

            var room = Deserialize(oldJson, key);
            var (keep, result) = mutation(room);
            if (keep is null)
            {
                return (room, result);
            }

            var transaction = _database.CreateTransaction();
            transaction.AddCondition(Condition.StringEqual(key, oldJson));
            if (keep.Value)
            {
                _ = transaction.StringSetAsync(key, Serialize(room), _ttl);
            }
            else
            {
                _ = transaction.KeyDeleteAsync(key);
            }

            if (await transaction.ExecuteAsync().WaitAsync(token))
            {
                return (keep.Value ? room : null, result);
            }
        }

        throw Contention();
    }

    private async Task<Room?> MutateStartingAsync(
        Room starting, Action<Room> mutation, CancellationToken token)
    {
        var key = Key(NormalizeCode(starting.Code));
        for (var attempt = 0; attempt < MutationAttempts; attempt++)
        {
            var oldJson = await _database.StringGetAsync(key).WaitAsync(token);
            if (oldJson.IsNull)
            {
                throw NotFound();
            }

            var room = Deserialize(oldJson, key);
            if (room.Status != RoomStatus.Starting
                || room.Version != starting.Version
                || !room.Players.Select(player => player.Id)
                    .SequenceEqual(starting.Players.Select(player => player.Id)))
            {
                return null;
            }

            mutation(room);
            var transaction = _database.CreateTransaction();
            transaction.AddCondition(Condition.StringEqual(key, oldJson));
            _ = transaction.StringSetAsync(key, Serialize(room), _ttl);
            if (await transaction.ExecuteAsync().WaitAsync(token))
            {
                return room;
            }
        }

        throw Contention();
    }

    private Room Deserialize(RedisValue json, RedisKey key)
    {
        try
        {
            return JsonSerializer.Deserialize<Room>((string)json!, JsonOptions)
                ?? throw new JsonException("Stored room was null.");
        }
        catch (JsonException exception)
        {
            _logger.LogError(exception, "Stored room JSON is corrupt at {RoomKey}.", key);
            throw new InvalidOperationException("Stored room data is invalid.", exception);
        }
    }

    private static string Serialize(Room room) => JsonSerializer.Serialize(room, JsonOptions);

    private string Key(string code) => _options.KeyPrefix + code;

    private static string NormalizeCode(string code)
    {
        if (code is null || code.Length != 4)
        {
            throw InvalidCode();
        }

        var normalized = code.ToUpperInvariant();
        if (normalized.Any(character => !ValidCodeCharacters.Contains(character)))
        {
            throw InvalidCode();
        }

        return normalized;
    }

    private static string GenerateCode()
    {
        var bytes = RandomNumberGenerator.GetBytes(4);
        return new string(bytes.Select(value => ValidCodeCharacters[value & 31]).ToArray());
    }

    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    private static string HashToken(string rawToken) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawToken)))
            .ToLowerInvariant();

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter());
        return options;
    }

    private static RoomException InvalidCode() =>
        new(RoomError.InvalidCode, "Room code must be four unambiguous characters.");

    private static RoomException NotFound() =>
        new(RoomError.NotFound, "The room was not found.");

    private static RoomException Contention() =>
        new(RoomError.Contention, "The room changed too many times. Try again.");
}
