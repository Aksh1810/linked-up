using System.Numerics;
using BepuPhysics;
using BepuPhysics.Collidables;
using BepuUtilities.Memory;

namespace LinkedUp.Simulation;

// A match owns one instance and serializes calls; snapshots never expose physics memory.
public sealed class PrototypeSimulation : IDisposable
{
    private readonly Config config;
    private readonly RobotColor[] roster;
    private readonly BufferPool pool = new();
    private readonly BepuPhysics.Simulation physics;
    private readonly BodyHandle[] players;
    private readonly BodyHandle?[] obstacles;
    private readonly PlayerInput[] inputs;
    private readonly bool[] jumpConsumed;
    private readonly ulong?[] fallingStarted;
    private ulong tick, elapsedTicks, resetCount;
    private int checkpoint;
    private float tension;
    private MatchState matchState;
    private bool disposed;

    public PrototypeSimulation() : this([RobotColor.Blue, RobotColor.Orange], Routes.DefaultRouteConfig()) { }
    public PrototypeSimulation(IEnumerable<RobotColor> roster, Config? config = null)
    {
        ArgumentNullException.ThrowIfNull(roster);
        this.roster = roster.ToArray();
        if (this.roster.Length is < 2 or > 4 || this.roster.Any(c => !Enum.IsDefined(c)) || this.roster.Distinct().Count() != this.roster.Length)
            throw new ArgumentException("Roster must contain two to four distinct known colors.", nameof(roster));
        this.config = (config ?? new Config()).ValidatedCopy();
        physics = BepuPhysics.Simulation.Create(pool, new ContactCallbacks(), new GravityCallbacks(), new SolveDescription(8, 1));
        physics.Deterministic = true;
        var floorShape = physics.Shapes.Add(new Box(this.config.PlatformHalfExtent * 2, 1, this.config.PlatformHalfExtent * 2));
        physics.Statics.Add(new StaticDescription(new Vector3(0, -0.5f, 0), floorShape));
        var capsule = physics.Shapes.Add(new Capsule(0.4f, 1.2f));
        players = this.roster.Select((_, i) => physics.Bodies.Add(BodyDescription.CreateDynamic(new RigidPose(this.config.SpawnPositions[i].Vector), new BodyInertia { InverseMass = 1 }, new CollidableDescription(capsule, 0.01f), new BodyActivityDescription(-1)))).ToArray();
        inputs = new PlayerInput[players.Length];
        jumpConsumed = new bool[players.Length];
        fallingStarted = new ulong?[this.config.Obstacles.Count];
        obstacles = new BodyHandle?[this.config.Obstacles.Count];
        for (int i = 0; i < obstacles.Length; i++)
        {
            var o = this.config.Obstacles[i];
            if (o.Kind is ObstacleKind.Fan or ObstacleKind.Conveyor) continue;
            var shape = physics.Shapes.Add(new Box(o.HalfExtent.X * 2, o.HalfExtent.Y * 2, o.HalfExtent.Z * 2));
            if (o.Kind == ObstacleKind.StaticPlatform) physics.Statics.Add(new StaticDescription(o.Origin.Vector, shape));
            else obstacles[i] = physics.Bodies.Add(BodyDescription.CreateKinematic(new RigidPose(o.Origin.Vector), new CollidableDescription(shape, 0.01f), new BodyActivityDescription(-1)));
        }
    }

    private BodyReference Body(int i) => physics.Bodies[players[i]];
    private Vector3 Position(int i) => Body(i).Pose.Position;
    private Vector3 Velocity(int i) => Body(i).Velocity.Linear;
    private Vector3 ObstaclePosition(int i) => obstacles[i] is { } h ? physics.Bodies[h].Pose.Position : config.Obstacles[i].Origin.Vector;
    private static bool Platform(ObstacleKind kind) => kind is ObstacleKind.StaticPlatform or ObstacleKind.MovingPlatform or ObstacleKind.FallingPlatform;
    private void CheckDisposed() => ObjectDisposedException.ThrowIf(disposed, this);

