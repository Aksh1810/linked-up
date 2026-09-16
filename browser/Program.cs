using LinkedUp.Client;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.AspNetCore.SignalR.Client;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");
var api = new Uri(builder.Configuration["ApiBaseUrl"]
    ?? throw new InvalidOperationException("ApiBaseUrl is not configured."));
builder.Services.AddScoped(_ => new HttpClient { BaseAddress = api });
builder.Services.AddScoped(_ => new HubConnectionBuilder()
    .WithUrl(new Uri(api, "hubs/lobby"))
    .Build());
builder.Services.AddScoped<GameSession>();
await builder.Build().RunAsync();
