using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameplaySmoothingTests
{
    [Fact]
    public void Render_frames_advance_between_packets_without_extrapolating()
    {
        var buffer = new SnapshotBuffer();
        buffer.Push(Snapshot(100, 0), 0);
        buffer.Push(Snapshot(106, 6), 100);

        var first = buffer.Sample(125)!;
        var second = buffer.Sample(150)!;
        Assert.Equal(1.5f, first.Players[1].Position.X);
        Assert.Equal(3, second.Players[1].Position.X);
        Assert.Equal(.3f, second.TetherTension);
        Assert.Equal(3, second.Obstacles[0].Position.X);
        Assert.Equal(.3f, second.Obstacles[0].Rotation.Y);
        Assert.Equal(6, buffer.Sample(1000)!.Players[1].Position.X);
    }

    [Fact]
    public void Stale_packets_are_dropped_and_resets_and_finish_are_immediate()
    {
        var buffer = new SnapshotBuffer();
        Assert.True(buffer.Push(Snapshot(100, 0), 0));
        Assert.False(buffer.Push(Snapshot(99, 3), 10));
        Assert.True(buffer.Push(Snapshot(0, 7, 1), 20));
        Assert.Equal(7, buffer.Sample(20)!.Players[1].Position.X);
        Assert.False(buffer.Push(Snapshot(110, 9), 30));
        var finished = Snapshot(3, 8, 1) with { MatchState = "finished" };
        buffer.Push(finished, 70);
        Assert.Same(finished, buffer.Sample(70));
    }

    private static ServerSnapshot Snapshot(long tick, float orangeX, long reset = 0) => new(
        tick, reset, orangeX / 10, [
            new("blue", tick, new(0, 1, 0), default, true),
            new("orange", tick, new(orangeX, 1, 0), new(orangeX, 0, 0), true)
        ], "running", tick, 0, [new("crane", "moving-platform", "construction", "active",
            new(1, 1, 1), new(orangeX, 2, 0), new(0, orangeX / 10, 0))]);
}
