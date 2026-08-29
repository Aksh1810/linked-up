# Basic Network Loop Design

**Date:** 2026-08-29
**Milestone:** Phase 4 — Basic Network Loop
**Status:** Approved design

## Goal

Two browser tabs control Blue and Orange independently while one C++ process
runs the existing authoritative two-player tether simulation. Both tabs render
the same server state.

The slice proves this path end to end:

```text
Browser input -> C++ WebSocket server -> PrototypeSimulation
                                           |
Both browsers <- authoritative snapshot ---+
```

Correctness is the acceptance criterion. Snapshot smoothing, prediction, and
reconciliation remain Phase 5.

## Scope

Phase 4 includes:

- one local C++ gameplay server;
- one fixed two-player match;
- Blue and Orange browser slots selected by URL;
- browser-native WebSocket connections;
- validated, sequenced player input;
- 60 Hz authoritative simulation;
- 20 Hz JSON snapshots;
- two rendered robots and one tether;
- connection, rejection, and disconnect feedback;
- protocol unit tests and a two-browser end-to-end check.

Phase 4 does not include:

- ASP.NET Core, SignalR, Redis, rooms, or invite links;
- gameplay tickets or reconnection;
- TLS or public deployment;
- Protocol Buffers or gRPC;
- WebTransport;
- snapshot interpolation, prediction, or reconciliation;
- three- or four-player tether topology;
- final world geometry or gameplay systems.

The server binds to loopback. `LINKED_UP_GAMEPLAY_PORT` can override its default
port `9002` for local tests. The URL slot is a development harness, not a
substitute for the future lobby and ticket flow.

## Dependency Choice

Pin Crow `v1.3.3` through CMake `FetchContent`. Crow supplies the WebSocket
server, payload limits, HTTP health route, JSON reader/writer, and standalone
Asio integration. No second JSON or networking library is added.

WebSocket++ was rejected because it would add separate Asio and JSON
dependencies around an older library. WebTransport was rejected for this slice
because HTTP/3, TLS, and deployment work would obscure the gameplay proof.

## C++ Components

### `PrototypeSimulation`

Remain the sole physics owner. Its public input and snapshot types are reused;
network code does not duplicate movement or tether rules.

### Gameplay protocol

A small protocol module parses client input and serializes welcome, snapshot,
and error messages. Parsing is independent of socket callbacks so malformed,
stale, and out-of-range inputs have direct unit coverage.

### Gameplay server

One server object owns:

- the two slot assignments;
- each connection's last accepted sequence and rate window;
- the latest validated input for each player;
- one `PrototypeSimulation`;
- a fixed-step simulation thread;
- snapshot broadcasting.

Crow handles socket I/O. The simulation is touched only by the fixed-step
thread. A small mutex protects slot/session metadata and the latest inputs
crossing from Crow callbacks to the simulation thread.

The simulation loop schedules against `std::chrono::steady_clock`, advances in
exact `1 / 60` second simulation steps, and broadcasts every third tick. If the
process falls behind, it records the overrun and resumes from the current time
instead of running an unbounded catch-up loop.

## Connection Lifecycle

Development URLs are:

```text
http://localhost:5173/?player=blue
http://localhost:5173/?player=orange
```

The client connects to:

```text
ws://127.0.0.1:9002/game?player=blue
ws://127.0.0.1:9002/game?player=orange
```

The gameplay URL is configurable with `VITE_GAMEPLAY_URL`; the default remains
the loopback endpoint above.

Connection sequence:

1. The WebSocket opens and the server validates the requested player query
   value.
2. The server atomically reserves the slot. Invalid or duplicate requests
   receive an error message and close with policy-violation status.
3. An accepted connection receives a `welcome` message confirming the player and
   rates.
4. The client begins sending input and rendering snapshots.
5. On disconnect, the server immediately replaces that player's input with a
   neutral input and frees the slot.

The simulation continues when a player disconnects. Pause/reconnect policy is a
later match-lifecycle concern.

## Wire Protocol

Messages are UTF-8 JSON text. Binary messages and payloads larger than 512
bytes are rejected.

### Client input

```json
{
  "type": "input",
  "sequence": 42,
  "clientTick": 208,
  "moveX": 0.0,
  "moveZ": 1.0,
  "jump": false
}
```

The connection owns player identity, so input messages cannot select or
impersonate a player. `moveX` and `moveZ` are world-space intent produced from
the local camera orientation before transmission.

