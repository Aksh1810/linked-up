using LinkedUp.Contracts;

namespace LinkedUp.Client;

public sealed class SnapshotBuffer
{
    private const long DelayTicks = 6;
    private readonly List<ServerSnapshot> entries = [];
    private readonly object gate = new();
    private double receivedAt;

    public bool Push(ServerSnapshot snapshot, double now)
    {
        lock (gate)
        {
        if (entries.Count > 0)
        {
            var newest = entries[^1];
            if (snapshot.ResetCount < newest.ResetCount
                || snapshot.ResetCount == newest.ResetCount && snapshot.Tick <= newest.Tick) return false;
            if (snapshot.ResetCount > newest.ResetCount) entries.Clear();
        }
        entries.Add(snapshot);
        receivedAt = now;
        if (entries.Count > 32) entries.RemoveAt(0);
        return true;
        }
    }

    public ServerSnapshot? Sample(double now)
    {
        lock (gate)
        {
        if (entries.Count == 0) return null;
        var newest = entries[^1];
        if (newest.MatchState == "finished") return newest;
        var target = newest.Tick + Math.Max(0, now - receivedAt) * 60 / 1000 - DelayTicks;
        if (entries.Count == 1 || target <= entries[0].Tick) return entries[0];
        if (target >= newest.Tick) return newest;
        var index = entries.FindIndex(snapshot => snapshot.Tick >= target);
        var older = entries[index - 1];
        var newer = entries[index];
        var amount = (float)(target - older.Tick) / (newer.Tick - older.Tick);
        if (older.Players.Length != newer.Players.Length || older.Players.Zip(newer.Players).Any(pair => pair.First.Id != pair.Second.Id)
            || older.Obstacles.Length != newer.Obstacles.Length || older.Obstacles.Zip(newer.Obstacles).Any(pair =>
                pair.First.Id != pair.Second.Id || pair.First.Kind != pair.Second.Kind || pair.First.Zone != pair.Second.Zone
                || pair.First.HalfExtent != pair.Second.HalfExtent)) return newer;
        var players = older.Players.Zip(newer.Players, (left, right) => new NetworkPlayer(
            right.Id, right.AcknowledgedInput, Mix(left.Position, right.Position, amount),
            Mix(left.Velocity, right.Velocity, amount), amount < .5f ? left.Grounded : right.Grounded)).ToArray();
        var obstacles = older.Obstacles.Zip(newer.Obstacles, (left, right) => right with
        {
            Position = Mix(left.Position, right.Position, amount),
            Rotation = Mix(left.Rotation, right.Rotation, amount)
        }).ToArray();
        return newer with { Tick = (long)target, TetherTension = Mix(older.TetherTension, newer.TetherTension, amount), Players = players, Obstacles = obstacles };
        }
    }

    private static VectorState Mix(VectorState left, VectorState right, float amount) => new(
        left.X + (right.X - left.X) * amount, left.Y + (right.Y - left.Y) * amount,
        left.Z + (right.Z - left.Z) * amount);
    private static float Mix(float left, float right, float amount) => left + (right - left) * amount;
}
