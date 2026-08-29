# Networking

Phase 5 uses the direct browser-to-C++ authoritative loop with JSON over a
WebSocket. The server listens only on `127.0.0.1:9002`; this is a local
development transport, not the final deployed connection.

## Ownership and rates

- Browsers send movement and jump intent, never trusted transforms.
- C++ validates input and advances Jolt at a fixed 60 Hz.
- C++ broadcasts the same authoritative state to both browsers at 20 Hz.
- Browsers predict only their local unconstrained movement and jump.
- Remote robots and tether tension come from delayed authoritative snapshots.

## Connection

The development endpoints are:

```text
ws://127.0.0.1:9002/game?player=blue
ws://127.0.0.1:9002/game?player=orange
http://127.0.0.1:9002/health
```

One connection may own each player slot. A welcome confirms the assigned slot
and rates. A disconnect immediately replaces that player's latest input with a
neutral input and frees the slot; the simulation continues for the remaining
player.

## JSON protocol

Clients send text messages no larger than 512 bytes:

```json
{"type":"input","sequence":42,"clientTick":208,"moveX":0,"moveZ":1,"jump":false}
```

The server requires finite movement axes in `[-1, 1]`, strictly increasing
sequences, and at most 120 messages per one-second window. Binary, malformed,
out-of-range, stale, and excessive input closes the connection with a stable
JSON error first.

Snapshots contain server tick, reset count, separation, normalized tether
tension, and the ordered Blue/Orange positions, velocities, grounded flags,
and applied input acknowledgements:

```json
{"type":"snapshot","tick":180,"resetCount":0,"separation":2,"tetherTension":0,"players":[{"id":"blue","acknowledgedInput":42,"position":{"x":-1,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true},{"id":"orange","acknowledgedInput":37,"position":{"x":1,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true}]}
```

`acknowledgedInput` is the last sequence actually applied before that snapshot,
not merely the latest input received by the networking thread.

## Snapshot smoothing

The browser retains at most 32 snapshots and samples six server ticks (100 ms)
behind the estimated server clock. It linearly interpolates remote position,
velocity, separation, and tether tension and never extrapolates beyond the
newest state. Duplicate, reordered, and older-reset snapshots are ignored; a
newer reset clears the buffer.

Successfully sent local inputs are predicted with the shared movement step.
On each authoritative snapshot the client removes acknowledged history,
replays the remaining inputs, and applies only a visual correction offset. The
offset has an 80 ms half-life; reset changes and corrections over two metres
snap immediately. Tether forces, collisions, grounded truth, and resets are
never predicted in the browser.

## Deferred boundaries

The room/lobby path will use ASP.NET Core, SignalR, and Redis. ASP.NET Core will
coordinate C++ match lifecycle over gRPC, while high-frequency gameplay stays
direct between browser and C++. Gameplay tickets, reliable match events,
WebTransport traffic classes, and production latency simulation remain
deferred. Network delay/drop conditioning exists only in the browser test
harness, not in production code.