### Server welcome

```json
{
  "type": "welcome",
  "player": "blue",
  "tickRate": 60,
  "snapshotRate": 20
}
```

### Server snapshot

```json
{
  "type": "snapshot",
  "tick": 180,
  "resetCount": 0,
  "separation": 3.25,
  "tetherTension": 0.18,
  "players": [
    {
      "id": "blue",
      "position": { "x": -1.0, "y": 1.0, "z": 0.0 },
      "velocity": { "x": 0.0, "y": 0.0, "z": 0.0 },
      "grounded": true
    },
    {
      "id": "orange",
      "position": { "x": 1.0, "y": 1.0, "z": 0.0 },
      "velocity": { "x": 0.0, "y": 0.0, "z": 0.0 },
      "grounded": true
    }
  ]
}
```

Snapshots contain only current render state. An acknowledged input sequence is
not needed until Phase 5 reconciliation.

### Server error

```json
{
  "type": "error",
  "code": "slot_taken",
  "message": "Orange is already connected."
}
```

Error codes are stable machine-readable strings; messages are concise UI text.

## Input Rules

The browser sends at most 60 input messages per second. The server:

- accepts only JSON objects with the exact required value types;
- rejects non-finite or out-of-range movement;
- requires each movement axis to be in `[-1, 1]`;
- normalizes diagonal input through `PrototypeSimulation`;
- requires strictly increasing sequence numbers;
- permits at most 120 messages in each one-second rate window;
- closes policy-violating connections after sending an error.

WebSocket ordering is sufficient for Phase 4. Replaceable datagrams are deferred
until the WebTransport evaluation.

## Browser Components

### Network client

A single module owns WebSocket creation, input encoding, incoming-message
validation, connection status, and cleanup. It emits typed welcome, snapshot,
and error values; it contains no Babylon.js code.

### Input

`InputController` continues to own keyboard state and jump edge latching. The
game consumes it no more than 60 times per second, converts movement through the
camera yaw, assigns sequence/client tick numbers, and sends it. A jump remains
queued until included in a sent input.

### Rendering

`Game` creates Blue and Orange robot visuals from the existing primitive robot
builder. It applies each authoritative snapshot directly, derives animation
from authoritative velocity/grounded state, follows the assigned robot, and
updates an updatable line between the two tether attachment points.

The visible grass platform matches the authoritative C++ floor extent so a
player does not appear to fall through walkable terrain. Decorative scenery may
remain outside the collision platform if the boundary is visually clear.

The HUD reports connecting, connected player, server tick, and friendly errors.
It does not become a lobby.

## Error Handling

- Missing or invalid player query: client shows a link for each valid local
  slot instead of starting the scene.
- Server unavailable: loading state becomes a retryable connection error.
- Duplicate slot: server sends `slot_taken` and closes with policy-violation
  status; the client explains which alternate URL to use.
- Malformed, oversized, binary, stale, or excessive input: server sends an
  error when possible, closes the connection, neutralizes input, and logs the
  reason.
- Malformed server message: client closes the connection and shows a protocol
  error rather than applying partial state.
- Disconnect: client stops sending input and shows disconnected status; server
  neutralizes and frees the slot.

## Testing

### C++

Protocol checks cover:

- valid input parsing;
- malformed JSON and missing/wrong field types;
- out-of-range input;
- stale sequence rejection;
- snapshot serialization fields and finite values.

Existing movement, jump, tether, malformed-input, and reset tests remain green.

### TypeScript

Node tests cover:

- input JSON encoding and camera-to-world conversion;
- welcome/snapshot validation;
- malformed snapshot rejection;
- player lookup.

Babylon.js rendering is not unit-tested.

### End to end

An automated local check starts the C++ server and Vite, then opens Blue and
Orange pages in Chromium. It proves:

1. both clients receive increasing authoritative ticks;
2. Blue input moves only Blue;
3. Orange input moves only Orange;
4. both clients observe the same player positions and tether state;
5. a third duplicate-slot page receives a friendly rejection;
6. browser consoles contain no unexpected errors;
7. desktop rendering visibly contains two robots and their tether.

## Acceptance

Phase 4 is complete only when two separate browser pages independently control
the two authoritative Jolt bodies and both pages render matching snapshots from
the same C++ process. Passing isolated codec or physics tests alone is not
sufficient.
