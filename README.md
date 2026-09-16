# Linked-Up

Linked-Up is a 2–4 player cooperative browser climbing game. Small robots share an energy tether, so a jump, fall, or rescue affects the whole team. The lobby supports Classic Ascent, Relay Ridge, Crane Shift, and Windworks.

The active implementation is .NET 10: ASP.NET Core owns rooms, presence, authenticated gameplay WebSockets, and managed BepuPhysics; a Blazor WebAssembly client runs on Vercel and uses Babylon.js only for rendering. See [deployment](docs/deployment.md).

## Production architecture

```text
Blazor WebAssembly + Babylon.js ── HTTPS/SignalR ──> ASP.NET Core on Render
Browser gameplay WebSocket       ──────────────────> managed BepuPhysics
ASP.NET Core ──────────────────────────────────────> Redis (rooms and credentials)
```

- Vercel serves the static Blazor client and its Babylon.js rendering bridge.
- Render runs the .NET backend and its single authoritative 60 Hz match loop.
- Redis stores expiring rooms, hashed player session tokens, and lobby state.
- Gameplay snapshots are validated JSON WebSocket messages at 20 Hz; input is authenticated, ordered, bounded, and rate-limited.
- The browser owns input, prediction/interpolation, and presentation; the server owns transforms, tether forces, obstacles, checkpoints, and completion.

The repository still contains the retired native prototype as a comparison fixture while the migration is verified. It is not referenced by the .NET build or deployment artifact.

See the [deployment runbook](docs/deployment.md), [architecture](docs/architecture.md), [networking](docs/networking.md), and [game design](docs/game-design.md).

## Deploy prerequisites

- Node.js 20.19 or newer
- A Vercel personal Hobby account
- Vercel CLI
- .NET 10 SDK and a Redis instance for the backend
- `REDIS_URL` configured on Render, and `LinkedUp__ClientOrigin` set to the Vercel origin
- `LINKEDUP_API_URL` configured on Vercel with the public Render HTTPS origin

Install and verify locally:

```sh
npm ci
npm test
env LINKEDUP_API_URL=https://linked-up-dotnet.onrender.com npm run build
```

The .NET backend requires Redis locally. The browser development server reads `browser/wwwroot/appsettings.Development.json`; production builds require `LINKEDUP_API_URL`.

## Local development

Run Redis, the backend on port 5100, and the Blazor dev server on port 5173. Open two fresh browser tabs, create a two-player room, join using the invite code, and start the match. The integration suite performs the same lifecycle with real SignalR presence and gameplay WebSockets.

## Verification

- `npm test` — browser bridge, API, client, and managed simulation tests.
- `npm run build` — Release Blazor publish copied into `.vercel/output/static` (requires `LINKEDUP_API_URL`).
- `env LINKEDUP_API_URL=https://linked-up-dotnet.onrender.com npm run build` — production artifact.
- `git diff --check` — patch hygiene.
