using LinkedUp.Api.Rooms;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using StackExchange.Redis;
using System.Text.Json;

namespace LinkedUp.Api.Tests;

public sealed class RedisRoomStoreTests : IAsyncLifetime
{
    private const string ValidCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private readonly string _prefix = $"linked-up:test:{Guid.NewGuid():N}:room:";
    private IConnectionMultiplexer _redis = null!;
    private IDatabase _database = null!;
    private RoomOptions _options = null!;
    private RedisRoomStore _store = null!;

    public async Task InitializeAsync()
    {
        var configuration = ConfigurationOptions.Parse(
            Environment.GetEnvironmentVariable("LinkedUp__Redis")
            ?? "127.0.0.1:6379,defaultDatabase=15");
        configuration.DefaultDatabase = 15;
        configuration.AbortOnConnectFail = false;
        _redis = await ConnectionMultiplexer.ConnectAsync(configuration);
        _database = _redis.GetDatabase(15);
        _options = new RoomOptions { KeyPrefix = _prefix };
        _store = CreateStore();
    }

    public async Task DisposeAsync()
    {
        foreach (var endpoint in _redis.GetEndPoints())
        {
            var keys = _redis.GetServer(endpoint).Keys(15, $"{_prefix}*").ToArray();
            if (keys.Length > 0)
            {
                await _database.KeyDeleteAsync(keys);
            }
        }

        await _redis.CloseAsync();
        _redis.Dispose();
    }

    [Fact]
    public async Task Create_round_trips_room_and_sets_ttl()
    {
        var created = await _store.CreateAsync(3, CancellationToken.None);
        var loaded = await _store.GetAsync(created.Room.Code, CancellationToken.None);
        var key = _options.KeyPrefix + created.Room.Code;
        var ttl = await _database.KeyTimeToLiveAsync(key);
        var json = (await _database.StringGetAsync(key)).ToString();
        var storedHash = JsonDocument.Parse(json).RootElement
            .GetProperty("players")[0].GetProperty("sessionTokenHash").GetString()!;

        Assert.Equal(created.Room.Id, loaded!.Id);
        Assert.InRange(ttl!.Value, TimeSpan.FromMinutes(119), TimeSpan.FromMinutes(120));
        Assert.DoesNotContain(created.Token, json);
        Assert.Equal(64, storedHash.Length);
        Assert.Equal(storedHash.ToLowerInvariant(), storedHash);
    }

    [Fact]
    public async Task Create_generates_an_unambiguous_four_character_code()
    {
        var created = await _store.CreateAsync(2, CancellationToken.None);

        Assert.Equal(4, created.Room.Code.Length);
        Assert.All(created.Room.Code, character => Assert.Contains(character, ValidCodeCharacters));
    }

    [Fact]
    public async Task Create_retries_a_code_collision()
    {
        await _database.StringSetAsync(_prefix + "XK72", "occupied");
        var codes = new Queue<string>(["XK72", "AB23"]);
        var store = CreateStore(() => codes.Dequeue(), () => new string('t', 44));

        var created = await store.CreateAsync(2, CancellationToken.None);

        Assert.Equal("AB23", created.Room.Code);
        Assert.Equal("occupied", await _database.StringGetAsync(_prefix + "XK72"));
    }

    [Fact]
    public async Task Concurrent_joins_do_not_lose_a_player()
    {
        var host = await _store.CreateAsync(3, CancellationToken.None);
        await Task.WhenAll(
            _store.JoinAsync(host.Room.Code, CancellationToken.None),
            _store.JoinAsync(host.Room.Code, CancellationToken.None));

        var room = await _store.GetAsync(host.Room.Code, CancellationToken.None);
        Assert.Equal(3, room!.Players.Count);
        Assert.Equal(3, room.Players.Select(player => player.Color).Distinct().Count());
    }

    [Fact]
    public async Task ResolveSession_validates_token_and_refreshes_ttl()
    {
        var created = await _store.CreateAsync(2, CancellationToken.None);
        var key = _prefix + created.Room.Code;
        await _database.KeyExpireAsync(key, TimeSpan.FromMinutes(1));

        var resolved = await _store.ResolveSessionAsync(
            created.Room.Code.ToLowerInvariant(), created.Token, CancellationToken.None);
        var ttl = await _database.KeyTimeToLiveAsync(key);

        Assert.Equal(created.Player.Id, resolved.Player.Id);
        Assert.InRange(ttl!.Value, TimeSpan.FromMinutes(119), TimeSpan.FromMinutes(120));
        var error = await Assert.ThrowsAsync<RoomException>(() =>
            _store.ResolveSessionAsync(created.Room.Code, "wrong", CancellationToken.None));
        Assert.Equal(RoomError.InvalidSession, error.Error);
    }

