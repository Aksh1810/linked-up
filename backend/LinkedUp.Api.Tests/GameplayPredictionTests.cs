using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameplayPredictionTests
{
    [Fact]
    public void Predicts_immediate_movement_then_replays_only_unacknowledged_input()
    {
        var predictor = new PredictionReconciler("blue");
        predictor.Reconcile(Snapshot(0, 0));
        predictor.Record(Input(1));
        predictor.Record(Input(2));
        Assert.True(predictor.Render(0)!.Position.X > 0);
        predictor.Reconcile(Snapshot(0, 1));
        Assert.Equal(.5f / 60, predictor.Render(10000)!.Position.X, 5);
    }

    [Fact]
    public void Small_corrections_blend_but_resets_and_finished_positions_snap()
    {
        var predictor = new PredictionReconciler("blue");
        predictor.Reconcile(Snapshot(0, 0));
        predictor.Reconcile(Snapshot(.2f, 0));
        Assert.Equal(0, predictor.Render(0)!.Position.X);
        Assert.Equal(.1f, predictor.Render(80)!.Position.X, 5);
        predictor.Record(Input(1));
        predictor.Reconcile(Snapshot(5, 0) with { ResetCount = 1 });
        Assert.Equal(5, predictor.Render(0)!.Position.X);
        predictor.Reconcile(Snapshot(5.2f, 1) with { ResetCount = 1, MatchState = "finished" });
        Assert.Equal(5.2f, predictor.Render(0)!.Position.X);
    }

    [Fact]
    public void Jump_is_immediate_and_pending_input_is_bounded()
    {
        var predictor = new PredictionReconciler("blue");
        predictor.Reconcile(Snapshot(0, 0));
        predictor.Record(Input(1) with { Jump = true });
        Assert.True(predictor.Render(0)!.Position.Y > 1);
        Assert.False(predictor.Render(0)!.Grounded);
        for (var sequence = 2; sequence <= 242; sequence++) predictor.Record(Input(sequence));
        predictor.Reconcile(Snapshot(8, 1));
        Assert.Equal(8, predictor.Render(0)!.Position.X);
    }

    private static ClientInput Input(long sequence) => new("input", sequence, sequence, 1, 0, false);
    private static ServerSnapshot Snapshot(float x, long ack) => new(100, 0, 0,
        [new("blue", ack, new(x, 1, 0), default, true), new("orange", 0, new(2, 1, 0), default, true)],
        "running", 100, 0, []);
}