    public void SetInput(RobotColor player, PlayerInput input)
    {
        CheckDisposed();
        int i = Array.IndexOf(roster, player);
        if (i < 0) throw new ArgumentException("Player is not in the roster.", nameof(player));
        if (!float.IsFinite(input.MoveX) || !float.IsFinite(input.MoveZ)) input = default;
        // Double avoids overflow when finite float inputs are close to their maximum.
        double length = Math.Sqrt((double)input.MoveX * input.MoveX + (double)input.MoveZ * input.MoveZ);
        if (length > 1) input = input with { MoveX = (float)(input.MoveX / length), MoveZ = (float)(input.MoveZ / length) };
        inputs[i] = input;
    }

    public void Step()
    {
        CheckDisposed();
        if (matchState == MatchState.Finished) return;
        float dt = 1 / config.TickRate;
        for (int i = 0; i < players.Length; i++)
        {
            Vector3 velocity = Velocity(i), target = new(inputs[i].MoveX * config.MoveSpeed, 0, inputs[i].MoveZ * config.MoveSpeed);
            var difference = new Vector3(target.X - velocity.X, 0, target.Z - velocity.Z);
            float maxChange = config.Acceleration * dt;
            if (difference.Length() > maxChange) difference = Vector3.Normalize(difference) * maxChange;
            velocity += difference;
            bool grounded = IsGrounded(i);
            if (inputs[i].Jump && grounded && !jumpConsumed[i]) { velocity.Y = config.JumpSpeed; jumpConsumed[i] = true; }
            else if (inputs[i].Jump && !grounded)
            {
                Vector3 anchor = default;
                int count = 0;
                for (int j = 0; j < players.Length; j++) if (j != i && IsGrounded(j)) { anchor += Position(j); count++; }
                if (count > 0)
                {
                    anchor /= count;
                    var towardAnchor = anchor - Position(i);
                    var ledge = LedgeReelTarget(Position(i), anchor);
                    var towardTarget = (ledge ?? anchor) - Position(i);
                    float distance = towardTarget.Length();
                    if ((towardAnchor.Length() > config.TetherSlackLength || ledge.HasValue) && towardAnchor.Y > 0.4f && distance > 0.0001f)
                    {
                        var direction = towardTarget / distance;
                        float reelSpeed = config.JumpSpeed * 0.75f, speed = Vector3.Dot(velocity, direction);
                        if (speed < reelSpeed) velocity += direction * (reelSpeed - speed);
                        if (ledge.HasValue && MathF.Abs(towardTarget.Y) < 0.001f) velocity.Y = MathF.Max(velocity.Y, 0);
                        jumpConsumed[i] = true;
                    }
                }
            }
            else if (!inputs[i].Jump && grounded) jumpConsumed[i] = false;
            Body(i).Velocity.Linear = velocity;
        }
        ApplyTether(dt);
        ApplyEnvironment(dt);
        for (int i = 0; i < obstacles.Length; i++)
        {
            var o = config.Obstacles[i];
            if (o.Kind == ObstacleKind.FallingPlatform && fallingStarted[i] is null && Enumerable.Range(0, players.Length).Any(p => OnPlatform(Position(p), o.Origin.Vector, o.HalfExtent))) fallingStarted[i] = elapsedTicks;
        }
        MoveObstacles(dt);
        physics.Timestep(dt);
        SettleClimbers();
        EnforceHardLimit();
        tick++; elapsedTicks++;
        var snapshot = Snapshot();
        if (snapshot.Players.Any(p => !p.Position.IsFinite || !p.Velocity.IsFinite)) throw new InvalidOperationException("Non-finite authoritative physics state.");
        if (snapshot.Players.All(p => p.Position.Y < config.FailHeight)) { Reset(); return; }
        for (int i = checkpoint; i < config.Checkpoints.Count; i++)
        {
            if (!snapshot.Players.Any(p => config.Checkpoints[i].Volume.Contains(p.Position))) break;
            checkpoint = i + 1;
        }
        if (snapshot.Players.All(p => config.Summit.Contains(p.Position))) matchState = MatchState.Finished;
    }

