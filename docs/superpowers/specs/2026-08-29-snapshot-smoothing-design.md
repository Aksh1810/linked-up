# Snapshot Smoothing Design

**Date:** 2026-08-29
**Milestone:** Phase 5 — Snapshot Smoothing
**Status:** Approved

## Goal

Make the Phase 4 two-browser loop feel responsive and visually smooth while
preserving the C++ simulation as the only physics authority.

Phase 5 adds:

- per-player server acknowledgement of applied input sequences;
- buffered interpolation for the remote robot;
- immediate local movement and jump prediction;
- reconciliation by replaying unacknowledged inputs;
- smooth presentation of small corrections;
- deterministic coverage for delayed, jittered, reordered, and skipped
  snapshots.

## Non-goals

Phase 5 does not add:

- browser-side tether, collision, or obstacle physics;
- lag compensation or rollback of the authoritative simulation;
- extrapolation beyond the newest snapshot;
- shooter-grade networking;
- transport compression or a binary protocol;
- WebTransport, gameplay tickets, reconnection, rooms, or match lifecycle;
- production network-conditioning switches.

WebSockets remain the local prototype transport. Reliable ordered delivery does
not make buffering unnecessary: snapshots still arrive at 20 Hz and may be
delayed unevenly by scheduling and the network.

## Authority Boundary

The browser predicts only the local player's unconstrained movement and jump.
It never predicts tether forces, player collisions, platform edges, team
failure, or resets. Every authoritative snapshot can therefore correct the
prediction, and the server always wins.

Remote players and authoritative tether values are presentation-only samples
from the snapshot buffer. No remote input is inferred.

## Wire Contract

Each serialized player state gains one unsigned integer:

```json
{
  "id": "blue",
  "acknowledgedInput": 42,
  "position": { "x": -1, "y": 1, "z": 0 },
  "velocity": { "x": 0, "y": 0, "z": 0 },
  "grounded": true
}
```

`acknowledgedInput` is the last input sequence that the simulation actually
applied for that player before producing the snapshot. It is not merely the
last sequence received by the networking thread.

The server networking state stores the latest validated input and sequence for
each slot. At the start of a simulation tick, the simulation thread copies both
values together. It applies those inputs, steps physics, and serializes the
result with the copied sequences. An input received after that copy cannot be
acknowledged until a later tick.

Disconnecting a player resets that slot's input and sequence to zero. A newly
connected browser starts a fresh sequence at one.

No other message shape changes. Tick and snapshot rates continue to come from
the welcome message.

## Snapshot Buffer

A pure TypeScript `SnapshotBuffer` owns received authoritative snapshots and
their local monotonic arrival times. It has no Babylon.js or WebSocket code.

Default tuning:

```text
interpolation delay: 6 server ticks (100 ms at 60 Hz)
maximum snapshots:   32
```

Both values live in one exported smoothing configuration object. The server
tick rate is supplied by the welcome message rather than duplicated as an
assumption throughout the client.

### Insertion rules

- Within one `resetCount`, ignore a snapshot whose tick is not newer than the
  newest buffered tick.
- When `resetCount` increases, clear the buffer and accept the new snapshot
  even though its tick may restart at zero.
- Ignore snapshots from an older `resetCount`.
- Remove oldest entries when the fixed capacity is exceeded.

### Sampling rules

The client estimates current server tick from the newest snapshot tick plus
elapsed monotonic time at the welcome tick rate. It samples at:

```text
estimated server tick - interpolation delay ticks
```

For two snapshots bracketing the target tick, linearly interpolate player
position, velocity, separation, and tether tension. Use the newer snapshot's
grounded flag once the interpolation fraction reaches one half. IDs,
acknowledgements, and reset count are never interpolated.

If the target is older than the buffer, hold the oldest snapshot. If it is
newer than the buffer, hold the newest snapshot. Phase 5 does not extrapolate.

## Local Prediction and Reconciliation

A pure TypeScript `PredictionReconciler` owns:

- the current predicted local motion state;
- successfully sent inputs that have not been acknowledged;
- a presentation correction offset;
- the active reset count.

