# Linked-Up

Linked-Up is a planned 2–4 player cooperative browser climbing game where
small robots are physically connected by an energy tether. One player's jump
or fall can pull the rest of the team.

The repository currently contains the Phase 9 local gameplay slice:

- a Redis-backed ASP.NET Core lobby for temporary 2–4 player rooms, live
  SignalR membership updates, host migration, and host-only start;
- an ASP.NET Core handoff from a full lobby to an in-memory C++ match over
  loopback h2c gRPC;
- a loopback C++ authoritative Jolt server for ordered crews of two to four
  Blue, Orange, Green, and Purple robots, at 60 Hz with snapshots at 20 Hz;
- a browser countdown and direct authenticated WebSocket handoff, with local
  prediction and authoritative smoothing for the dynamic roster.
- four authoritative five-zone blockout routes—Classic Ascent, Relay Ridge,
  Crane Shift, and Windworks—with four team checkpoints each and server-owned
  geometry descriptors for browser rendering.

## Architecture

```text
Browser -- HTTP/SignalR --> ASP.NET Core -- Redis
ASP.NET Core -- h2c gRPC :50051 --> C++ MatchManager
Browser -- ws match + short-lived ticket :9002 --> C++ authoritative match
```

- Browser: input and presentation
- C++: in-memory match admission and authoritative physics
- ASP.NET Core: temporary room membership, host rules, and match orchestration
- Redis: expiring room state

See [architecture](docs/architecture.md), [game design](docs/game-design.md),
and [networking](docs/networking.md).

## Prerequisites

- CMake 3.20 or newer
- A C++20 compiler
- OpenSSL 3 headers and libraries
- .NET 10 SDK
- Node.js 22.12 or newer (or 20.19)
- Docker with Compose
- Git and internet access during the first configure, which fetches pinned
  Jolt Physics `v5.6.0`, Crow `v1.3.3`, and Asio `1.30.2` into the ignored
  build directory

## Build and run

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4
ctest --test-dir build --output-on-failure
```

The C++ checks cover authoritative tether and route behavior plus the gameplay
JSON trust boundary.

## Run a local room-to-match handoff

Install client packages once with `npm --prefix client install`, build the C++
server, then start these four processes in order:

```sh
docker compose -f infrastructure/docker-compose.yml up -d redis
```

```sh
./build/simulation/linked-up-server
```

```sh
env DOTNET_CLI_HOME=/tmp/linked-up-dotnet dotnet run --project backend/LinkedUp.Api --urls http://127.0.0.1:5000
```

```sh
npm --prefix client run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`, choose 2–4 players, and create a room. Use Copy
Invite Link to share the `http://127.0.0.1:5173/room/CODE` URL; each browser
that opens it joins the room and receives live membership and host updates without reloads.
Only the host can choose the map while the room is waiting or start once every
slot is filled; guests see map changes live but cannot edit the selection.
Starting creates an in-memory C++ match using the selected authored route. Each subscribed player receives its own
private `MatchReady` launch, sees `3`, `2`, `1`, `CLIMB!`, then connects
directly to the authoritative server.

For a normal room start, the launch ticket is a short-lived, one-time opaque
credential delivered only through that player's private SignalR message. The
browser retains it only in memory until it creates its direct WebSocket; the
C++ process stores only its SHA-256 digest. Tickets, gameplay snapshots, and
raw ticket values do not enter Redis or public room updates.

Redis is required for room creation, joining, and readiness. The API exposes:

- `http://127.0.0.1:5000/health/live` for process liveness
- `http://127.0.0.1:5000/health/ready` for Redis-backed readiness

## Local-development bypass

With the C++ server and Vite running on loopback, the retained direct pages are
available only for local development:

- `http://127.0.0.1:5173/?player=blue`
- `http://127.0.0.1:5173/?player=orange`

They bypass the lobby and ticketed match handoff, use the C++ server's local
two-player development match, and must not be used to represent the normal room
flow. The gameplay health endpoint is `http://127.0.0.1:9002/health`.

WebTransport, production TLS, a SignalR backplane, and deployment work remain
outside this local slice.
