# Networking

Phase 8 retains the loopback HTTP/SignalR lobby and direct authenticated C++
gameplay match. Local endpoints are intentionally loopback-only; this document
does not describe a production transport or TLS deployment.

## Lobby connection

The browser client at `http://127.0.0.1:5173/` calls the ASP.NET Core API at
`http://127.0.0.1:5000`. Redis must be reachable at `127.0.0.1:6379`.

```text
POST /api/rooms
GET  /api/rooms/{code}
POST /api/rooms/{code}/join
POST /api/rooms/{code}/leave
POST /api/rooms/{code}/start
      /hubs/lobby
GET  /health/live
GET  /health/ready
```

Create and join return a private player token alongside public room state.
Leave and start require that token in `X-Player-Token`; SignalR `Subscribe`
accepts the room code and token. The browser stores its token in per-tab
`sessionStorage`. Redis stores only its SHA-256 hash, and neither public room
responses nor SignalR updates expose it.

Room updates cover joins, explicit leaves, final SignalR disconnects, host
migration, and the host-only `waiting` to `starting` to `inGame` lifecycle.
Once every player is present, ASP.NET makes a deadline-bound h2c gRPC request
to `127.0.0.1:50051`; C++ returns the match ID and one private launch per
player. The API's liveness check does not depend on Redis; readiness does. CORS
permits the local Vite origin only.

## Direct gameplay connection

The C++ process listens at `127.0.0.1:50051` for gRPC and
`127.0.0.1:9002` for gameplay. A normal full-room start receives `MatchReady`
through private SignalR delivery only. Its launch contains an opaque ticket
that is retained in browser memory through the three-second countdown and used
once to open the direct WebSocket. C++ stores and compares only the ticket's
SHA-256 digest; tickets expire after 60 seconds. Ticket values are not part of
Redis, public rooms, or application logs.

## Ownership and rates

- Browsers send movement and jump intent, never trusted transforms.
- C++ validates input and advances Jolt at a fixed 60 Hz.
- C++ broadcasts the authoritative state to every admitted browser at 20 Hz.
- Browsers predict only their local unconstrained movement and jump.
- Remote robots and tether tension come from delayed authoritative snapshots.

## Connection

Normal launches construct the WebSocket endpoint with `match` and `ticket`
query parameters. The values are unique per player and must not be logged:

```text
ws://127.0.0.1:9002/game?match=[match-id]&ticket=[opaque-ticket]
http://127.0.0.1:9002/health
```

### Local-development bypass

The retained direct development pages intentionally bypass match coordination
and tickets. They work only with the loopback C++ server's fixed Blue/Orange
development match:

```text
ws://127.0.0.1:9002/game?player=blue
ws://127.0.0.1:9002/game?player=orange
http://127.0.0.1:9002/health
```

One connection may own each player slot. A welcome confirms the assigned slot
and rates. A disconnect immediately replaces that player's latest input with a
neutral input; the simulation continues for the remaining player.

## JSON protocol

Clients send text messages no larger than 512 bytes:

```json
{"type":"input","sequence":42,"clientTick":208,"moveX":0,"moveZ":1,"jump":false}
```

The server requires finite movement axes in `[-1, 1]`, strictly increasing
sequences, and at most 120 messages per one-second window. Binary, malformed,
out-of-range, stale, and excessive input closes the connection with a stable
JSON error first.

Snapshots contain server tick, reset count, normalized tether tension,
authoritative match state, elapsed ticks, checkpoint index, ordered obstacle
transforms, and the
ordered two-to-four player positions, velocities, grounded
flags, and applied input acknowledgements:

```json
{"type":"snapshot","tick":180,"resetCount":0,"tetherTension":0,"matchState":"running","elapsedTicks":180,"checkpoint":1,"obstacles":[{"id":"lift-1","kind":"movingPlatform","phase":"armed","position":{"x":0,"y":3,"z":9},"rotation":{"x":0,"y":0,"z":0}}],"players":[{"id":"blue","acknowledgedInput":42,"position":{"x":-1,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true},{"id":"orange","acknowledgedInput":37,"position":{"x":1,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true}]}
```

`acknowledgedInput` is the last sequence actually applied before that snapshot,
not merely the latest input received by the networking thread.

## Snapshot smoothing

The browser retains at most 32 snapshots and samples six server ticks (100 ms)
behind the estimated server clock. It linearly interpolates remote position,
velocity, tether tension, and matching obstacle transforms and never extrapolates beyond the
newest state. Duplicate, reordered, and older-reset snapshots are ignored; a
newer reset clears the buffer.

Successfully sent local inputs are predicted with the shared movement step.
On each authoritative snapshot the client removes acknowledged history,
replays the remaining inputs, and applies only a visual correction offset. The
offset has an 80 ms half-life; reset changes and corrections over two metres
snap immediately. Tether forces, collisions, grounded truth, and resets are
never predicted in the browser.

## Deferred boundaries

Reliable match events, a SignalR backplane, WebTransport traffic classes,
production TLS/deployment, and latency simulation remain deferred. Network
delay/drop conditioning exists only in the browser test harness, not in
production code.