    public Snapshot Snapshot()
    {
        CheckDisposed();
        return new(tick, Array.AsReadOnly(Enumerable.Range(0, players.Length).Select(i => new PlayerState(roster[i], Vec3.From(Position(i)), Vec3.From(Velocity(i)), IsGrounded(i))).ToArray()), tension, resetCount, elapsedTicks, checkpoint, matchState, Array.AsReadOnly(ObstacleStates()));
    }

    public void Reset()
    {
        CheckDisposed();
        var spawns = checkpoint == 0 ? config.SpawnPositions : config.Checkpoints[checkpoint - 1].SpawnPositions;
        for (int i = 0; i < players.Length; i++)
        {
            var body = Body(i); body.Pose = new RigidPose(spawns[i].Vector); body.Velocity = default; body.Awake = true; body.UpdateBounds();
        }
        Array.Clear(inputs); Array.Clear(jumpConsumed); Array.Clear(fallingStarted);
        tick = 0; tension = 0; resetCount++;
        // Immediately synchronize colliders with reset snapshots, including re-armed falling platforms.
        var states = ObstacleStates();
        for (int i = 0; i < obstacles.Length; i++) if (obstacles[i] is { } h)
        {
            var body = physics.Bodies[h]; body.Pose = new RigidPose(states[i].Position.Vector, Rotation(states[i])); body.Velocity = default; body.Awake = true; body.UpdateBounds();
        }
    }

    private static bool OnPlatform(Vector3 p, Vector3 center, Vec3 half) => MathF.Abs(p.Y - (center.Y + half.Y + 1)) <= 0.08f && MathF.Abs(p.X - center.X) <= half.X + 0.4f && MathF.Abs(p.Z - center.Z) <= half.Z + 0.4f;
    private bool IsGrounded(int i)
    {
        var p = Position(i);
        if (Velocity(i).Y > 0.2f) return false;
        if (p.Y <= 1.08f && MathF.Abs(p.X) <= config.PlatformHalfExtent + 0.4f && MathF.Abs(p.Z) <= config.PlatformHalfExtent + 0.4f) return true;
        for (int j = 0; j < obstacles.Length; j++) if (Platform(config.Obstacles[j].Kind) && OnPlatform(p, ObstaclePosition(j), config.Obstacles[j].HalfExtent)) return true;
        return false;
    }

    private Vector3? LedgeReelTarget(Vector3 player, Vector3 anchor)
    {
        Vector3? ForPlatform(Vector3 center, Vec3 half)
        {
            float top = center.Y + half.Y;
            if (MathF.Abs(anchor.Y - (top + 1)) > 0.12f || MathF.Abs(anchor.X - center.X) > half.X + 0.4f || MathF.Abs(anchor.Z - center.Z) > half.Z + 0.4f) return null;
            float[] edges = [center.X - half.X - 0.52f, center.X + half.X + 0.52f, center.Z - half.Z - 0.52f, center.Z + half.Z + 0.52f];
            float[] distances = [MathF.Abs(player.X - edges[0]), MathF.Abs(player.X - edges[1]), MathF.Abs(player.Z - edges[2]), MathF.Abs(player.Z - edges[3])];
            int side = Array.IndexOf(distances, distances.Min());
            var lip = player;
            if (side < 2) lip.X = edges[side]; else lip.Z = edges[side];
            bool outside = side switch { 0 => player.X <= edges[0] + 0.02f, 1 => player.X >= edges[1] - 0.02f, 2 => player.Z <= edges[2] + 0.02f, _ => player.Z >= edges[3] - 0.02f };
            if (player.Y < top + 1.08f) { if (outside) lip.Y = top + 1.08f; return lip; }
            return MathF.Abs(player.X - center.X) <= half.X + 0.4f && MathF.Abs(player.Z - center.Z) <= half.Z + 0.4f ? null : anchor;
        }
        var target = ForPlatform(new(0, -0.5f, 0), new(config.PlatformHalfExtent, 0.5f, config.PlatformHalfExtent));
        if (target.HasValue) return target;
        for (int i = 0; i < obstacles.Length; i++) if (Platform(config.Obstacles[i].Kind))
        {
            target = ForPlatform(ObstaclePosition(i), config.Obstacles[i].HalfExtent);
            if (target.HasValue) return target;
        }
        return null;
    }

