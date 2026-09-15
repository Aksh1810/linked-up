using System.Numerics;

namespace LinkedUp.Simulation;

public enum RobotColor { Blue, Orange, Green, Purple }
public enum MatchState { Running, Finished }
public enum Zone { Grass, Construction, Industrial, Sky, Summit }
public enum ObstacleKind { StaticPlatform, MovingPlatform, RotatingBeam, SwingingBeam, Fan, Conveyor, FallingPlatform }
public enum ObstaclePhase { Armed, Warning, Falling }
public readonly record struct Vec3(float X, float Y, float Z)
{
    internal Vector3 Vector => new(X, Y, Z);
    internal static Vec3 From(Vector3 v) => new(v.X, v.Y, v.Z);
    internal bool IsFinite => float.IsFinite(X) && float.IsFinite(Y) && float.IsFinite(Z);
}
public readonly record struct BoxVolume(Vec3 Center, Vec3 HalfExtent)
{
    internal bool Contains(Vec3 p) => MathF.Abs(p.X - Center.X) <= HalfExtent.X && MathF.Abs(p.Y - Center.Y) <= HalfExtent.Y && MathF.Abs(p.Z - Center.Z) <= HalfExtent.Z;
    internal bool IsValid => Center.IsFinite && HalfExtent.IsFinite && HalfExtent.X >= 0 && HalfExtent.Y >= 0 && HalfExtent.Z >= 0;
}
public sealed record Checkpoint(BoxVolume Volume, IReadOnlyList<Vec3> SpawnPositions);
public sealed record ObstacleConfig(string Id, ObstacleKind Kind, Vec3 Origin, Vec3 HalfExtent, Vec3 Travel = default, float PeriodTicks = 60, float Amplitude = 0, Zone Zone = Zone.Grass);
public sealed record DynamicObstacleState(string Id, ObstacleKind Kind, Vec3 Position, Vec3 Rotation, Vec3 HalfExtent, Zone Zone, ObstaclePhase Phase = ObstaclePhase.Armed);
public readonly record struct PlayerInput(float MoveX, float MoveZ, bool Jump);
public readonly record struct PlayerState(RobotColor Id, Vec3 Position, Vec3 Velocity, bool Grounded);
public sealed record Snapshot(ulong Tick, IReadOnlyList<PlayerState> Players, float TetherTension, ulong ResetCount, ulong ElapsedTicks, int Checkpoint, MatchState MatchState, IReadOnlyList<DynamicObstacleState> Obstacles);

public sealed record Config
{
    public float TickRate { get; init; } = 60;
    public float MoveSpeed { get; init; } = 6;
    public float Acceleration { get; init; } = 30;
    public float JumpSpeed { get; init; } = 7;
    public float PlatformHalfExtent { get; init; } = 5;
    public IReadOnlyList<Vec3> SpawnPositions { get; init; } = Array.AsReadOnly(new Vec3[] { new(-1, 1.5f, 0), new(1, 1.5f, 0), new(-3, 1.5f, 0), new(3, 1.5f, 0) });
    public float TetherSlackLength { get; init; } = 4;
    public float TetherHardLength { get; init; } = 7;
    public float TetherStiffness { get; init; } = 45;
    public float TetherDamping { get; init; } = 8;
    public float TetherMaxForce { get; init; } = 120;
    public float FailHeight { get; init; } = -12;
    public IReadOnlyList<Checkpoint> Checkpoints { get; init; } = Array.Empty<Checkpoint>();
    public BoxVolume Summit { get; init; } = new(new(0, 1000, 0), default);
    public IReadOnlyList<ObstacleConfig> Obstacles { get; init; } = Array.Empty<ObstacleConfig>();

    internal Config ValidatedCopy()
    {
        float[] values = [TickRate, MoveSpeed, Acceleration, JumpSpeed, PlatformHalfExtent, TetherSlackLength, TetherHardLength, TetherStiffness, TetherDamping, TetherMaxForce, FailHeight];
        static bool SpawnsValid(IReadOnlyList<Vec3>? spawns) => spawns is { Count: 4 } && spawns.All(p => p.IsFinite);
        if (!values.All(float.IsFinite) || TickRate <= 0 || MoveSpeed < 0 || Acceleration < 0 || JumpSpeed < 0 || PlatformHalfExtent <= 0 || TetherSlackLength < 0 || TetherHardLength <= TetherSlackLength || TetherStiffness < 0 || TetherDamping < 0 || TetherMaxForce <= 0 || !SpawnsValid(SpawnPositions))
            throw new ArgumentException("Invalid simulation configuration.");
        if (!Summit.IsValid || Checkpoints is null || Checkpoints.Any(c => c is null || !c.Volume.IsValid || !SpawnsValid(c.SpawnPositions)))
            throw new ArgumentException("Invalid progression configuration.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (Obstacles is null || Obstacles.Any(o => o is null || string.IsNullOrEmpty(o.Id) || !ids.Add(o.Id) || !Enum.IsDefined(o.Kind) || !Enum.IsDefined(o.Zone) || !o.Origin.IsFinite || !o.HalfExtent.IsFinite || !o.Travel.IsFinite || o.HalfExtent.X <= 0 || o.HalfExtent.Y <= 0 || o.HalfExtent.Z <= 0 || !float.IsFinite(o.PeriodTicks) || o.PeriodTicks <= 0 || !float.IsFinite(o.Amplitude) || o.Amplitude < 0))
            throw new ArgumentException("Invalid obstacle configuration.");
        return this with { SpawnPositions = Array.AsReadOnly(SpawnPositions.ToArray()), Checkpoints = Array.AsReadOnly(Checkpoints.Select(c => c with { SpawnPositions = Array.AsReadOnly(c.SpawnPositions.ToArray()) }).ToArray()), Obstacles = Array.AsReadOnly(Obstacles.ToArray()) };
    }
}
