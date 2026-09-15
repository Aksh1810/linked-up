using System.Numerics;
using LinkedUp.Simulation;

public class SimulationTests
{
    private static readonly RobotColor[] Colors = Enum.GetValues<RobotColor>();
    private static Vec3[] Spawns(Vec3 a, Vec3 b) => [a, b, new(-3, 1.5f, 0), new(3, 1.5f, 0)];
    private static PrototypeSimulation Create(Config? c = null) => new(Colors.Take(2), c);
    private static Vector3 V(Vec3 v) => new(v.X, v.Y, v.Z);
    private static void Steps(PrototypeSimulation sim, int n) { for (int i = 0; i < n; i++) sim.Step(); }
    private static bool Until(PrototypeSimulation sim, int n, Func<Snapshot, bool> condition)
    {
        for (int i = 0; i < n; i++) { sim.Step(); if (condition(sim.Snapshot())) return true; }
        return false;
    }

    [Theory]
    [InlineData("classic-ascent", 35)] [InlineData("relay-ridge", 34)] [InlineData("crane-shift", 36)] [InlineData("windworks", 35)]
    public void MapsAndEveryRosterAreDeterministic(string map, int count)
    {
        var config = Routes.RouteConfig(map);
        Assert.Equal(count, config.Obstacles.Count);
        Assert.Equal(4, config.Checkpoints.Count);
        Assert.Equal(5, config.Obstacles.Select(o => o.Zone).Distinct().Count());
        Assert.Equal(count, config.Obstacles.Select(o => o.Id).Distinct().Count());
        foreach (int size in new[] { 2, 3, 4 })
        {
            using var a = new PrototypeSimulation(Colors.Take(size), config);
            using var b = new PrototypeSimulation(Colors.Take(size), config);
            for (int t = 0; t < 240; t++)
            {
                for (int p = 0; p < size; p++)
                {
                    var input = new PlayerInput((t / 60 + p) % 3 - 1, (t / 45 + p * 2) % 3 - 1, t % 90 == p);
                    a.SetInput(Colors[p], input); b.SetInput(Colors[p], input);
                }
                a.Step(); b.Step();
                Assert.Equal(a.Snapshot().Players, b.Snapshot().Players);
                Assert.All(a.Snapshot().Players, p => Assert.True(float.IsFinite(p.Position.Y)));
            }
            Assert.Equal(Colors.Take(size), a.Snapshot().Players.Select(p => p.Id));
        }
    }

    [Fact] public void MovementJumpAndHeldJump()
    {
        using var sim = Create(); Steps(sim, 90);
        float start = sim.Snapshot().Players[0].Position.X;
        sim.SetInput(RobotColor.Blue, new(1, 0, false)); Steps(sim, 30);
        Assert.True(sim.Snapshot().Players[0].Position.X > start + 0.2f);
        sim.SetInput(RobotColor.Blue, new(0, 0, true)); sim.Step();
        Assert.True(sim.Snapshot().Players[0].Velocity.Y > 1);
        Steps(sim, 150);
        Assert.True(sim.Snapshot().Players[0].Grounded);
        sim.Step(); Assert.True(sim.Snapshot().Players[0].Velocity.Y < 0.2f);
    }

    [Fact] public void ElevatedJumpAndOpeningLedgeAreReachable()
    {
        using var elevated = Create(new Config { SpawnPositions = Spawns(new(-1, 4.4f, 0), new(1, 4.4f, 0)), Obstacles = [new("ledge", ObstacleKind.StaticPlatform, new(0, 3, 0), new(4, 0.4f, 4))] });
        elevated.SetInput(RobotColor.Blue, new(0, 0, true)); elevated.Step(); Assert.True(elevated.Snapshot().Players[0].Velocity.Y > 1);
        using var sim = new PrototypeSimulation(); Steps(sim, 90); sim.SetInput(RobotColor.Blue, new(0, 0, true));
        float apex = 0;
        for (int i = 0; i < 90; i++) { sim.Step(); apex = Math.Max(apex, sim.Snapshot().Players[0].Position.Y); }
        // Bepu settles on the opening ledge slightly earlier than Jolt; it must still clear its top.
        Assert.True(apex >= 3.1f, $"apex {apex}");
    }

