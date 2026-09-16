using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameplayHudTests
{
    [Theory]
    [InlineData(.1f, "Linked tether")]
    [InlineData(.5f, "Stretched tether")]
    [InlineData(.85f, "Taut tether")]
    public void Hud_uses_authoritative_checkpoint_and_normalized_tension(float tension, string label)
    {
        var state = new ServerSnapshot(60, 0, tension, [], "running", 60, 2, []);
        var hud = GameplayHud.From(state, "relay-ridge");
        Assert.Equal("Relay Ridge · Industrial · Checkpoint 2", hud.Route);
        Assert.Equal(label, hud.Tether);
        Assert.False(hud.Finished);
    }

    [Fact]
    public void Finished_snapshot_displays_summit_and_authoritative_elapsed_time()
    {
        var hud = GameplayHud.From(new ServerSnapshot(10000, 3, 0, [], "finished", 3660, 4, []), "windworks");
        Assert.True(hud.Finished);
        Assert.Equal("Summit reached", hud.Status);
        Assert.Equal("01:01", hud.Elapsed);
    }
}
