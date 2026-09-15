using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LinkedUp.Api.Rooms;

namespace LinkedUp.Api.Tests;

public sealed class RoomTests
{
    [Fact]
    public void Create_assigns_blue_host_and_requested_capacity()
    {
        var room = Room.Create(
            code: "XK72", capacity: 3, hostId: PlayerId(1),
            tokenHash: Hash("host"), now: DateTimeOffset.UnixEpoch);

        Assert.Equal(3, room.Capacity);
        Assert.Equal(RobotColor.Blue, Assert.Single(room.Players).Color);
        Assert.Equal(room.Players[0].Id, room.HostPlayerId);
        Assert.Equal(RoomMaps.ClassicAscent, room.MapId);
        Assert.Equal(1, room.Version);
    }

    [Fact]
    public void Host_can_select_a_known_map_while_waiting()
    {
        var room = TestRoom();

        room.SetMap(Hash("host"), RoomMaps.RelayRidge);

        Assert.Equal(RoomMaps.RelayRidge, room.MapId);
        Assert.Equal(2, room.Version);
    }

    [Fact]
    public void Map_selection_requires_a_known_map_and_waiting_host()
    {
        var room = TestRoom();
        room.Join(PlayerId(2), Hash("orange"), DateTimeOffset.UnixEpoch.AddSeconds(1));

        Assert.Equal(RoomError.NotHost,
            Assert.Throws<RoomException>(() => room.SetMap(Hash("orange"), RoomMaps.Windworks)).Error);
        Assert.Equal(RoomError.InvalidMap,
            Assert.Throws<RoomException>(() => room.SetMap(Hash("host"), "unknown")).Error);

        room.Start(Hash("host"));
        Assert.Equal(RoomError.AlreadyStarting,
            Assert.Throws<RoomException>(() => room.SetMap(Hash("host"), RoomMaps.CraneShift)).Error);
        Assert.Equal(RoomMaps.ClassicAscent, room.MapId);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    public void Create_rejects_invalid_capacity(int capacity)
    {
        var error = Assert.Throws<RoomException>(() =>
            Room.Create("XK72", capacity, PlayerId(1), Hash("host"), DateTimeOffset.UnixEpoch));

        Assert.Equal(RoomError.InvalidCapacity, error.Error);
    }

    [Fact]
    public void Create_rejects_invalid_code()
    {
        var error = Assert.Throws<RoomException>(() =>
            Room.Create("BAD1", 2, PlayerId(1), Hash("host"), DateTimeOffset.UnixEpoch));

        Assert.Equal(RoomError.InvalidCode, error.Error);
    }

    [Fact]
    public void Join_assigns_first_unused_color_and_rejects_full_room()
    {
        var room = TestRoom(capacity: 2);
        room.Join(PlayerId(2), Hash("orange"), DateTimeOffset.UnixEpoch.AddSeconds(1));

        Assert.Equal(RobotColor.Orange, room.Players[1].Color);
        var error = Assert.Throws<RoomException>(() =>
            room.Join(PlayerId(3), Hash("green"), DateTimeOffset.UnixEpoch.AddSeconds(2)));
        Assert.Equal(RoomError.Full, error.Error);
    }

    [Fact]
    public void Join_preserves_order_and_increments_version()
    {
        var room = TestRoom(capacity: 4);
        room.Join(PlayerId(2), Hash("orange"), DateTimeOffset.UnixEpoch.AddSeconds(1));
        room.Join(PlayerId(3), Hash("green"), DateTimeOffset.UnixEpoch.AddSeconds(2));

        Assert.Equal([PlayerId(1), PlayerId(2), PlayerId(3)], room.Players.Select(player => player.Id));
        Assert.Equal(3, room.Version);
    }

    [Fact]
    public void Join_rejects_a_starting_room()
    {
        var room = FullStartingRoom();

        var error = Assert.Throws<RoomException>(() =>
            room.Join(PlayerId(3), Hash("green"), DateTimeOffset.UnixEpoch.AddSeconds(2)));

        Assert.Equal(RoomError.AlreadyStarting, error.Error);
    }

    [Fact]
    public void Start_requires_full_room_and_host()
    {
        var room = TestRoom(capacity: 2);
        Assert.Equal(RoomError.NotEnoughPlayers,
            Assert.Throws<RoomException>(() => room.Start(Hash("host"))).Error);
        room.Join(PlayerId(2), Hash("orange"), DateTimeOffset.UnixEpoch.AddSeconds(1));
        Assert.Equal(RoomError.NotHost,
            Assert.Throws<RoomException>(() => room.Start(Hash("orange"))).Error);
        room.Start(Hash("host"));

        Assert.Equal(RoomStatus.Starting, room.Status);
        Assert.Equal(3, room.Version);
    }

    [Fact]
    public void Host_leave_migrates_host_and_starting_room_returns_to_waiting()
    {
        var room = FullStartingRoom();
        var playersRemain = room.Leave(Hash("host"));

        Assert.True(playersRemain);
        Assert.Equal(room.Players[0].Id, room.HostPlayerId);
        Assert.Equal(RoomStatus.Waiting, room.Status);
        Assert.Equal(4, room.Version);
    }

    [Fact]
    public void Complete_match_start_persists_only_the_match_id()
    {
        var room = FullStartingRoom();
        var matchId = Guid.Parse("11111111-1111-4111-8111-111111111111");

        room.CompleteStart(matchId);

        Assert.Equal(RoomStatus.InGame, room.Status);
        Assert.Equal(matchId, room.MatchId);
        Assert.DoesNotContain("ticket", JsonSerializer.Serialize(PublicRooms.From(room)),
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Public_room_always_includes_a_null_match_id_before_the_game()
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(
            PublicRooms.From(TestRoom()), new JsonSerializerOptions(JsonSerializerDefaults.Web)));

        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("matchId").ValueKind);
    }

