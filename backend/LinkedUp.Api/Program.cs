using LinkedUp.Api.Rooms;
using LinkedUp.Api.Matches;
using Grpc.Net.Client;
using LinkedUp.Contracts.Match.V1;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<RoomOptions>(builder.Configuration.GetSection("LinkedUp"));
builder.Services.Configure<SimulationOptions>(builder.Configuration.GetSection("Simulation"));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IConnectionMultiplexer>(services =>
{
    var configuration = ConfigurationOptions.Parse(
        services.GetRequiredService<IOptions<RoomOptions>>().Value.Redis);
    configuration.AbortOnConnectFail = false;
    return ConnectionMultiplexer.Connect(configuration);
});
builder.Services.AddSingleton<RedisRoomStore>();
builder.Services.AddSingleton<RoomPresence>();
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);
builder.Services.AddSingleton<GrpcChannel>(services => GrpcChannel.ForAddress(
        services.GetRequiredService<IConfiguration>()["Simulation:Address"]
        ?? "http://127.0.0.1:50051"));
builder.Services.AddSingleton<MatchCoordinator.MatchCoordinatorClient>(services =>
    new MatchCoordinator.MatchCoordinatorClient(services.GetRequiredService<GrpcChannel>()));
builder.Services.AddSingleton<ISimulationMatchClient, SimulationMatchClient>();
builder.Services.AddSignalR();
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks()
    .AddCheck<RedisReadinessCheck>("redis", tags: ["ready"]);
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(builder.Configuration["LinkedUp:ClientOrigin"]
        ?? new RoomOptions().ClientOrigin)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();
app.UseExceptionHandler();
app.UseCors();
app.MapRoomEndpoints();
// ponytail: in-process presence fits the single backend; add a Redis backplane before scaling out.
app.MapHub<LobbyHub>("/hubs/lobby");
app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    Predicate = _ => false
});
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
});
app.Run();

public partial class Program;
