using LinkedUp.Api.Rooms;
using LinkedUp.Api.Matches;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<RoomOptions>(builder.Configuration.GetSection("LinkedUp"));
builder.Services.Configure<MatchOptions>(options =>
{
    builder.Configuration.GetSection("Match").Bind(options);
    if (builder.Configuration["Match:GameplayUrl"] is null && builder.Configuration["RENDER_EXTERNAL_HOSTNAME"] is { } hostname)
        options.GameplayUrl = $"wss://{hostname}/gameplay";
    if (!Uri.TryCreate(options.GameplayUrl, UriKind.Absolute, out var gameplay)
        || (gameplay.Scheme != "wss" && !(gameplay.Scheme == "ws" && gameplay.IsLoopback))
        || !string.IsNullOrEmpty(gameplay.UserInfo) || !string.IsNullOrEmpty(gameplay.Query)
        || options.MaxMatches is < 1 or > 64)
        throw new InvalidOperationException("Invalid Match configuration.");
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IConnectionMultiplexer>(services =>
{
    var redisUrl = builder.Configuration["REDIS_URL"];
    var configuration = ConfigurationOptions.Parse(services.GetRequiredService<IOptions<RoomOptions>>().Value.Redis);
    if (!string.IsNullOrEmpty(redisUrl))
    {
        var uri = new Uri(redisUrl);
        if (uri.Scheme is not ("redis" or "rediss")) throw new InvalidOperationException("Invalid Redis URL scheme.");
        configuration = new ConfigurationOptions { Ssl = uri.Scheme == "rediss" };
        configuration.EndPoints.Add(uri.Host, uri.IsDefaultPort ? 6379 : uri.Port);
        var credentials = uri.UserInfo.Split(':', 2);
        if (credentials.Length == 2)
        {
            configuration.User = Uri.UnescapeDataString(credentials[0]);
            configuration.Password = Uri.UnescapeDataString(credentials[1]);
        }
    }
    configuration.AbortOnConnectFail = false;
    return ConnectionMultiplexer.Connect(configuration);
});
builder.Services.AddSingleton<RedisRoomStore>();
builder.Services.AddSingleton<RoomPresence>();
builder.Services.AddSingleton<ManagedMatches>();
builder.Services.AddSingleton<ISimulationMatchClient>(services => services.GetRequiredService<ManagedMatches>());
builder.Services.AddHostedService(services => services.GetRequiredService<ManagedMatches>());
builder.Services.AddSignalR(options => options.MaximumReceiveMessageSize = 4096);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 4096);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("rooms", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "local", _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 120, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
        }));
});
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
app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    await next();
});
app.UseCors();
app.UseRateLimiter();
var sockets = new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) };
sockets.AllowedOrigins.Add(builder.Configuration["LinkedUp:ClientOrigin"] ?? new RoomOptions().ClientOrigin);
app.UseWebSockets(sockets);
app.MapRoomEndpoints();
app.Map("/gameplay", (HttpContext context, ManagedMatches matches) => matches.ConnectAsync(context));
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