    [Fact]
    public async Task Host_can_start_a_full_room()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);

        var room = await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);

        Assert.Equal(RoomStatus.Starting, room.Status);
    }

    [Fact]
    public async Task Complete_start_requires_the_exact_starting_snapshot()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);
        var starting = await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);

        var completed = await _store.CompleteStartAsync(starting, Guid.NewGuid(), CancellationToken.None);

        Assert.Equal(RoomStatus.InGame, completed!.Status);
        Assert.NotNull(completed.MatchId);
        Assert.Null(await _store.RollbackStartAsync(starting, CancellationToken.None));
    }

    [Fact]
    public async Task Rollback_start_returns_to_waiting_and_clears_a_stale_match_id()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);
        var starting = await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);
        starting.MatchId = Guid.NewGuid();
        await _database.StringSetAsync(_prefix + host.Room.Code,
            JsonSerializer.Serialize(starting), TimeSpan.FromMinutes(120));

        var rolledBack = await _store.RollbackStartAsync(starting, CancellationToken.None);

        Assert.Equal(RoomStatus.Waiting, rolledBack!.Status);
        Assert.Null(rolledBack.MatchId);
    }

    [Fact]
    public async Task Complete_start_does_not_overwrite_a_changed_starting_room()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);
        var starting = await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);
        var changed = await _store.GetAsync(host.Room.Code, CancellationToken.None);
        changed!.Version++;
        await _database.StringSetAsync(_prefix + host.Room.Code,
            JsonSerializer.Serialize(changed), TimeSpan.FromMinutes(120));

        Assert.Null(await _store.CompleteStartAsync(starting, Guid.NewGuid(), CancellationToken.None));
    }

    [Fact]
    public async Task Start_finalization_rejects_a_reordered_roster_without_a_version_change()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);
        var starting = await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);
        var changed = await _store.GetAsync(host.Room.Code, CancellationToken.None);
        changed!.Players.Reverse();
        await _database.StringSetAsync(_prefix + host.Room.Code,
            JsonSerializer.Serialize(changed), TimeSpan.FromMinutes(120));

        Assert.Null(await _store.CompleteStartAsync(starting, Guid.NewGuid(), CancellationToken.None));
        Assert.Null(await _store.RollbackStartAsync(starting, CancellationToken.None));
    }

    [Fact]
    public async Task Removing_host_migrates_host_to_first_remaining_player()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        var joined = await _store.JoinAsync(host.Room.Code, CancellationToken.None);

        var room = await _store.RemovePlayerAsync(
            host.Room.Code, host.Player.Id, CancellationToken.None);

        Assert.Equal(joined.Player.Id, room!.HostPlayerId);
        Assert.Equal(joined.Player.Id, Assert.Single(room.Players).Id);
    }

    [Fact]
    public async Task Removing_missing_player_does_not_write_or_refresh_ttl()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        var key = _prefix + host.Room.Code;
        await _database.KeyExpireAsync(key, TimeSpan.FromMinutes(30));
        var before = await _database.StringGetAsync(key);

        var room = await _store.RemovePlayerAsync(
            host.Room.Code, Guid.NewGuid(), CancellationToken.None);

        var after = await _database.StringGetAsync(key);
        var ttl = await _database.KeyTimeToLiveAsync(key);
        Assert.Null(room);
        Assert.Equal(before, after);
        Assert.InRange(ttl!.Value, TimeSpan.FromMinutes(29), TimeSpan.FromMinutes(30));
    }

    [Fact]
    public async Task Final_player_leave_deletes_room_key()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);

        var room = await _store.LeaveAsync(
            host.Room.Code, host.Token, CancellationToken.None);

        Assert.Null(room);
        Assert.False(await _database.KeyExistsAsync(_prefix + host.Room.Code));
    }

    [Fact]
    public async Task Join_rejects_a_room_that_is_starting()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _store.JoinAsync(host.Room.Code, CancellationToken.None);
        await _store.StartAsync(host.Room.Code, host.Token, CancellationToken.None);

        var error = await Assert.ThrowsAsync<RoomException>(() =>
            _store.JoinAsync(host.Room.Code, CancellationToken.None));

        Assert.Equal(RoomError.AlreadyStarting, error.Error);
    }

    [Fact]
    public async Task Expired_or_missing_room_is_not_recreated()
    {
        var host = await _store.CreateAsync(2, CancellationToken.None);
        await _database.KeyExpireAsync(_prefix + host.Room.Code, TimeSpan.Zero);

        Assert.Null(await _store.GetAsync(host.Room.Code, CancellationToken.None));
        var error = await Assert.ThrowsAsync<RoomException>(() =>
            _store.JoinAsync(host.Room.Code, CancellationToken.None));
        Assert.Equal(RoomError.NotFound, error.Error);
        Assert.False(await _database.KeyExistsAsync(_prefix + host.Room.Code));
    }

    [Fact]
    public async Task Codes_are_case_insensitive_but_ambiguous_characters_are_rejected()
    {
        var created = await _store.CreateAsync(2, CancellationToken.None);

        Assert.NotNull(await _store.GetAsync(created.Room.Code.ToLowerInvariant(), CancellationToken.None));
        var error = await Assert.ThrowsAsync<RoomException>(() =>
            _store.GetAsync("BAD1", CancellationToken.None));
        Assert.Equal(RoomError.InvalidCode, error.Error);
    }

    [Fact]
    public async Task Corrupt_json_raises_a_server_failure_instead_of_returning_an_empty_room()
    {
        await _database.StringSetAsync(_prefix + "XK72", "not-json");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            _store.GetAsync("XK72", CancellationToken.None));
    }

    private RedisRoomStore CreateStore(
        Func<string>? codeGenerator = null,
        Func<string>? tokenGenerator = null)
    {
        var options = Options.Create(_options);
        var logger = NullLogger<RedisRoomStore>.Instance;
        return codeGenerator is null
            ? new RedisRoomStore(_redis, options, TimeProvider.System, logger)
            : new RedisRoomStore(
                _redis, options, TimeProvider.System, logger, codeGenerator, tokenGenerator!);
    }
}
