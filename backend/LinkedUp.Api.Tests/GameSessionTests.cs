using System.Net;
using LinkedUp.Client;

namespace LinkedUp.Api.Tests;

public sealed class GameSessionTests
{
    [Fact]
    public async Task NonJsonErrorExplainsThatTheApiUrlIsWrong()
    {
        using var http = new HttpClient(new StubHandler()) { BaseAddress = new Uri("https://linked-up.example/") };
        var game = new GameSession(http);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            game.CreateAsync(2, CancellationToken.None));

        Assert.Equal("Room service endpoint was not found. Check the configured .NET backend URL.", error.Message);
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.MethodNotAllowed)
            {
                Content = new StringContent("<!doctype html><title>Not Found</title>"),
                RequestMessage = request
            });
    }
}