    [Fact] public void TetherCapsDistanceAndPullsOutlier()
    {
        using var sim = Create(new Config { PlatformHalfExtent = 20, TetherSlackLength = 2, TetherHardLength = 5 });
        sim.SetInput(RobotColor.Blue, new(-1, 0, false)); sim.SetInput(RobotColor.Orange, new(1, 0, false));
        for (int i = 0; i < 600; i++) { sim.Step(); var s = sim.Snapshot(); Assert.True(Vector3.Distance(V(s.Players[0].Position), V(s.Players[1].Position)) <= 5.02f); }
        using var group = new PrototypeSimulation(Colors.Take(3), new Config { PlatformHalfExtent = 20, TetherSlackLength = 1 });
        group.SetInput(RobotColor.Green, new(-1, 0, false)); Steps(group, 360);
        var state = group.Snapshot();
        Assert.True(Vector3.Distance(V(state.Players[2].Position), (V(state.Players[0].Position) + V(state.Players[1].Position)) / 2) < 3);
        Assert.True(state.TetherTension > 0);
    }

    [Fact] public void FallenPlayerPullsTeammateButDoesNotResetAlone()
    {
        using var pulling = Create(new Config { PlatformHalfExtent = 2, SpawnPositions = Spawns(new(0, 1.5f, 0), new(1.5f, 1.5f, 0)), TetherSlackLength = 1, TetherHardLength = 6 });
        pulling.SetInput(RobotColor.Orange, new(1, 0, false));
        Assert.True(Until(pulling, 360, s => !s.Players[1].Grounded && s.Players[1].Position.Y < 0.8f && Vector3.Dot(V(s.Players[0].Velocity), V(s.Players[1].Position) - V(s.Players[0].Position)) > 0.05f));
        using var sim = Create(new Config { PlatformHalfExtent = 2, SpawnPositions = Spawns(new(0, 1.5f, 0), new(1.5f, 1.5f, 0)), FailHeight = 0 });
        sim.SetInput(RobotColor.Orange, new(1, 0, false));
        Assert.True(Until(sim, 240, s => s.Players[1].Position.Y < 0));
        Assert.Equal(0ul, sim.Snapshot().ResetCount); Assert.True(sim.Snapshot().Players[0].Grounded);
    }

    [Fact] public void HangingPlayerCanReelAndClearOverheadLedge()
    {
        var config = new Config { PlatformHalfExtent = 20, SpawnPositions = Spawns(new(18, 1.5f, 0), new(20.4f, 1.5f, 0)), FailHeight = -100 };
        using var climbing = Create(config); using var control = Create(config);
        foreach (var sim in new[] { climbing, control }) { sim.SetInput(RobotColor.Blue, new(-1, 0, false)); sim.SetInput(RobotColor.Orange, new(1, 0, false)); }
        bool hanging = false;
        for (int t = 0; t < 240 && !hanging; t++) { climbing.Step(); control.Step(); var s = climbing.Snapshot(); hanging = s.Players[0].Grounded && !s.Players[1].Grounded && s.Players[1].Position.Y < 0.5f; }
        Assert.True(hanging);
        climbing.SetInput(RobotColor.Orange, new(-1, 0, true)); control.SetInput(RobotColor.Orange, new(-1, 0, false)); climbing.Step(); control.Step();
        Assert.True(climbing.Snapshot().Players[1].Velocity.Y > control.Snapshot().Players[1].Velocity.Y + 0.5f);
        Assert.True(Until(climbing, 240, s => s.Players[1].Grounded));
        using var ledge = Create(new Config { PlatformHalfExtent = 0.5f, Obstacles = [new("ledge", ObstacleKind.StaticPlatform, new(0, 4, 0), new(3, 0.5f, 3))], SpawnPositions = Spawns(new(0, 5.5f, 0), new(2.5f, 2.5f, 0)), FailHeight = -100 });
        ledge.SetInput(RobotColor.Orange, new(0, 0, true));
        var trace = new List<string>();
        Assert.True(Until(ledge, 360, s => { if (s.Tick % 30 == 0) trace.Add($"{s.Tick}: {string.Join(';', s.Players)}"); return s.Players[1].Grounded && s.Players[1].Position.Y > 4.5f; }), string.Join('\n', trace));
    }

