using System.Net.WebSockets;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using LinkedUp.Contracts;

namespace LinkedUp.Client;

public sealed class GameplayClient(WebSocket socket) : IAsyncDisposable
{
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim sender = new(1, 1);
    private readonly TaskCompletionSource welcomed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly byte[] receiveBuffer = new byte[256 * 1024];
    private Task? receiver;
    private bool disposed;
    private volatile ServerSnapshot? snapshot;
    private readonly SnapshotBuffer snapshots = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private PredictionReconciler? predictor;
    private double lastRender;
    public GameplayInput Input { get; } = new();
    public WelcomeMessage? Welcome { get; private set; }
    public ServerSnapshot? Snapshot => snapshot;
    public string Status { get; private set; } = "Connecting to the climb…";
    public event Action<string>? StatusChanged;
    public event Action<ServerSnapshot>? SnapshotChanged;

    public static async Task<GameplayClient> ConnectAsync(MatchLaunch launch, CancellationToken token)
    {
        var socket = new ClientWebSocket();
        var client = new GameplayClient(socket);
        try
        {
            await socket.ConnectAsync(new Uri(launch.GameplayUrl), token);
            await client.JoinAsync(launch, token);
            return client;
        }
        catch { await client.DisposeAsync(); throw; }
    }

    public async Task JoinAsync(MatchLaunch launch, CancellationToken token)
    {
        if (receiver is not null || disposed) throw new InvalidOperationException("Match connection already used.");
        await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(
            new JoinMatchMessage("join", launch.MatchId, launch.Ticket), Wire.Json), WebSocketMessageType.Text, true, token);
        receiver = ReceiveAsync(launch.Color);
        try { await welcomed.Task.WaitAsync(TimeSpan.FromSeconds(10), token); }
        catch { await DisposeAsync(); throw; }
    }

    public async Task<ServerSnapshot?> FrameAsync(double now, double cameraAlpha)
    {
        if (disposed || socket.State != WebSocketState.Open || Welcome is null || snapshot?.MatchState == "finished") return RenderSnapshot();
        if (!await sender.WaitAsync(0)) return RenderSnapshot();
        try
        {
            if (Input.Poll(now, cameraAlpha) is { } input)
            {
                var jumpPressed = Input.JumpPressed;
                await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(input, Wire.Json), WebSocketMessageType.Text, true, lifetime.Token);
                predictor?.Record(input with { Jump = jumpPressed });
            }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            if (!disposed) { SetStatus("Disconnected from match."); socket.Abort(); }
        }
        finally { sender.Release(); }
        return RenderSnapshot();
    }

    private ServerSnapshot? RenderSnapshot()
    {
        var now = clock.Elapsed.TotalMilliseconds;
        var local = predictor?.Render(now - lastRender);
        lastRender = now;
        var rendered = snapshots.Sample(now) ?? snapshot;
        if (rendered is null || local is null || rendered.MatchState == "finished") return rendered;
        return rendered with { Players = rendered.Players.Select(value => value.Id == local.Id ? local : value).ToArray() };
    }

    private async Task ReceiveAsync(string color)
    {
        try
        {
            while (await ReadAsync() is { } json)
            {
                switch (GameplayProtocol.Parse(json, Welcome))
                {
                    case WelcomeMessage welcome:
                        if (Welcome is not null || welcome.Player != color) throw new InvalidDataException("Invalid player handshake.");
                        Welcome = welcome;
                        predictor = new PredictionReconciler(welcome.Player);
                        SetStatus("Connected — waiting for crew.");
                        welcomed.TrySetResult();
                        break;
                    case CountdownMessage countdown:
                        if (Welcome is null) throw new InvalidDataException("Missing player handshake.");
                        SetStatus(countdown.Seconds == 0 ? "Climb!" : $"Starting in {countdown.Seconds}…");
                        break;
                    case ServerSnapshot next:
                        if (snapshot is { } previous && (next.ResetCount < previous.ResetCount
                            || next.ResetCount == previous.ResetCount && next.Tick <= previous.Tick)) break;
                        snapshot = next;
                        snapshots.Push(next, clock.Elapsed.TotalMilliseconds);
                        predictor!.Reconcile(next);
                        SnapshotChanged?.Invoke(next);
                        break;
                    case GameError:
                        throw new InvalidDataException("The game server rejected the connection.");
                }
            }
            if (!disposed && snapshot?.MatchState != "finished") SetStatus("Disconnected from match.");
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception error) when (error is WebSocketException or InvalidDataException or ObjectDisposedException)
        {
            if (!disposed) SetStatus(error is InvalidDataException ? "The game server sent an invalid update." : "Disconnected from match.");
        }
        finally
        {
            welcomed.TrySetException(new InvalidOperationException(Status));
            socket.Abort();
        }
    }

    private async Task<string?> ReadAsync()
    {
        // A route snapshot is ~15 KiB. Keep a hard bound even on fragmented messages.
        var bytes = receiveBuffer;
        var count = 0;
        while (true)
        {
            var received = await socket.ReceiveAsync(bytes.AsMemory(count), lifetime.Token);
            if (received.MessageType == WebSocketMessageType.Close) return null;
            if (received.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("Expected a text message.");
            count += received.Count;
            if (received.EndOfMessage) return Encoding.UTF8.GetString(bytes, 0, count);
            if (count == bytes.Length) throw new InvalidDataException("Gameplay message too large.");
        }
    }

    private void SetStatus(string value) { Status = value; StatusChanged?.Invoke(value); }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        Input.Clear();
        lifetime.Cancel();
        socket.Abort();
        if (receiver is not null) await receiver;
        // An in-flight browser frame may still be sending when Leave is clicked.
        await sender.WaitAsync();
        sender.Release();
        socket.Dispose();
        lifetime.Dispose();
    }
}