    [Fact]
    public void Public_room_suppresses_a_stale_match_id_before_the_game()
    {
        var room = TestRoom();
        room.MatchId = Guid.NewGuid();

        Assert.Null(PublicRooms.From(room).MatchId);
    }

    [Fact]
    public void In_game_disconnect_does_not_mutate_the_match_roster()
    {
        var room = FullStartingRoom();
        room.CompleteStart(Guid.NewGuid());

        Assert.False(room.RemovePlayerForLobbyDisconnect(room.Players[1].Id));
        Assert.Equal(2, room.Players.Count);
    }

    [Fact]
    public void Join_and_leave_reject_an_in_game_room()
    {
        var room = FullStartingRoom();
        room.CompleteStart(Guid.NewGuid());

        Assert.Equal(RoomError.AlreadyInGame,
            Assert.Throws<RoomException>(() => room.Join(PlayerId(3), Hash("green"), DateTimeOffset.UtcNow)).Error);
        Assert.Equal(RoomError.AlreadyInGame,
            Assert.Throws<RoomException>(() => room.Leave(Hash("host"))).Error);
    }

    [Fact]
    public void Leave_rejects_an_invalid_token()
    {
        var error = Assert.Throws<RoomException>(() => TestRoom().Leave(Hash("wrong")));

        Assert.Equal(RoomError.InvalidSession, error.Error);
    }

    [Fact]
    public void RemovePlayer_removes_final_player_and_reports_empty_room()
    {
        var room = TestRoom();

        Assert.False(room.RemovePlayer(PlayerId(1)));
        Assert.Empty(room.Players);
        Assert.Equal(2, room.Version);
        Assert.False(room.RemovePlayer(PlayerId(1)));
        Assert.Equal(2, room.Version);
    }

    [Fact]
    public void ValidateSession_returns_player_or_invalid_session()
    {
        var room = TestRoom();

        Assert.Equal(PlayerId(1), room.ValidateSession(Hash("host")).Id);
        Assert.Equal(RoomError.InvalidSession,
            Assert.Throws<RoomException>(() => room.ValidateSession(Hash("wrong"))).Error);
    }

    [Fact]
    public void ValidateSession_rejects_a_non_digest_hex_value()
    {
        var room = Room.Create("XK72", 2, PlayerId(1), "00", DateTimeOffset.UnixEpoch);
        var error = Assert.Throws<RoomException>(() => room.ValidateSession("00"));

        Assert.Equal(RoomError.InvalidSession, error.Error);
    }

    private static Room TestRoom(int capacity = 2) =>
        Room.Create("XK72", capacity, PlayerId(1), Hash("host"), DateTimeOffset.UnixEpoch);

    private static Room FullStartingRoom()
    {
        var room = TestRoom();
        room.Join(PlayerId(2), Hash("orange"), DateTimeOffset.UnixEpoch.AddSeconds(1));
        room.Start(Hash("host"));
        return room;
    }

    private static Guid PlayerId(int value) =>
        Guid.Parse($"00000000-0000-0000-0000-{value:D12}");

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
