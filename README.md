# Linked-Up

Linked-Up is a planned 2–4 player cooperative browser climbing game where
small robots are physically connected by an energy tether. One player's jump
or fall can pull the rest of the team.

The repository currently contains a playable Phase 5 network slice:

- a loopback C++ WebSocket server running the two-player Jolt simulation at
  60 Hz and broadcasting authoritative snapshots at 20 Hz;
- two Babylon.js browser pages that independently control Blue and Orange and
  render the same robots, bounded platform, and energy tether;
- a six-tick snapshot buffer for the remote robot plus immediate local
  movement/jump prediction and authoritative reconciliation.

Rooms and the full climbing world come in later milestones.

## Architecture

```text
Browser ── HTTPS + SignalR ── ASP.NET Core ── Redis
   │                                │
   │                                └── gRPC ── C++ simulation
   └──────── gameplay transport ─────────────── C++ simulation
```

- Browser: input and presentation
- C++: authoritative physics and match outcome
- ASP.NET Core: room and match lifecycle
- Redis: expiring room state

See [architecture](docs/architecture.md), [game design](docs/game-design.md),
and [networking](docs/networking.md).

## Prerequisites

- CMake 3.20 or newer
- A C++20 compiler
- Node.js 22.12 or newer (or 20.19)
- Git and internet access during the first configure, which fetches pinned
  Jolt Physics `v5.6.0`, Crow `v1.3.3`, and Asio `1.30.2` into the ignored
  build directory

## Build and run

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4
ctest --test-dir build --output-on-failure
```

The C++ checks cover authoritative tether behavior and the gameplay JSON trust
boundary.

## Run the two-player network slice

Start the gameplay server:

```sh
./build/simulation/linked-up-server
```

In another terminal, install and start the browser client:

```sh
npm --prefix client install
npm --prefix client test
npm --prefix client run build
npm --prefix client run dev
```

Open both pages:

- `http://127.0.0.1:5173/?player=blue`
- `http://127.0.0.1:5173/?player=orange`

Focus each canvas and use WASD, Space, and mouse drag. Each player slot accepts
one browser at a time.

Phase 5 binds gameplay to `127.0.0.1:9002` and is local-development only. It
uses JSON over WebSockets with no lobby or gameplay tickets. Disconnecting
immediately neutralizes that player's input and frees the slot.

## Next milestone

Add the ASP.NET Core lobby and Redis-backed room lifecycle. WebTransport
remains a later transport evaluation.
