using LinkedUp.Contracts;

namespace LinkedUp.Client;

public sealed class GameplayInput
{
    private readonly HashSet<string> keys = [];
    private bool jumpQueued;
    private long sequence;
    private double lastInput = double.NegativeInfinity;
    public bool JumpPressed { get; private set; }

    public void Key(string code, bool pressed)
    {
        if (code is not ("KeyW" or "KeyA" or "KeyS" or "KeyD" or "Space")) return;
        if (pressed)
        {
            if (keys.Add(code) && code == "Space") jumpQueued = true;
        }
        else keys.Remove(code);
    }

    public void Clear() { keys.Clear(); jumpQueued = false; }

    public ClientInput? Poll(double now, double cameraAlpha)
    {
        if (!double.IsFinite(now) || !double.IsFinite(cameraAlpha) || now - lastInput < 1000d / 60) return null;
        lastInput = now;
        var x = (keys.Contains("KeyD") ? 1d : 0) - (keys.Contains("KeyA") ? 1 : 0);
        var z = (keys.Contains("KeyW") ? 1d : 0) - (keys.Contains("KeyS") ? 1 : 0);
        var length = Math.Max(1, Math.Sqrt(x * x + z * z));
        var yaw = -cameraAlpha - Math.PI / 2;
        var jump = jumpQueued || keys.Contains("Space");
        JumpPressed = jumpQueued;
        jumpQueued = false;
        return new ClientInput("input", ++sequence, sequence,
            (float)((x * Math.Cos(yaw) + z * Math.Sin(yaw)) / length),
            (float)((z * Math.Cos(yaw) - x * Math.Sin(yaw)) / length), jump);
    }
}
