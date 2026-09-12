using System.Net;
using System.Net.Http.Json;
using LinkedUp.Api.Rooms;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;

namespace LinkedUp.Api.Tests;

public sealed class RoomApiTests : IAsyncLifetime
{
    private readonly string _prefix = $"linked-up:test:{Guid.NewGuid():N}:room:";
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public RoomApiTests()
    {
        _factory = CreateFactory("127.0.0.1:6379,defaultDatabase=15");
        _client = _factory.CreateClient();
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        var redis = _factory.Services.GetRequiredService<IConnectionMultiplexer>();
        var database = redis.GetDatabase(15);
        foreach (var endpoint in redis.GetEndPoints())
        {
            var keys = redis.GetServer(endpoint).Keys(15, $"{_prefix}*").ToArray();
            if (keys.Length > 0)
            {
                await database.KeyDeleteAsync(keys);
            }
        }

        _client.Dispose();
        await _factory.DisposeAsync();
    }

    [Fact]
    public async Task Create_and_join_return_public_contracts()
    {
        var createdResponse = await _client.PostAsJsonAsync("/api/rooms", new { capacity = 2 });
        Assert.Equal(HttpStatusCode.Created, createdResponse.StatusCode);
        var createdJson = await createdResponse.Content.ReadAsStringAsync();
        var created = await createdResponse.Content.ReadFromJsonAsync<RoomSessionResponse>();
        Assert.DoesNotContain("tokenHash", createdJson, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("waiting", created!.Room.Status);
        Assert.Equal(RoomMaps.ClassicAscent, created.Room.MapId);
        Assert.Equal("blue", Assert.Single(created.Room.Players).Color);
        Assert.True(created.Room.Players[0].IsHost);

        var joinedResponse = await _client.PostAsync($"/api/rooms/{created.Room.Code}/join", null);
        Assert.Equal(HttpStatusCode.OK, joinedResponse.StatusCode);
        var joined = await joinedResponse.Content.ReadFromJsonAsync<RoomSessionResponse>();
        Assert.Equal("orange", joined!.Room.Players[1].Color);
    }

    [Fact]
    public async Task Waiting_host_can_select_a_map_but_guest_and_unknown_map_cannot()
    {
        var created = await CreateRoomAsync(2);
        var joinedResponse = await _client.PostAsync($"/api/rooms/{created.Room.Code}/join", null);
        var joined = (await joinedResponse.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
        using var select = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/map", created.Session.Token,
            JsonContent.Create(new { mapId = RoomMaps.CraneShift }));

        var selectedResponse = await _client.SendAsync(select);
        var selected = await selectedResponse.Content.ReadFromJsonAsync<PublicRoom>();

        Assert.Equal(HttpStatusCode.OK, selectedResponse.StatusCode);
        Assert.Equal(RoomMaps.CraneShift, selected!.MapId);

        using var guest = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/map", joined.Session.Token,
            JsonContent.Create(new { mapId = RoomMaps.Windworks }));
        Assert.Equal(HttpStatusCode.Forbidden, (await _client.SendAsync(guest)).StatusCode);

        using var unknown = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/map", created.Session.Token,
            JsonContent.Create(new { mapId = "unknown" }));
        var unknownResponse = await _client.SendAsync(unknown);
        Assert.Equal(HttpStatusCode.BadRequest, unknownResponse.StatusCode);
        Assert.Equal("Invalid room request",
            (await unknownResponse.Content.ReadFromJsonAsync<ProblemDetails>())!.Title);
    }

    [Fact]
    public async Task Invalid_capacity_returns_problem_details_400()
    {
        var response = await _client.PostAsJsonAsync("/api/rooms", new { capacity = 1 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Invalid room request", problem!.Title);
        Assert.Equal("Room capacity must be between two and four.", problem.Detail);
    }

    [Fact]
    public async Task Missing_room_returns_problem_details_404()
    {
        var response = await _client.GetAsync("/api/rooms/XK72");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Room not found", problem!.Title);
        Assert.Equal("The room was not found.", problem.Detail);
    }

    [Fact]
    public async Task Full_room_returns_problem_details_409()
    {
        var created = await CreateRoomAsync(2);
        Assert.Equal(HttpStatusCode.OK,
            (await _client.PostAsync($"/api/rooms/{created.Room.Code}/join", null)).StatusCode);

        var response = await _client.PostAsync($"/api/rooms/{created.Room.Code}/join", null);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Room full", problem!.Title);
        Assert.Equal("The room is full.", problem.Detail);
    }

    [Fact]
    public async Task Missing_and_invalid_tokens_return_401()
    {
        var created = await CreateRoomAsync(2);
        using var missing = new HttpRequestMessage(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/start");
        using var invalid = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/start", "wrong");

        var missingResponse = await _client.SendAsync(missing);
        var invalidResponse = await _client.SendAsync(invalid);

        Assert.Equal(HttpStatusCode.Unauthorized, missingResponse.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, invalidResponse.StatusCode);
        var problem = await invalidResponse.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Invalid room session", problem!.Title);
        Assert.Equal("The room session is invalid.", problem.Detail);
    }

    [Fact]
    public async Task Non_host_start_returns_403()
    {
        var created = await CreateRoomAsync(2);
        var joinedResponse = await _client.PostAsync($"/api/rooms/{created.Room.Code}/join", null);
        var joined = await joinedResponse.Content.ReadFromJsonAsync<RoomSessionResponse>();
        using var request = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/start", joined!.Session.Token);

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Host required", problem!.Title);
    }

    [Fact]
    public async Task Not_full_start_returns_409()
    {
        var created = await CreateRoomAsync(2);
        using var request = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/start", created.Session.Token);

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Room not full", problem!.Title);
    }

    [Fact]
    public async Task Leave_returns_204_and_removes_final_player()
    {
        var created = await CreateRoomAsync(2);
        using var request = WithToken(
            HttpMethod.Post, $"/api/rooms/{created.Room.Code}/leave", created.Session.Token);

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await _client.GetAsync($"/api/rooms/{created.Room.Code}")).StatusCode);
    }

    [Fact]
    public async Task Health_and_room_api_reflect_redis_availability()
    {
        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/health/live")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync("/health/ready")).StatusCode);

        await using var unavailableFactory = CreateFactory(
            "127.0.0.1:1,defaultDatabase=15,connectTimeout=100,connectRetry=0,asyncTimeout=100");
        using var unavailableClient = unavailableFactory.CreateClient();
        Assert.Equal(HttpStatusCode.OK,
            (await unavailableClient.GetAsync("/health/live")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable,
            (await unavailableClient.GetAsync("/health/ready")).StatusCode);
        var roomResponse = await unavailableClient.PostAsJsonAsync(
            "/api/rooms", new { capacity = 2 });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, roomResponse.StatusCode);
        var problem = await roomResponse.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.Equal("Room service unavailable", problem!.Title);
        Assert.Equal("The room service is temporarily unavailable.", problem.Detail);
    }

    [Fact]
    public async Task Cors_allows_only_configured_client_origin()
    {
        using var allowed = new HttpRequestMessage(HttpMethod.Get, "/health/live");
        allowed.Headers.Add("Origin", "http://client.test");
        using var denied = new HttpRequestMessage(HttpMethod.Get, "/health/live");
        denied.Headers.Add("Origin", "http://other.test");

        var allowedResponse = await _client.SendAsync(allowed);
        var deniedResponse = await _client.SendAsync(denied);

        Assert.Equal("http://client.test",
            Assert.Single(allowedResponse.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.Equal("true",
            Assert.Single(allowedResponse.Headers.GetValues("Access-Control-Allow-Credentials")));
        Assert.False(deniedResponse.Headers.Contains("Access-Control-Allow-Origin"));
    }

    private WebApplicationFactory<Program> CreateFactory(string redis) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.UseSetting(
            "LinkedUp:Redis", redis).UseSetting("LinkedUp:KeyPrefix", _prefix)
            .UseSetting("LinkedUp:ClientOrigin", "http://client.test"));

    private async Task<RoomSessionResponse> CreateRoomAsync(int capacity)
    {
        var response = await _client.PostAsJsonAsync("/api/rooms", new { capacity });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
    }

    private static HttpRequestMessage WithToken(
        HttpMethod method, string url, string token, HttpContent? content = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = content };
        request.Headers.Add("X-Player-Token", token);
        return request;
    }
}