    [Fact] public void FallingTeamCannotReelAndFullFallResets()
    {
        var config = new Config { PlatformHalfExtent = 2, SpawnPositions = Spawns(new(0.5f, 1.5f, 0), new(1.5f, 1.5f, 0)), FailHeight = -100 };
        using var a = Create(config); using var b = Create(config);
        foreach (var sim in new[] { a, b }) foreach (var color in Colors.Take(2)) sim.SetInput(color, new(1, 0, false));
        bool falling = false;
        for (int t = 0; t < 240 && !falling; t++) { a.Step(); b.Step(); falling = a.Snapshot().Players.All(p => !p.Grounded && p.Position.Y < 0.8f); }
        Assert.True(falling);
        foreach (var color in Colors.Take(2)) { a.SetInput(color, new(0, 0, true)); b.SetInput(color, default); }
        a.Step(); b.Step();
        Assert.Equal(a.Snapshot().Players, b.Snapshot().Players);
        using var reset = Create(new Config { PlatformHalfExtent = 2, SpawnPositions = Spawns(new(-1.5f, 1.5f, 0), new(1.5f, 1.5f, 0)), FailHeight = 0 });
        reset.SetInput(RobotColor.Blue, new(-1, 0, false)); reset.SetInput(RobotColor.Orange, new(1, 0, false));
        Assert.True(Until(reset, 300, s => s.ResetCount == 1));
    }

    [Fact] public void ProgressResetAndFinish()
    {
        var config = new Config { Checkpoints = [new(new(new(0, 1.5f, 0), new(5, 1, 5)), Spawns(new(-2, 2, 0), new(2, 2, 0)))] };
        using var sim = Create(config); sim.Step(); Assert.Equal(1, sim.Snapshot().Checkpoint);
        var elapsed = sim.Snapshot().ElapsedTicks; sim.Reset();
        var reset = sim.Snapshot(); Assert.Equal(0ul, reset.Tick); Assert.Equal(elapsed, reset.ElapsedTicks); Assert.Equal(1ul, reset.ResetCount); Assert.Equal(0, reset.TetherTension);
        Assert.Equal(config.Checkpoints[0].SpawnPositions[0], reset.Players[0].Position); Assert.Equal(default, reset.Players[0].Velocity);
        using var finish = Create(config with { Summit = new(new(0, 1.5f, 0), new(5, 1, 5)) });
        finish.Step(); Assert.Equal(MatchState.Finished, finish.Snapshot().MatchState); finish.Step(); Assert.Equal(1ul, finish.Snapshot().ElapsedTicks);
    }

