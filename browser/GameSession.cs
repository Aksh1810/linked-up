using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using LinkedUp.Contracts;

namespace LinkedUp.Client;

public sealed class GameSession(HttpClient http)
{
    private static readonly JsonSerializerOptions Json = Wire.Json;
    public RoomSessionResponse? Session { get; private set; }
    public PublicRoom? Room => Session?.Room;
    public async Task CreateAsync(int players, CancellationToken token) =>
        Session = await Send<RoomSessionResponse>(HttpMethod.Post, "api/rooms", new CreateRoomRequest(players), null, token);
    public async Task JoinAsync(string code, CancellationToken token) =>
        Session = await Send<RoomSessionResponse>(HttpMethod.Post, $"api/rooms/{Code(code)}/join", null, null, token);
    public async Task RefreshAsync(CancellationToken token)
    {
        if (Room is null) return;
        using var response = await http.GetAsync($"api/rooms/{Room.Code}", token);
        Session = Current with { Room = await Read<PublicRoom>(response, token) };
    }
    public async Task SetMapAsync(string map, CancellationToken token) =>
        Session = Current with { Room = await Send<PublicRoom>(HttpMethod.Post, $"api/rooms/{Room!.Code}/map", new SetRoomMapRequest(map), Token(), token) };
    public async Task StartAsync(CancellationToken token) =>
        Session = Current with { Room = await Send<PublicRoom>(HttpMethod.Post, $"api/rooms/{Room!.Code}/start", null, Token(), token) };
    public async Task<MatchLaunch> LaunchAsync(CancellationToken token) =>
        await Send<MatchLaunch>(HttpMethod.Post, $"api/rooms/{Room!.Code}/launch", null, Token(), token);
    public async Task LeaveAsync(CancellationToken token)
    {
        if (Room is not null) await Send<object?>(HttpMethod.Post, $"api/rooms/{Room.Code}/leave", null, Token(), token);
        Session = null;
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
        if (!response.IsSuccessStatusCode)
        {
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>(Json, cancellation);
            throw new InvalidOperationException(problem.TryGetProperty("title", out var title) ? title.GetString() : "Room request failed.");
        }
        return (await response.Content.ReadFromJsonAsync<T>(Json, cancellation))!;
    }
    private static string Code(string code)
    {
        var normalized = code.Trim().ToUpperInvariant();
        if (normalized.Length != 4 || normalized.Any(c => !"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".Contains(c))) throw new ArgumentException("Enter a four-character room code.");
        return normalized;
    }
}