    private void SettleClimbers()
    {
        for (int i = 0; i < players.Length; i++)
        {
            if (!inputs[i].Jump || IsGrounded(i)) continue;
            for (int j = 0; j < obstacles.Length; j++)
            {
                var obstacle = config.Obstacles[j];
                if (!Platform(obstacle.Kind)) continue;
                var center = ObstaclePosition(j); var half = obstacle.HalfExtent; var top = center.Y + half.Y;
                if (!Enumerable.Range(0, players.Length).Any(other => other != i && IsGrounded(other)
                    && MathF.Abs(Position(other).Y - (top + 1)) <= .12f
                    && MathF.Abs(Position(other).X - center.X) <= half.X + .4f
                    && MathF.Abs(Position(other).Z - center.Z) <= half.Z + .4f)) continue;
                var position = Position(i);
                if (Velocity(i).Y > .2f || position.Y < top + .75f || position.Y > top + 1.4f
                    || MathF.Abs(position.X - center.X) > half.X + .85f
                    || MathF.Abs(position.Z - center.Z) > half.Z + .85f) continue;
                position.X = Math.Clamp(position.X, center.X - half.X + .25f, center.X + half.X - .25f);
                position.Z = Math.Clamp(position.Z, center.Z - half.Z + .25f, center.Z + half.Z - .25f);
                position.Y = top + 1.01f;
                var body = Body(i); body.Pose.Position = position; body.Velocity.Linear = new Vector3(body.Velocity.Linear.X, 0, body.Velocity.Linear.Z); body.UpdateBounds();
                break;
            }
        }
    }

    private void ApplyTether(float dt)
    {
        tension = 0;
        var positions = Enumerable.Range(0, players.Length).Select(Position).ToArray();
        var velocities = Enumerable.Range(0, players.Length).Select(Velocity).ToArray();
        for (int i = 0; i < players.Length; i++)
        {
            Vector3 average = default, averageVelocity = default;
            for (int j = 0; j < players.Length; j++) if (i != j) { average += positions[j]; averageVelocity += velocities[j]; }
            average /= players.Length - 1; averageVelocity /= players.Length - 1;
            var inward = average - positions[i]; float distance = inward.Length();
            if (distance <= config.TetherSlackLength || distance < 0.0001f) continue;
            var direction = inward / distance;
            float outwardSpeed = Vector3.Dot(velocities[i] - averageVelocity, -direction);
            float force = Math.Clamp(config.TetherStiffness * (distance - config.TetherSlackLength) + config.TetherDamping * outwardSpeed, 0, config.TetherMaxForce);
            Body(i).Velocity.Linear += direction * force * dt;
            tension = MathF.Max(tension, force / config.TetherMaxForce);
        }
    }

    private void EnforceHardLimit()
    {
        var positions = Enumerable.Range(0, players.Length).Select(Position).ToArray();
        var velocities = Enumerable.Range(0, players.Length).Select(Velocity).ToArray();
        for (int i = 0; i < players.Length; i++)
        {
            Vector3 average = default;
            for (int j = 0; j < players.Length; j++) if (i != j) average += positions[j];
            average /= players.Length - 1;
            var inward = average - positions[i]; float distance = inward.Length();
            if (distance <= config.TetherHardLength || distance < 0.0001f) continue;
            var direction = inward / distance; var velocity = velocities[i];
            float outwardSpeed = Vector3.Dot(velocity, -direction);
            if (outwardSpeed > 0) velocity += direction * outwardSpeed;
            var body = Body(i); body.Pose.Position = positions[i] + direction * (distance - config.TetherHardLength); body.Velocity.Linear = velocity; body.UpdateBounds();
        }
    }

