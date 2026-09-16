using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameplayInputTests
{
    [Fact]
    public void Input_is_camera_relative_and_diagonal_speed_is_normalized()
    {
        var input = new GameplayInput();
        input.Key("KeyW", true);
        var forward = input.Poll(0, -Math.PI / 2)!;
        Assert.Equal(0, forward.MoveX, 5);
        Assert.Equal(1, forward.MoveZ, 5);
        var rotated = input.Poll(20, -Math.PI)!;
        Assert.Equal(1, rotated.MoveX, 5);
        Assert.Equal(0, rotated.MoveZ, 5);
        input.Key("KeyD", true);
        var diagonal = input.Poll(40, -Math.PI / 2)!;
        Assert.Equal(Math.Sqrt(.5), diagonal.MoveX, 5);
        Assert.Equal(Math.Sqrt(.5), diagonal.MoveZ, 5);
        Assert.True(diagonal.IsValid());
    }

    [Fact]
    public void High_refresh_frames_do_not_exceed_sixty_inputs_per_second()
    {
        var input = new GameplayInput();
        var messages = Enumerable.Range(0, 144).Select(i => input.Poll(i * 1000d / 144, 0))
            .Where(message => message is not null).ToArray();
        Assert.InRange(messages.Length, 1, 60);
        Assert.Equal(Enumerable.Range(1, messages.Length).Select(i => (long)i), messages.Select(m => m!.Sequence));
        Assert.Null(input.Poll(double.NaN, 0));
        Assert.Null(input.Poll(2000, double.PositiveInfinity));
    }

    [Fact]
    public void Quick_jump_is_queued_until_sent_and_blur_clears_held_input()
    {
        var input = new GameplayInput();
        input.Poll(0, 0);
        input.Key("Space", true);
        input.Key("Space", false);
        Assert.Null(input.Poll(1, 0));
        Assert.True(input.Poll(20, 0)!.Jump);
        Assert.False(input.Poll(40, 0)!.Jump);
        input.Key("Space", true);
        input.Key("KeyW", true);
        input.Clear();
        var neutral = input.Poll(60, 0)!;
        Assert.False(neutral.Jump);
        Assert.Equal(0, neutral.MoveX);
        Assert.Equal(0, neutral.MoveZ);
    }
}
