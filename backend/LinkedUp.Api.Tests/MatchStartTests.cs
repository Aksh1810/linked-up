using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using Grpc.Core;
using LinkedUp.Api.Matches;
using LinkedUp.Api.Rooms;
using LinkedUp.Contracts.Match.V1;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using StackExchange.Redis;

namespace LinkedUp.Api.Tests;

public sealed class MatchStartTests : IAsyncLifetime
{
    private readonly string _prefix = $"linked-up:test:{Guid.NewGuid():N}:room:";
    private readonly FakeSimulationMatchClient _simulation = new();
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public MatchStartTests()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder
            .UseSetting("LinkedUp:Redis", "127.0.0.1:6379,defaultDatabase=15")
            .UseSetting("LinkedUp:KeyPrefix", _prefix)
            .ConfigureTestServices(services =>
            {
                services.RemoveAll<ISimulationMatchClient>();
                services.AddSingleton<ISimulationMatchClient>(_simulation);
            }));
        _client = _factory.CreateClient();
    }

    public Task InitializeAsync()
    {
        _simulation.Reset();
        return Task.CompletedTask;
    }

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
    public async Task Full_present_room_starts_once_and_each_player_gets_only_its_launch()
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        var hostUpdates = Channel.CreateUnbounded<PublicRoom>();
        var guestUpdates = Channel.CreateUnbounded<PublicRoom>();
        var hostLaunches = Channel.CreateUnbounded<MatchLaunch>();
        var guestLaunches = Channel.CreateUnbounded<MatchLaunch>();
        await using var hostHub = BuildHubConnection(hostUpdates, hostLaunches);
        await using var guestHub = BuildHubConnection(guestUpdates, guestLaunches);
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);

        var response = await StartAsync(host);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var room = JsonSerializer.Deserialize<PublicRoom>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("inGame", room!.Status);
        Assert.NotNull(room.MatchId);
        Assert.DoesNotContain("host-ticket", body);
        Assert.Equal("inGame", (await ReadUpdateAsync(hostUpdates)).Status);
        Assert.Equal("inGame", (await ReadUpdateAsync(guestUpdates)).Status);
        Assert.Equal(host.Session.PlayerId, (await ReadLaunchAsync(hostLaunches)).PlayerId);
        Assert.Equal(guest.Session.PlayerId, (await ReadLaunchAsync(guestLaunches)).PlayerId);
        Assert.False(await HasLaunchAsync(hostLaunches));
        Assert.False(await HasLaunchAsync(guestLaunches));
    }

    [Fact]
    public async Task Concurrent_start_returns_conflict_while_first_create_is_running()
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);
        _simulation.BlockCreate();

        var first = StartAsync(host);
        await _simulation.CreateStarted.Task;
        var second = await StartAsync(host);
        _simulation.ReleaseCreate();

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("Room already starting",
            (await second.Content.ReadFromJsonAsync<ProblemDetails>())!.Title);
        Assert.Equal(HttpStatusCode.OK, (await first).StatusCode);
        Assert.Equal(1, _simulation.CreateCalls);
    }

    [Theory]
    [InlineData("Simulation is unavailable.")]
    [InlineData("Simulation returned an invalid match launch.")]
    public async Task Simulation_failure_rolls_back_to_waiting_without_launch(string message)
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        var updates = Channel.CreateUnbounded<PublicRoom>();
        var launches = Channel.CreateUnbounded<MatchLaunch>();
        await using var hostHub = BuildHubConnection(updates, launches);
        await using var guestHub = BuildHubConnection();
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);
        _simulation.CreateException = new SimulationUnavailableException(message);

        var response = await StartAsync(host);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("Simulation unavailable",
            (await response.Content.ReadFromJsonAsync<ProblemDetails>())!.Title);
        Assert.Equal("waiting", (await ReadUpdateAsync(updates)).Status);
        Assert.False(await HasLaunchAsync(launches));
    }

    [Fact]
    public async Task Missing_player_presence_returns_conflict_before_creating_match()
    {
        var host = await CreateRoomAsync(2);
        await JoinRoomAsync(host.Room.Code);

        var response = await StartAsync(host);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("Players not present",
            (await response.Content.ReadFromJsonAsync<ProblemDetails>())!.Title);
        Assert.Equal(0, _simulation.CreateCalls);
    }

    [Fact]
    public async Task Changed_start_destroys_created_match_and_returns_conflict()
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);
        _simulation.BlockCreate();

        var start = StartAsync(host);
        await _simulation.CreateStarted.Task;
        using var leave = new HttpRequestMessage(HttpMethod.Post, $"/api/rooms/{host.Room.Code}/leave");
        leave.Headers.Add("X-Player-Token", guest.Session.Token);
        (await _client.SendAsync(leave)).EnsureSuccessStatusCode();
        _simulation.ReleaseCreate();

        Assert.Equal(HttpStatusCode.Conflict, (await start).StatusCode);
        Assert.Equal(1, _simulation.DestroyCalls);
    }

    [Fact]
    public async Task Finalization_exception_destroys_created_match_and_returns_conflict()
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);
        _simulation.BlockCreate();

        var start = StartAsync(host);
        await _simulation.CreateStarted.Task;
        using var guestLeave = WithToken(HttpMethod.Post,
            $"/api/rooms/{host.Room.Code}/leave", guest.Session.Token);
        using var hostLeave = WithToken(HttpMethod.Post,
            $"/api/rooms/{host.Room.Code}/leave", host.Session.Token);
        (await _client.SendAsync(guestLeave)).EnsureSuccessStatusCode();
        (await _client.SendAsync(hostLeave)).EnsureSuccessStatusCode();
        _simulation.ReleaseCreate();

        var response = await start;
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("Room start cancelled",
            (await response.Content.ReadFromJsonAsync<ProblemDetails>())!.Title);
        Assert.Equal(1, _simulation.DestroyCalls);
    }

    [Fact]
    public async Task Request_cancellation_after_match_creation_keeps_the_completed_match()
    {
        var host = await CreateRoomAsync(2);
        var guest = await JoinRoomAsync(host.Room.Code);
        await using var hostHub = BuildHubConnection();
        await using var guestHub = BuildHubConnection();
        await hostHub.StartAsync();
        await guestHub.StartAsync();
        await SubscribeAsync(hostHub, host);
        await SubscribeAsync(guestHub, guest);
        _simulation.BlockCreate();
        using var cancellation = new CancellationTokenSource();

        var start = StartAsync(host, cancellation.Token);
        await _simulation.CreateStarted.Task;
        cancellation.Cancel();
        _simulation.ReleaseCreate();

        try
        {
            await start;
        }
        catch (OperationCanceledException)
        {
        }

        var room = await WaitForInGameAsync(host.Room.Code);
        Assert.NotNull(room.MatchId);
        Assert.Equal(0, _simulation.DestroyCalls);
    }

    [Fact]
    public async Task Create_match_returns_validated_launches_in_room_order()
    {
        var room = FullRoom();
        var client = Client(response => Task.FromResult(response));

        var created = await client.CreateMatchAsync(room, CancellationToken.None);

        Assert.Equal(Guid.Parse("11111111-1111-4111-8111-111111111111"), created.MatchId);
        Assert.Equal(room.Players.Select(player => player.Id), created.Launches.Select(launch => launch.PlayerId));
    }

    [Fact]
    public async Task Create_match_sends_the_selected_room_map()
    {
        var room = FullRoom();
        room.SetMap(new string('a', 64), RoomMaps.Windworks);
        CreateMatchRequest? sent = null;
        var client = new SimulationMatchClient(
            (request, _) =>
            {
                sent = request;
                return Task.FromResult(ValidResponse(request));
            },
            (_, _) => Task.CompletedTask,
            TimeProvider.System,
            NullLogger<SimulationMatchClient>.Instance);

        await client.CreateMatchAsync(room, CancellationToken.None);

        Assert.Equal(RoomMaps.Windworks, sent!.MapId);
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("wrong-player")]
    [InlineData("duplicate")]
    [InlineData("http-url")]
    public async Task Create_match_rejects_malformed_replies(string defect)
    {
        var room = FullRoom();
        var client = Client(response => Task.FromResult(Defective(response, defect)));

        await Assert.ThrowsAsync<SimulationUnavailableException>(() =>
            client.CreateMatchAsync(room, CancellationToken.None));
    }

    [Fact]
    public async Task Create_match_converts_unavailable_rpc_to_simulation_unavailable()
    {
        var client = Client(_ => throw new RpcException(new Status(StatusCode.Unavailable, "offline")));

        await Assert.ThrowsAsync<SimulationUnavailableException>(() =>
            client.CreateMatchAsync(FullRoom(), CancellationToken.None));
    }

    private static SimulationMatchClient Client(Func<CreateMatchResponse, Task<CreateMatchResponse>> reply) =>
        new(async (request, _) => await reply(ValidResponse(request)),
            (_, _) => Task.CompletedTask, TimeProvider.System, NullLogger<SimulationMatchClient>.Instance);

    private static Room FullRoom()
    {
        var room = Room.Create("XK72", 2, Guid.Parse("00000000-0000-0000-0000-000000000001"),
            new string('a', 64), DateTimeOffset.UnixEpoch);
        room.Join(Guid.Parse("00000000-0000-0000-0000-000000000002"), new string('b', 64), DateTimeOffset.UnixEpoch);
        return room;
    }

    private static CreateMatchResponse ValidResponse(CreateMatchRequest request)
    {
        var response = new CreateMatchResponse
        {
            MatchId = "11111111-1111-4111-8111-111111111111",
            GameplayUrl = "ws://127.0.0.1:8420/gameplay",
            CountdownSeconds = 3,
            ExpiresUnixMs = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()
        };
        response.Launches.Add(request.Players.Select(player => new PlayerLaunch
        {
            PlayerId = player.Id,
            Color = player.Color,
            Ticket = "ticket-" + player.Id,
            ExpiresUnixMs = response.ExpiresUnixMs
        }));
        return response;
    }

    private static CreateMatchResponse Defective(CreateMatchResponse response, string defect)
    {
        switch (defect)
        {
            case "expired": response.ExpiresUnixMs = DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds(); break;
            case "wrong-player": response.Launches[0].PlayerId = Guid.NewGuid().ToString(); break;
            case "duplicate": response.Launches[1].PlayerId = response.Launches[0].PlayerId; break;
            case "http-url": response.GameplayUrl = "http://127.0.0.1:8420/gameplay"; break;
        }
        return response;
    }

    private async Task<RoomSessionResponse> CreateRoomAsync(int capacity)
    {
        var response = await _client.PostAsJsonAsync("/api/rooms", new { capacity });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
    }

    private async Task<RoomSessionResponse> JoinRoomAsync(string roomCode)
    {
        var response = await _client.PostAsync($"/api/rooms/{roomCode}/join", null);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RoomSessionResponse>())!;
    }

    private Task<HttpResponseMessage> StartAsync(
        RoomSessionResponse session, CancellationToken cancellationToken = default)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/rooms/{session.Room.Code}/start");
        request.Headers.Add("X-Player-Token", session.Session.Token);
        return _client.SendAsync(request, cancellationToken);
    }

    private static HttpRequestMessage WithToken(HttpMethod method, string url, string token)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add("X-Player-Token", token);
        return request;
    }

    private static Task SubscribeAsync(HubConnection connection, RoomSessionResponse session) =>
        connection.InvokeAsync<PublicRoom>(nameof(LobbyHub.Subscribe), session.Room.Code, session.Session.Token);

    private HubConnection BuildHubConnection(
        Channel<PublicRoom>? updates = null, Channel<MatchLaunch>? launches = null)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_client.BaseAddress!, "/hubs/lobby"), options =>
            {
                options.Transports = HttpTransportType.LongPolling;
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            })
            .Build();
        if (updates is not null)
        {
            connection.On<PublicRoom>("RoomUpdated", room => updates.Writer.TryWrite(room));
        }
        if (launches is not null)
        {
            connection.On<MatchLaunch>("MatchReady", launch => launches.Writer.TryWrite(launch));
        }

        return connection;
    }

    private static async Task<PublicRoom> ReadUpdateAsync(Channel<PublicRoom> updates)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        return await updates.Reader.ReadAsync(timeout.Token);
    }

    private static async Task<MatchLaunch> ReadLaunchAsync(Channel<MatchLaunch> launches)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        return await launches.Reader.ReadAsync(timeout.Token);
    }

    private static async Task<bool> HasLaunchAsync(Channel<MatchLaunch> launches)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        try
        {
            return await launches.Reader.WaitToReadAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task<PublicRoom> WaitForInGameAsync(string code)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!timeout.IsCancellationRequested)
        {
            using var response = await _client.GetAsync($"/api/rooms/{code}", timeout.Token);
            if (response.StatusCode == HttpStatusCode.OK)
            {
                var room = await response.Content.ReadFromJsonAsync<PublicRoom>(timeout.Token);
                if (room?.Status == "inGame")
                {
                    return room;
                }
            }

            await Task.Delay(20, timeout.Token);
        }

        throw new TimeoutException("Room did not complete after request cancellation.");
    }

    private sealed class FakeSimulationMatchClient : ISimulationMatchClient
    {
        private TaskCompletionSource? _releaseCreate;

        public TaskCompletionSource CreateStarted { get; private set; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        public Exception? CreateException { get; set; }
        public int CreateCalls { get; private set; }
        public int DestroyCalls { get; private set; }

        public void Reset()
        {
            _releaseCreate = null;
            CreateStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            CreateException = null;
            CreateCalls = 0;
            DestroyCalls = 0;
        }

        public void BlockCreate() => _releaseCreate = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public void ReleaseCreate() => _releaseCreate!.SetResult();

        public async Task<CreatedMatch> CreateMatchAsync(Room room, CancellationToken cancellationToken)
        {
            CreateCalls++;
            CreateStarted.TrySetResult();
            if (_releaseCreate is not null)
            {
                await _releaseCreate.Task;
            }
            if (CreateException is not null)
            {
                throw CreateException;
            }

            var matchId = Guid.Parse("11111111-1111-4111-8111-111111111111");
            return new CreatedMatch(matchId, room.Players.Select(player => new MatchLaunch(
                matchId, "ws://127.0.0.1:8420/gameplay", 3, DateTimeOffset.UtcNow.AddMinutes(1),
                player.Id, player.Color.ToString().ToLowerInvariant(),
                player.Id == room.HostPlayerId ? "host-ticket" : "guest-ticket")).ToArray());
        }

        public Task DestroyMatchAsync(Guid matchId, CancellationToken cancellationToken)
        {
            DestroyCalls++;
            return Task.CompletedTask;
        }
    }
}