The predictor reuses the existing tested `stepMotion` function with a network
configuration matching the server's development values: 60 Hz steps, speed 6,
acceleration 30, jump speed 7, gravity -9.81, and floor center height 1. The
small remaining differences from Jolt, tether forces, and collision response
are expected and are corrected by reconciliation.

### Sending input

Only a successfully sent input enters prediction history. The reconciler
immediately advances one fixed step using the already world-space movement
axes. Failed sends retain a queued jump through the existing input controller
behavior and do not create prediction history.

History is capped at 240 inputs, four seconds at 60 Hz. Reaching the cap means
the acknowledgement stream is unhealthy; the reconciler discards history and
hard-resets to the next authoritative local state instead of growing memory
without bound.

### Receiving a snapshot

For the local player's state:

1. reject stale snapshot/reset combinations through `SnapshotBuffer`;
2. remove pending inputs whose sequence is at or below
   `acknowledgedInput`;
3. replace predicted state with the authoritative state;
4. replay remaining inputs in sequence order at one fixed step each;
5. compute the difference between the previously displayed position and the
   replayed prediction.

If reset count changed or correction distance exceeds 2 metres, snap to the
new prediction. Otherwise preserve the difference as a visual correction
offset and exponentially decay it with an 80 ms half-life. Physics state is
never blended; only the displayed position receives the decaying offset.

## Rendering

`game.ts` keeps ownership of Babylon.js objects and animation:

- local robot position, animation speed, and camera target use the reconciled
  predicted state;
- remote robot position and animation use the buffered sample;
- the tether connects the displayed local and remote robot sockets;
- tether tension uses the interpolated authoritative value;
- tick telemetry shows the newest received authoritative tick, not the delayed
  render tick.

The latest authoritative snapshot still controls readiness and reset handling.
The existing Phase 4 direct-snapshot assignment is removed from the render
path rather than retained as a second competing source.

## Failure and Reset Handling

- A newer `resetCount` clears snapshot history, pending prediction inputs, and
  correction offset before rendering the respawn.
- A stale tick or older reset is ignored.
- Missing a few snapshots causes the renderer to hold the newest sample; it
  does not manufacture physics.
- An input acknowledgement beyond the newest pending sequence is accepted and
  simply clears all older pending inputs.
- Non-finite values remain rejected by the existing protocol decoder.
- Disconnect behavior remains unchanged.

## Testing

### C++ protocol checks

Extend the existing assertion test to prove both player acknowledgement values
survive snapshot serialization. The server integration smoke must prove a sent
sequence appears in a later snapshot and is never acknowledged before it is
applied.

### Pure TypeScript checks

One focused test file covers:

- midpoint interpolation and discrete grounded selection;
- holding oldest/newest samples without extrapolation;
- stale and reordered snapshot rejection;
- reset-count buffer clearing;
- fixed buffer capacity;
- immediate prediction after a sent input;
- removal of acknowledged history;
- replay of unacknowledged inputs;
- small correction decay and large correction snap;
- history-cap recovery.

Delayed, jittered, and skipped delivery is represented by deterministic arrival
times and missing/reordered sample sequences. This gives repeatable coverage
without adding production test switches.

### Browser proof

Retain the Phase 4 two-browser authority assertions. Add a Playwright
`route_web_socket` proxy before navigation that connects to the real server,
forwards client input immediately, and conditions server snapshots by holding
frames for one or two snapshot intervals and dropping a deterministic subset.
Welcome and error messages pass through immediately.

The proof must show both pages remain connected, both authoritative players
respond independently, ticks continue advancing, no page/console errors occur,
and the visual scene remains stable under the conditioned stream.

## Documentation

Update `README.md`, `docs/architecture.md`, and `docs/networking.md` with:

- the acknowledgement field;
- the 100 ms default interpolation delay;
- the conservative local prediction boundary;
- correction and reset behavior;
- the fact that WebSockets remain reliable and WebTransport remains deferred.

## Stop Condition

Phase 5 is complete when protocol, buffer, prediction, reconciliation, reset,
and conditioned two-browser checks pass; the production client shows smooth
remote movement and immediate local response; and no lobby, transport,
backend, or browser tether-physics scaffolding has been added.