    private void ApplyEnvironment(float dt)
    {
        foreach (var o in config.Obstacles)
        {
            if (o.Kind is not (ObstacleKind.Fan or ObstacleKind.Conveyor)) continue;
            var direction = new Vector3(o.Travel.X, 0, o.Travel.Z);
            float length = direction.Length();
            if (length < 0.0001f || o.Amplitude == 0) continue;
            direction /= length;
            var volume = new BoxVolume(o.Origin, o.HalfExtent);
            for (int i = 0; i < players.Length; i++) if (volume.Contains(Vec3.From(Position(i))) && (o.Kind == ObstacleKind.Fan || IsGrounded(i))) Body(i).Velocity.Linear += direction * o.Amplitude * dt;
        }
    }

    private DynamicObstacleState[] ObstacleStates()
    {
        var states = new DynamicObstacleState[obstacles.Length];
        for (int i = 0; i < states.Length; i++)
        {
            var o = config.Obstacles[i]; var p = o.Origin.Vector; Vector3 rotation = default; var phase = ObstaclePhase.Armed;
            float cycle = ((float)elapsedTicks / o.PeriodTicks) % 1;
            switch (o.Kind)
            {
                case ObstacleKind.MovingPlatform:
                    float leg = ((float)elapsedTicks / o.PeriodTicks) % 2;
                    p += o.Travel.Vector * (leg <= 1 ? leg : 2 - leg); break;
                case ObstacleKind.RotatingBeam: rotation.Y = 2 * MathF.PI * cycle; break;
                case ObstacleKind.SwingingBeam: rotation.Z = MathF.Sin(2 * MathF.PI * cycle) * o.Amplitude; p.X += rotation.Z; break;
                case ObstacleKind.Fan:
                case ObstacleKind.Conveyor: rotation.Y = MathF.Atan2(o.Travel.X, o.Travel.Z); break;
                case ObstacleKind.FallingPlatform:
                    if (fallingStarted[i] is { } started)
                    {
                        ulong elapsed = elapsedTicks - started;
                        phase = elapsed < (ulong)o.PeriodTicks ? ObstaclePhase.Warning : ObstaclePhase.Falling;
                        if (phase == ObstaclePhase.Falling) p.Y -= o.Amplitude * (elapsed - (ulong)o.PeriodTicks) / config.TickRate;
                    }
                    break;
            }
            states[i] = new(o.Id, o.Kind, Vec3.From(p), Vec3.From(rotation), o.HalfExtent, o.Zone, phase);
        }
        return states;
    }

    // Preserve the native collider's yaw-only orientation (swing roll is presentation state).
    private static Quaternion Rotation(DynamicObstacleState state) => Quaternion.CreateFromAxisAngle(Vector3.UnitY, state.Rotation.Y);
    private void MoveObstacles(float dt)
    {
        var states = ObstacleStates();
        for (int i = 0; i < obstacles.Length; i++) if (obstacles[i] is { } h)
        {
            var body = physics.Bodies[h]; var target = states[i];
            body.Velocity.Linear = (target.Position.Vector - body.Pose.Position) / dt;
            var delta = Quaternion.Normalize(Rotation(target) * Quaternion.Conjugate(body.Pose.Orientation));
            if (delta.W < 0) delta = new(-delta.X, -delta.Y, -delta.Z, -delta.W);
            var axis = new Vector3(delta.X, delta.Y, delta.Z); float length = axis.Length();
            body.Velocity.Angular = length > 0.000001f ? axis / length * (2 * MathF.Atan2(length, delta.W) / dt) : default;
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        physics.Dispose(); pool.Clear(); disposed = true;
    }
}
