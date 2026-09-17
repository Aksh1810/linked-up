# Linked-Up

<<<<<<< HEAD
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
=======
Linked-Up is a 2–4 player cooperative browser climbing game. Color-coded robots share an energy tether, so a jump, fall, or rescue affects the whole crew. Players climb through Grass, Construction, Industrial, Sky, and Summit regions, using checkpoints and teamwork to reach the finish.

The active implementation uses **.NET 10**, a **Blazor WebAssembly** browser client, **Babylon.js** rendering, and an authoritative **ASP.NET Core/BepuPhysics** backend. Vercel hosts the static browser application; Render hosts the backend; Redis stores temporary rooms.

> The .NET migration is still being integrated. The browser creates and joins rooms, but it does not yet register SignalR lobby presence, which the backend requires before starting a match. See [current limitations](#current-limitations) before an end-to-end playtest.

## Gameplay

1. Create a room for two, three, or four players.
2. Share its four-character code or use **Copy invite link**. The current invite format is `/?room=AB23`.
3. The creator becomes Blue Robot and lobby host. Guests occupy the available Orange, Green, and Purple slots.
4. The host selects a map and starts when the room is full. The backend also requires every player to be registered with the lobby hub.
5. Once every gameplay connection is ready, the server sends a three-second countdown and begins the climb.
6. Coordinate jumps and keep a teammate grounded for rescues. The simulation resets a failed team to its current checkpoint and finishes when the whole roster reaches the summit.

### Controls

| Control | Action |
| --- | --- |
| WASD | Move along the world's horizontal axes |
| Space | Jump; hold while hanging to climb toward a grounded teammate |
| Mouse drag | Orbit the third-person camera |

The current browser bridge sends world-axis movement; it does not yet rotate WASD input with the camera. Keyboard and mouse are the implemented controls.

### Maps

| Map | ID | Route focus |
| --- | --- | --- |
| Classic Ascent | `classic-ascent` | The default mixed-obstacle climb |
| Relay Ridge | `relay-ridge` | Alternating platforms, regrouping, and rescue ledges |
| Crane Shift | `crane-shift` | Shuttles, elevators, and rotating machinery |
| Windworks | `windworks` | Fans, conveyors, and exposed platforms |

The managed simulation owns obstacle dimensions, movement, collisions, tether forces, checkpoints, and completion. Babylon.js displays server snapshots rather than deciding gameplay outcomes.

## Architecture

```text
Vercel: Blazor WebAssembly + Babylon.js
       │ HTTPS room requests
       │ WebSocket gameplay
       ▼
Render: ASP.NET Core + BepuPhysics simulation
       │
       ▼
Redis: expiring rooms and hashed session credentials
```

| Component | Responsibility |
| --- | --- |
| `browser/` | Blazor lobby, room API calls, invite links, and JavaScript rendering bridge |
| `backend/LinkedUp.Api/` | Room endpoints, SignalR presence, match allocation, gameplay WebSockets, and health checks |
| `backend/LinkedUp.Simulation/` | BepuPhysics 2.4.0 simulation and four route configurations |
| `backend/LinkedUp.Contracts/` | Shared C# room and gameplay messages; gameplay protocol version 2 |
| Redis | Room membership, selected map, host identity, and session-token hashes |

The backend advances physics at **60 Hz** and broadcasts snapshots at **20 Hz**. Browsers send input, not authoritative transforms. The active architecture does not use WebRTC, STUN, TURN, or host-browser physics; the lobby host controls room actions, not the simulation.

Live matches and lobby presence are held in one backend process. Redis does not preserve live physics state, and restarting the backend ends its matches. Multiple backend replicas are not supported without additional coordination.
>>>>>>> be233f3 (docs: update README with gameplay details and architecture)

## Requirements

- .NET SDK **10.0.300**, or a compatible .NET 10 feature band allowed by [global.json](global.json).
- Node.js **20.19+** on the Node 20 line, or **22.12+**, for the Vite rendering build.
- Docker Compose for the supplied local Redis service, or an existing Redis instance.
- A browser supporting WebAssembly, WebGL, and WebSockets.
- Network access on the first build to restore npm and NuGet packages.

<<<<<<< HEAD
- Node.js 20.19 or newer
- A Vercel personal Hobby account
- Vercel CLI
- .NET 10 SDK and a Redis instance for the backend
- `REDIS_URL` configured on Render, and `LinkedUp__ClientOrigin` set to the Vercel origin
- Optional `LINKEDUP_API_URL` on Vercel to override the default public backend, `https://linked-up-dotnet.onrender.com`
=======
CMake, C++, Jolt, gRPC, and Emscripten are needed only for the retained legacy implementation, not the active .NET application.
>>>>>>> be233f3 (docs: update README with gameplay details and architecture)

## Local setup

Run these commands from the repository root.

### 1. Install dependencies and start Redis

```sh
npm ci
<<<<<<< HEAD
npm test
env LINKEDUP_API_URL=https://linked-up-dotnet.onrender.com npm run build
```

The .NET backend requires Redis locally. The browser development server reads `browser/wwwroot/appsettings.Development.json`; production builds use the public Render backend by default. Set `LINKEDUP_API_URL` when deploying against another backend.

## Local development

Run Redis, the backend on port 5100, and the Blazor dev server on port 5173. Open two fresh browser tabs, create a two-player room, join using the invite code, and start the match. The integration suite performs the same lifecycle with real SignalR presence and gameplay WebSockets.
=======
dotnet restore LinkedUp.slnx
docker compose -f infrastructure/docker-compose.yml up -d redis
```

The Compose service binds Redis to `127.0.0.1:6379`, the backend's default address.

### 2. Run the backend

In a separate terminal:

```sh
dotnet run --project backend/LinkedUp.Api/LinkedUp.Api.csproj --urls http://127.0.0.1:5100
```

Check process health and Redis readiness:

```sh
curl --fail http://127.0.0.1:5100/health/live
curl --fail http://127.0.0.1:5100/health/ready
```

The default gameplay URL is `ws://127.0.0.1:5100/gameplay`, and the allowed browser origin is `http://127.0.0.1:5173`. If you change a port or hostname, update the matching configuration below.

### 3. Build and serve the browser

```sh
LINKEDUP_API_URL=http://127.0.0.1:5100 npm run build
browser/node_modules/.bin/vite artifacts/browser/wwwroot --host 127.0.0.1 --port 5173 --strictPort
```
>>>>>>> be233f3 (docs: update README with gameplay details and architecture)

Open `http://127.0.0.1:5173`. Use separate tabs or browser profiles for separate players. The match-start integration limitation above still applies.

<<<<<<< HEAD
- `npm test` — browser bridge, API, client, and managed simulation tests.
- `npm run build` — Release Blazor publish copied into `.vercel/output/static`, using the public backend by default.
- `env LINKEDUP_API_URL=https://linked-up-dotnet.onrender.com npm run build` — production artifact.
- `git diff --check` — patch hygiene.
=======
The root build script installs `browser/` npm dependencies, bundles Babylon.js, publishes Blazor in Release mode, and injects the API origin. It produces:

- `artifacts/browser/wwwroot/`: published browser files.
- `.vercel/output/static/`: browser files for deployment.
- `.vercel/output/config.json`: static Build Output API routes and backend-specific security headers.

If `dotnet` is absent, the build script downloads SDK 10.0.300 into `.cache/dotnet`. Install the SDK normally for local backend development and tests. The old `client/` Vite application is not the current browser application.

## Configuration

ASP.NET Core uses double underscores in environment variables for nested configuration keys.

| Variable | Where | Default / purpose |
| --- | --- | --- |
| `LINKEDUP_API_URL` | Browser build / Vercel | Required backend origin; HTTPS in production, HTTP allowed only for loopback development |
| `REDIS_URL` | Backend / Render | Redis connection using `redis://` or `rediss://`; overrides `LinkedUp__Redis` |
| `LinkedUp__Redis` | Backend | `127.0.0.1:6379`; StackExchange.Redis connection configuration |
| `LinkedUp__ClientOrigin` | Backend | `http://127.0.0.1:5173`; exact allowed CORS and WebSocket origin |
| `LinkedUp__RoomTtlMinutes` | Backend | `120`; room expiration refreshed by room access |
| `LinkedUp__KeyPrefix` | Backend | `linked-up:dotnet:v2:room:`; room namespace |
| `Match__GameplayUrl` | Backend | `ws://127.0.0.1:5100/gameplay`; production must use `wss://` |
| `Match__MaxMatches` | Backend | `8`; concurrent match limit, configurable from 1 to 64 |

On Render, `RENDER_EXTERNAL_HOSTNAME` supplies the public `wss://.../gameplay` URL unless `Match__GameplayUrl` is explicitly set.

`LINKEDUP_API_URL` must be an origin without credentials, a path, query parameters, or a fragment. It is public configuration, not a secret; changing it requires rebuilding the browser. [.env.example](.env.example) lists this build variable, not a complete backend configuration template. The build script reads the process environment and does not automatically load a root `.env` file.

Never commit Redis credentials, room tokens, or gameplay tickets. Redis credentials belong on the backend, not in browser configuration.

## API and gameplay protocol

All active endpoints below belong to the **ASP.NET backend**, not the static Vercel origin.

| Method | Route | Purpose / authentication |
| --- | --- | --- |
| POST | `/api/rooms` | Create with `{ "capacity": 2 }`; returns a private player session |
| GET | `/api/rooms/{code}` | Read public room state |
| POST | `/api/rooms/{code}/join` | Join a waiting room; returns a private player session |
| POST | `/api/rooms/{code}/leave` | Leave a lobby; requires `X-Player-Token` |
| POST | `/api/rooms/{code}/map` | Select `{ "mapId": "windworks" }`; host token required |
| POST | `/api/rooms/{code}/start` | Allocate a match; host token, full room, and lobby presence required |
| POST | `/api/rooms/{code}/launch` | Obtain a gameplay ticket; player token required |
| SignalR | `/hubs/lobby` | `Subscribe(roomCode, sessionToken)` registers presence; receives `RoomUpdated` and private `MatchReady` messages |
| WebSocket | `/gameplay` | Authenticate with a `join` message containing match ID and ticket; exchange inputs and snapshots |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Redis readiness |

Room tokens are stored as SHA-256 hashes in Redis; public room responses omit credentials. Gameplay tickets expire after two minutes and are consumed on connection. The gameplay protocol rejects unknown JSON fields and invalid input axes or sequences.

Incoming gameplay messages are limited to 2 KiB, with at most 120 input messages per player per second. Room endpoints use a 120-request-per-minute per-IP limiter; HTTP request bodies are capped at 4 KiB.

Disconnected players and inputs stale for more than half a second receive neutral input. Matches expire after 30 minutes, after 30 seconds with no connected players, or two minutes after completion. The full roster must be ready before the countdown.

## Tests and checks

Start local Redis before running the complete suite. The .NET Redis integration tests use database **15** and isolated test-key prefixes. Use a dedicated local/test instance, not production Redis.

```sh
npm test
```

The root command runs all projects in [LinkedUp.slnx](LinkedUp.slnx). To run only simulation tests, which do not require Redis:

```sh
dotnet test backend/LinkedUp.Simulation.Tests/LinkedUp.Simulation.Tests.csproj -m:1 /p:UseSharedCompilation=false
```

To run API tests with a different test Redis connection:

```sh
LinkedUp__Redis=127.0.0.1:6379,defaultDatabase=15 dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj -m:1 /p:UseSharedCompilation=false
```

For a browser build check, set `LINKEDUP_API_URL` and run `npm run build`. For a release check, verify backend readiness, room creation/joining, presence registration, host-only map/start actions, the countdown, and snapshots in two isolated browsers. Resolve the integration gaps below before expecting that check to pass.

The retained `scripts/deployed-smoke.mjs` and `scripts/verify-vercel-build.mjs` target the **historical Vercel-only architecture**. They are not valid release gates for the current .NET deployment.

## Deployment

1. Create a Render Blueprint from [render.yaml](render.yaml). It builds the ASP.NET service using [infrastructure/Dockerfile](infrastructure/Dockerfile).
2. Supply `REDIS_URL` and set `LinkedUp__ClientOrigin` to the exact final Vercel browser origin. The Blueprint sets eight concurrent matches and checks `/health/ready`.
3. Set `LINKEDUP_API_URL` in Vercel Preview and Production to the Render backend's HTTPS origin.
4. Deploy from the repository root using [vercel.json](vercel.json), or use the Vercel CLI:

   ```sh
   vercel login
   vercel link
   vercel pull --yes --environment=production
   vercel build --prod --yes
   vercel deploy --prebuilt --prod
   ```

5. Confirm that published browser `appsettings.json` points to the backend, `/health/ready` succeeds, and the browser origin matches the backend allowlist.

Vercel receives static Blazor output; legacy `api/` Functions are not part of the generated deployment. Preview deployments also need an allowed backend origin; the default backend configuration accepts one exact client origin.

The supplied Render Blueprint selects the free service plan. Account for provider cold starts and resource limits, and keep the backend to one instance while matches and presence are process-local. Restarting the backend invalidates live matches; players must create a new room.

See [docs/deployment.md](docs/deployment.md). Its .NET section is current; the later Vercel-only runbook is historical.

## Current limitations

- **Match startup:** the browser polls rooms every 1.5 seconds but does not connect to `/hubs/lobby` or call `Subscribe`. The backend rejects a browser-only start with `Players not present`.
- **Session recovery:** the active browser keeps player sessions in memory. Reloading loses the session; reconnect/rejoin recovery is not implemented.
- **Leaving a match:** the browser closes its gameplay socket and then calls the room leave endpoint, but the room domain rejects leaving an `inGame` room. This flow still needs integration.
- **Presentation:** the new renderer is a basic blockout. Camera-relative movement, snapshot smoothing, tether visuals, a completion screen, and the older client's settings/accessibility presentation have not all been ported.
- **Scaling:** no distributed simulation ownership, presence backplane, or restart recovery.
- **Scope:** no accounts, persistent progression, chat, combat, or cosmetic system.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build asks for `LINKEDUP_API_URL` | Set it in the build process or Vercel environment |
| Backend is live but not ready | Redis connectivity and credentials |
| Browser API calls fail | Published `ApiBaseUrl`, backend availability, mixed-content restrictions, and exact `LinkedUp__ClientOrigin` |
| Start reports `Players not present` | The SignalR presence integration gap above |
| Gameplay disconnects | Gameplay URL, allowed origin, ticket expiry, input rate, and backend restarts |
| No game slots available | Concurrent match limit; empty and expired matches are cleaned up automatically |

## Repository guide

```text
browser/                         Active Blazor client and Babylon.js bridge
backend/LinkedUp.Api/            Room API, presence, and match hosting
backend/LinkedUp.Contracts/      Shared C# wire contracts
backend/LinkedUp.Simulation/     Managed BepuPhysics simulation and routes
backend/*.Tests/                API and simulation test projects
infrastructure/                 Redis Compose service and backend Dockerfile
render.yaml                     Backend deployment Blueprint
scripts/build-blazor.sh         Active browser build/publish pipeline
scripts/configure-browser.mjs   API configuration and static Vercel routes
client/, api/, shared/           Retained TypeScript/WebRTC implementation
simulation/, contracts/proto/   Retained C++/Jolt and gRPC implementation
docs/                           Design notes and deployment history
```

The older stack remains for reference and simulation engineering. Its `?player=blue` / `?player=orange` loopback mode, `scripts/build-wasm.sh`, native CMake targets, and Wasm/native parity checks apply to the legacy client, not Blazor.

Historical [architecture](docs/architecture.md), [networking](docs/networking.md), and [game-design](docs/game-design.md) notes contain earlier-phase behavior. Use the current C# implementation and this README for the active paths.
>>>>>>> be233f3 (docs: update README with gameplay details and architecture)
