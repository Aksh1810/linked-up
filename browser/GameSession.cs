using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using LinkedUp.Contracts;
using Microsoft.AspNetCore.SignalR.Client;

namespace LinkedUp.Client;

public sealed class GameSession : IDisposable
{
    private readonly HttpClient http;
    private readonly HubConnection lobby;
    private static readonly JsonSerializerOptions Json = Wire.Json;
    private readonly IDisposable roomUpdates;

    public GameSession(HttpClient http, HubConnection lobby)
    {
        this.http = http;
        this.lobby = lobby;
        roomUpdates = lobby.On<PublicRoom>("RoomUpdated", room => ApplyRoom(room));
        lobby.Closed += OnClosed;
    }
    public RoomSessionResponse? Session { get; private set; }
    public PublicRoom? Room => Session?.Room;
    public event Action? RoomChanged;
    public async Task CreateAsync(int players, CancellationToken token) =>
        await EnterAsync(await Send<RoomSessionResponse>(HttpMethod.Post, "api/rooms", new CreateRoomRequest(players), null, token), token);
    public async Task JoinAsync(string code, CancellationToken token) =>
        await EnterAsync(await Send<RoomSessionResponse>(HttpMethod.Post, $"api/rooms/{Code(code)}/join", null, null, token), token);
    private async Task EnterAsync(RoomSessionResponse session, CancellationToken token)
    {
        Session = session;
        try
        {
            await lobby.StartAsync(token);
            var room = await lobby.InvokeAsync<PublicRoom>("Subscribe", session.Room.Code, session.Session.Token, token);
            ApplyRoom(room, session.Session.PlayerId);
        }
        catch
        {
            Session = null;
            await lobby.StopAsync(CancellationToken.None);
            // A failed subscription must not occupy a room slot indefinitely.
            try { await Send<object?>(HttpMethod.Post, $"api/rooms/{session.Room.Code}/leave", null, session.Session.Token, CancellationToken.None); }
            catch { /* The disconnect may already have removed the player. */ }
            throw;
        }
    }
    public async Task RefreshAsync(CancellationToken token)
    {
        if (Session is not { } current) return;
        using var response = await http.GetAsync($"api/rooms/{current.Room.Code}", token);
        ApplyRoom(await Read<PublicRoom>(response, token), current.Session.PlayerId);
    }
    public async Task SetMapAsync(string map, CancellationToken token) =>
        await UpdateAsync("map", new SetRoomMapRequest(map), token);
    public async Task StartAsync(CancellationToken token) =>
        await UpdateAsync("start", null, token);
    private async Task UpdateAsync(string action, object? body, CancellationToken token)
    {
        var current = Current;
        ApplyRoom(await Send<PublicRoom>(HttpMethod.Post, $"api/rooms/{current.Room.Code}/{action}",
            body, current.Session.Token, token), current.Session.PlayerId);
    }
    public async Task<MatchLaunch> LaunchAsync(CancellationToken token) =>
        await Send<MatchLaunch>(HttpMethod.Post, $"api/rooms/{Room!.Code}/launch", null, Token(), token);
    public async Task LeaveAsync(CancellationToken token)
    {
        var current = Session;
        Session = null;
        try
        {
            // In-game rosters are immutable; the gameplay socket is closed by the page.
            if (current is { Room.Status: not "inGame" })
                await Send<object?>(HttpMethod.Post, $"api/rooms/{current.Room.Code}/leave", null, current.Session.Token, token);
        }
        finally
        {
            await lobby.StopAsync(CancellationToken.None);
        }
    }
    private void ApplyRoom(PublicRoom room, Guid? playerId = null)
    {
        if (Session is not { } current || room.Id != current.Room.Id || room.Version < current.Room.Version
            || playerId is { } id && id != current.Session.PlayerId) return;
        Session = current with { Room = room };
        RoomChanged?.Invoke();
    }
    private Task OnClosed(Exception? error)
    {
        // A disconnected lobby player is removed by the server. Do not show a stale ready roster.
        if (Session is { Room.Status: not "inGame" })
        {
            Session = null;
            RoomChanged?.Invoke();
        }
        return Task.CompletedTask;
    }
    public bool Host => Room?.Players.Any(player => player.Id == Session?.Session.PlayerId && player.IsHost) == true;
    private RoomSessionResponse Current => Session ?? throw new InvalidOperationException("No room session.");
    private string Token() => Current.Session.Token;
    private async Task<T> Send<T>(HttpMethod method, string url, object? body, string? token, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        if (token is not null) request.Headers.Add("X-Player-Token", token);
        using var response = await http.SendAsync(request, cancellation);
        return await Read<T>(response, cancellation);
    }
    private static async Task<T> Read<T>(HttpResponseMessage response, CancellationToken cancellation)
    {
        if (response.StatusCode == HttpStatusCode.NoContent) return default!;
        var body = await response.Content.ReadAsStringAsync(cancellation);
        if (string.IsNullOrWhiteSpace(body))
        {
            throw new InvalidOperationException(
                $"Room service returned an empty response ({(int)response.StatusCode}) from {response.RequestMessage?.RequestUri}.");
        }
        try
        {
            if (!response.IsSuccessStatusCode)
            {
                var problem = JsonSerializer.Deserialize<JsonElement>(body, Json);
                throw new InvalidOperationException(problem.TryGetProperty("title", out var title)
                    ? title.GetString() ?? "Room request failed."
                    : "Room request failed.");
            }

            return JsonSerializer.Deserialize<T>(body, Json)
                ?? throw new InvalidOperationException("Room service returned an empty response.");
        }
        catch (JsonException)
        {
            throw new InvalidOperationException(
                $"Room service returned a non-JSON response ({(int)response.StatusCode}). Check the configured .NET backend URL.");
        }
    }
    private static string Code(string code)
    {
        var normalized = code.Trim().ToUpperInvariant();
        if (normalized.Length != 4 || normalized.Any(c => !"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".Contains(c))) throw new ArgumentException("Enter a four-character room code.");
        return normalized;
    }

    public void Dispose()
    {
        roomUpdates.Dispose();
        lobby.Closed -= OnClosed;
    }
}
