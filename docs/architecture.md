# Architecture

Linked-Up keeps four ownership boundaries:

| Component | Owns |
| --- | --- |
| Browser | Controls, camera, rendering, animation, audio, interpolation, and local presentation |
| C++ simulation | Fixed-step physics, player state, tether forces, obstacles, checkpoints, timer, and completion |
| ASP.NET Core | Temporary identity, rooms, lobby presence, host rules, and match lifecycle |
| Redis | Expiring room and session state |

The browser sends player intent; it never sends trusted positions. ASP.NET
coordinates match creation over gRPC but stays out of the high-frequency
gameplay path.

```text
Browser clients
  ├── HTTPS / SignalR ── ASP.NET Core ── Redis
  │                           └── gRPC ── C++ match lifecycle
  └── low-latency gameplay ───────────── C++ simulation
```

## Phase 5 implementation

`PrototypeSimulation` owns a small Jolt world, one static platform, two dynamic
capsule players, validated inputs, and a configurable tether. `step()` advances
exactly one fixed tick; the caller owns wall-clock scheduling. Snapshots expose
plain positions, velocities, grounded state, separation, tension, tick, and
reset count.

`linked-up-server` owns one loopback-only match. Crow reserves Blue and Orange
WebSocket slots, validates JSON input, copies the latest intent into the fixed
60 Hz simulation loop, and broadcasts one snapshot every third tick. Each
player state acknowledges the last input sequence actually copied and applied
by that tick. A disconnect assigns neutral input, resets its acknowledgement,
and frees the slot.

The browser owns only input and presentation. `GameplayConnection` isolates the
native WebSocket and wire codec from Babylon.js. `game.ts` sends camera-relative
intent. A pure 32-entry `SnapshotBuffer` renders the remote robot six ticks
behind the estimated server tick. A pure `PredictionReconciler` immediately
steps local movement and jump, then replaces physics state with each
authoritative result and replays unacknowledged inputs. Only its displayed
position receives an 80 ms correction; resets and corrections over two metres
snap directly. The requested local robot remains the camera target.

Tether forces, collisions, platform limits, grounded truth, and resets remain
server-only. The browser interpolates authoritative tether tension and connects
the tether between the two displayed robot sockets; it does not simulate tether
physics.

This milestone deliberately has one match and two named development slots.
ASP.NET Core, Redis, gRPC match orchestration, tickets, and WebTransport are
not implemented yet.