    [Fact] public void KinematicPathsReversalAndFallingLifecycle()
    {
        using var sim = Create(new Config { Obstacles = [new("lift", ObstacleKind.MovingPlatform, new(0, 1, 0), new(1, 0.2f, 1), new(0, 4, 0), 120), new("beam", ObstacleKind.RotatingBeam, new(3, 1, 0), new(2, 0.2f, 0.2f), default, 120), new("swing", ObstacleKind.SwingingBeam, new(10, 1, 0), new(2, 0.2f, 0.2f), default, 120, 1)] });
        Steps(sim, 30); var s = sim.Snapshot(); Assert.Equal(2, s.Obstacles[0].Position.Y, 3); Assert.Equal(MathF.PI / 2, s.Obstacles[1].Rotation.Y, 3); Assert.Equal(11, s.Obstacles[2].Position.X, 3); Assert.Equal(1, s.Obstacles[2].Rotation.Z, 3);
        Steps(sim, 89); float before = sim.Snapshot().Obstacles[0].Position.Y; sim.Step(); Assert.InRange(MathF.Abs(sim.Snapshot().Obstacles[0].Position.Y - before), 0, 0.05f);
        using var fall = Create(new Config { Obstacles = [new("fall", ObstacleKind.FallingPlatform, new(0, 3, 0), new(2, 0.3f, 2), default, 3, 6)], SpawnPositions = Spawns(new(-1, 4.3f, 0), new(1, 4.3f, 0)) });
        fall.Step(); Assert.Equal(ObstaclePhase.Warning, fall.Snapshot().Obstacles[0].Phase); Steps(fall, 4);
        Assert.Equal(ObstaclePhase.Falling, fall.Snapshot().Obstacles[0].Phase); Assert.True(fall.Snapshot().Obstacles[0].Position.Y < 3);
        fall.Reset(); Assert.Equal(ObstaclePhase.Armed, fall.Snapshot().Obstacles[0].Phase); Assert.Equal(3, fall.Snapshot().Obstacles[0].Position.Y);
    }

    [Theory] [InlineData(ObstacleKind.Fan)] [InlineData(ObstacleKind.Conveyor)]
    public void ForcesAreVolumeBound(ObstacleKind kind)
    {
        var config = new Config { Acceleration = 0, Obstacles = [new("force", kind, new(-1, 1.5f, 0), new(0.6f, 2, 1), new(1, 0, 0), 60, 30)] };
        using var sim = Create(config); Steps(sim, 90); sim.Reset(); Steps(sim, 30);
        Assert.True(sim.Snapshot().Players[0].Position.X > -0.9f); Assert.InRange(MathF.Abs(sim.Snapshot().Players[1].Velocity.X), 0, 0.01f);
        Assert.Equal(MathF.PI / 2, sim.Snapshot().Obstacles[0].Rotation.Y, 3);
    }

    [Fact] public void InputsConfigurationAndSnapshotsAreIsolated()
    {
        using var sim = Create(); sim.SetInput(RobotColor.Blue, new(float.NaN, float.PositiveInfinity, true)); Steps(sim, 120);
        Assert.InRange(MathF.Abs(sim.Snapshot().Players[0].Velocity.X), 0, 0.05f);
        Assert.Throws<ArgumentException>(() => sim.SetInput(RobotColor.Green, default));
        var old = sim.Snapshot(); sim.SetInput(RobotColor.Blue, new(float.MaxValue, float.MaxValue, false)); Steps(sim, 20); Assert.NotEqual(old.Players[0].Position, sim.Snapshot().Players[0].Position);
        Assert.Throws<NotSupportedException>(() => ((IList<PlayerState>)old.Players)[0] = default);
        var spawns = Spawns(new(-1, 1.5f, 0), new(1, 1.5f, 0)); using var isolated = Create(new Config { SpawnPositions = spawns }); spawns[0] = new(99, 99, 99); isolated.Reset(); Assert.Equal(-1, isolated.Snapshot().Players[0].Position.X);
        foreach (RobotColor[] roster in new RobotColor[][] { [], [RobotColor.Blue], [RobotColor.Blue, RobotColor.Blue], [RobotColor.Blue, (RobotColor)99], [.. Colors, RobotColor.Blue] }) Assert.Throws<ArgumentException>(() => new PrototypeSimulation(roster));
        foreach (var config in new[] { new Config { TickRate = 0 }, new Config { MoveSpeed = float.NaN }, new Config { TetherHardLength = 4 }, new Config { SpawnPositions = [] }, new Config { Obstacles = [new("x", (ObstacleKind)99, default, new(1, 1, 1))] }, new Config { Obstacles = [new("x", ObstacleKind.Fan, default, new(1, 1, 1)), new("x", ObstacleKind.Fan, default, new(1, 1, 1))] }, new Config { Summit = new(default, new(-1, 0, 0)) } }) Assert.Throws<ArgumentException>(() => Create(config));
        Assert.Throws<ArgumentException>(() => Routes.RouteConfig("unknown"));
    }
}
