namespace LinkedUp.Api.Rooms;

public static class RoomMaps
{
    public const string ClassicAscent = "classic-ascent";
    public const string RelayRidge = "relay-ridge";
    public const string CraneShift = "crane-shift";
    public const string Windworks = "windworks";

    public static bool IsKnown(string? mapId) => mapId is
        ClassicAscent or RelayRidge or CraneShift or Windworks;
}
