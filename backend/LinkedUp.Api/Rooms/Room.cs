using System.Security.Cryptography;

namespace LinkedUp.Api.Rooms;

public enum RobotColor { Blue, Orange, Green, Purple }
public enum RoomStatus { Waiting, Starting, InGame }
public enum RoomError
{
    InvalidCapacity, InvalidCode, InvalidMap, NotFound, Full, AlreadyStarting, NotEnoughPlayers,
    InvalidSession, NotHost, Contention, PlayersNotPresent, MatchStartCancelled, AlreadyInGame
}

public sealed class RoomException(RoomError error, string message) : Exception(message)
{
    public RoomError Error { get; } = error;
}

public sealed record RoomPlayer(
    Guid Id, string Name, RobotColor Color, string SessionTokenHash,
    DateTimeOffset JoinedAt);

public sealed class Room
{
    private const string ValidCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static readonly (RobotColor Color, string Name)[] PlayerSlots =
    [
        (RobotColor.Blue, "Blue Robot"),
        (RobotColor.Orange, "Orange Robot"),
        (RobotColor.Green, "Green Robot"),
        (RobotColor.Purple, "Purple Robot")
    ];

    public required Guid Id { get; init; }
    public required string Code { get; init; }
    public required int Capacity { get; init; }
    public required Guid HostPlayerId { get; set; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required List<RoomPlayer> Players { get; init; }
    public string MapId { get; set; } = RoomMaps.ClassicAscent;
    public RoomStatus Status { get; set; }
    public Guid? MatchId { get; set; }
    public long Version { get; set; }

    public static Room Create(
        string code, int capacity, Guid hostId, string tokenHash,
        DateTimeOffset now)
    {
        if (capacity is < 2 or > 4)
        {
            throw new RoomException(RoomError.InvalidCapacity, "Room capacity must be between two and four.");
        }

        if (code is null || code.Length != 4 || code.Any(character => !ValidCodeCharacters.Contains(character)))
        {
            throw new RoomException(RoomError.InvalidCode, "Room code must be four unambiguous uppercase characters.");
        }

        var host = new RoomPlayer(hostId, PlayerSlots[0].Name, PlayerSlots[0].Color, tokenHash, now);
        return new Room
        {
            Id = Guid.NewGuid(),
            Code = code,
            Capacity = capacity,
            HostPlayerId = hostId,
            CreatedAt = now,
            Players = [host],
            Status = RoomStatus.Waiting,
            Version = 1
        };
    }

    public RoomPlayer Join(Guid playerId, string tokenHash, DateTimeOffset now)
    {
        if (Status == RoomStatus.Starting)
        {
            throw new RoomException(RoomError.AlreadyStarting, "The room is already starting.");
        }
        if (Status == RoomStatus.InGame)
        {
            throw new RoomException(RoomError.AlreadyInGame, "The room is already in a match.");
        }

        if (Players.Count >= Capacity)
        {
            throw new RoomException(RoomError.Full, "The room is full.");
        }

        var slot = PlayerSlots.First(candidate => Players.All(player => player.Color != candidate.Color));
        var player = new RoomPlayer(playerId, slot.Name, slot.Color, tokenHash, now);
        Players.Add(player);
        Version++;
        return player;
    }

    public bool Leave(string tokenHash)
    {
        if (Status == RoomStatus.InGame)
        {
            throw new RoomException(RoomError.AlreadyInGame, "The room is already in a match.");
        }

        return RemovePlayer(ValidateSession(tokenHash).Id);
    }

    public bool RemovePlayer(Guid playerId)
    {
        var index = Players.FindIndex(player => player.Id == playerId);
        if (index < 0)
        {
            return Players.Count > 0;
        }

        Players.RemoveAt(index);
        if (Players.Count > 0 && HostPlayerId == playerId)
        {
            HostPlayerId = Players[0].Id;
        }

        if (Status == RoomStatus.Starting)
        {
            Status = RoomStatus.Waiting;
        }

        Version++;
        return Players.Count > 0;
    }

    public bool RemovePlayerForLobbyDisconnect(Guid playerId) =>
        Status == RoomStatus.InGame ? false : RemovePlayer(playerId);

    public RoomPlayer ValidateSession(string tokenHash) =>
        Players.FirstOrDefault(player => TokenMatches(player.SessionTokenHash, tokenHash))
        ?? throw new RoomException(RoomError.InvalidSession, "The room session is invalid.");

    public void Start(string tokenHash)
    {
        var player = ValidateSession(tokenHash);
        if (player.Id != HostPlayerId)
        {
            throw new RoomException(RoomError.NotHost, "Only the host can start the room.");
        }

        if (Status == RoomStatus.Starting)
        {
            throw new RoomException(RoomError.AlreadyStarting, "The room is already starting.");
        }
        if (Status == RoomStatus.InGame)
        {
            throw new RoomException(RoomError.AlreadyInGame, "The room is already in a match.");
        }

        if (Players.Count != Capacity)
        {
            throw new RoomException(RoomError.NotEnoughPlayers, "The room needs more players to start.");
        }

        Status = RoomStatus.Starting;
        Version++;
    }

    public void SetMap(string tokenHash, string mapId)
    {
        var player = ValidateSession(tokenHash);
        if (player.Id != HostPlayerId)
        {
            throw new RoomException(RoomError.NotHost, "Only the host can select the map.");
        }
        if (Status == RoomStatus.Starting)
        {
            throw new RoomException(RoomError.AlreadyStarting, "The room is already starting.");
        }
        if (Status == RoomStatus.InGame)
        {
            throw new RoomException(RoomError.AlreadyInGame, "The room is already in a match.");
        }
        if (!RoomMaps.IsKnown(mapId))
        {
            throw new RoomException(RoomError.InvalidMap, "The selected map is not available.");
        }

        MapId = mapId;
        Version++;
    }

    public void CompleteStart(Guid matchId)
    {
        if (Status != RoomStatus.Starting || matchId == Guid.Empty)
        {
            throw new RoomException(RoomError.MatchStartCancelled, "The room start changed.");
        }

        MatchId = matchId;
        Status = RoomStatus.InGame;
        Version++;
    }

    private static bool TokenMatches(string storedTokenHash, string tokenHash)
    {
        if (string.IsNullOrEmpty(storedTokenHash) || string.IsNullOrEmpty(tokenHash))
        {
            return false;
        }

        try
        {
            var storedDigest = Convert.FromHexString(storedTokenHash);
            var suppliedDigest = Convert.FromHexString(tokenHash);
            return storedDigest.Length == SHA256.HashSizeInBytes
                && suppliedDigest.Length == SHA256.HashSizeInBytes
                && CryptographicOperations.FixedTimeEquals(storedDigest, suppliedDigest);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
