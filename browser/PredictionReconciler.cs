using System.Numerics;
using LinkedUp.Contracts;

namespace LinkedUp.Client;

public sealed class PredictionReconciler(string player)
{
    private readonly object gate = new();
    private readonly List<ClientInput> pending = [];
    private NetworkPlayer? predicted;
    private Vector3 correction;
    private long? reset;
    private bool overflow;

    public void Record(ClientInput input)
    {
        lock (gate)
        {
            if (overflow || input.Sequence <= (predicted?.AcknowledgedInput ?? 0)) return;
            pending.Add(input);
            if (pending.Count > 240) { pending.Clear(); overflow = true; return; }
            Step(input);
        }
    }

    public void Reconcile(ServerSnapshot snapshot)
    {
        lock (gate)
        {
            var authoritative = snapshot.Players.Single(value => value.Id == player);
            var changed = reset is not null && reset != snapshot.ResetCount;
            reset = snapshot.ResetCount;
            if (changed || overflow || snapshot.MatchState == "finished")
            {
                pending.Clear(); overflow = false; correction = default; predicted = authoritative;
                return;
            }
            Vector3? old = predicted is null ? null : Vector(predicted.Position) + correction;
            pending.RemoveAll(input => input.Sequence <= authoritative.AcknowledgedInput);
            predicted = authoritative;
            foreach (var input in pending) Step(input);
            correction = old is { } position ? position - Vector(predicted.Position) : default;
            if (correction.Length() > 2) correction = default;
        }
    }

    public NetworkPlayer? Render(double deltaMs)
    {
        lock (gate)
        {
            if (predicted is null) return null;
            if (double.IsFinite(deltaMs) && deltaMs > 0) correction *= (float)Math.Pow(.5, deltaMs / 80);
            return predicted with { Position = State(Vector(predicted.Position) + correction) };
        }
    }

    private void Step(ClientInput input)
    {
        if (predicted is null) return;
        const float delta = 1f / 60;
        var velocity = Vector(predicted.Velocity);
        var change = new Vector2(input.MoveX * 6 - velocity.X, input.MoveZ * 6 - velocity.Z);
        if (change.Length() > 30 * delta) change = Vector2.Normalize(change) * (30 * delta);
        velocity.X += change.X; velocity.Z += change.Y;
        var grounded = predicted.Grounded;
        if (input.Jump && grounded) { velocity.Y = 7; grounded = false; }
        if (!grounded) velocity.Y -= 9.81f * delta;
        // Prediction covers free motion only; snapshots correct collisions, tether and moving platforms.
        predicted = predicted with { Position = State(Vector(predicted.Position) + velocity * delta), Velocity = State(velocity), Grounded = grounded };
    }

    private static Vector3 Vector(VectorState value) => new(value.X, value.Y, value.Z);
    private static VectorState State(Vector3 value) => new(value.X, value.Y, value.Z);
}
