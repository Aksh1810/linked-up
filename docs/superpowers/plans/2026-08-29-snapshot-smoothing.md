# Snapshot Smoothing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smooth the remote robot and make the local robot respond immediately while every correction, tether effect, and collision remains subordinate to authoritative C++ snapshots.

**Architecture:** The C++ server attaches the last actually applied input sequence to each player state. Pure TypeScript `SnapshotBuffer` and `PredictionReconciler` units handle delayed remote sampling and local replay; Babylon.js consumes their presentation states without acquiring physics authority.

**Tech Stack:** C++20, Crow 1.3.3, Jolt Physics 5.6.0, TypeScript 7.0.2, Babylon.js 9.23.0, Node built-in test runner, Python Playwright 1.62

**Spec:** `docs/superpowers/specs/2026-08-29-snapshot-smoothing-design.md`

## Global Constraints

- Do not create commits; the user owns commits.
- Keep the C++ simulation authoritative for transforms, tether forces, collisions, resets, and grounded truth.
- Predict only local unconstrained movement and jump; never duplicate tether or collision physics in TypeScript.
- Keep WebSockets, 60 Hz simulation, and 20 Hz snapshots for this milestone.
- Default to a six-tick interpolation delay, 32 buffered snapshots, 240 pending inputs, 80 ms correction half-life, and a 2 metre hard-snap threshold.
- Do not add production network-conditioning flags, WebTransport, tickets, reconnection, lobby, backend, Redis, or gRPC code.
- Reuse `stepMotion`; do not create a second client movement integrator.
- Every nontrivial behavior must retain a focused runnable check.

---

### Task 1: Applied Input Acknowledgements in C++

**Files:**
- Modify: `simulation/include/linked_up/gameplay_protocol.hpp`
- Modify: `simulation/src/gameplay_protocol.cpp`
- Modify: `simulation/src/gameplay_server.cpp`
- Modify: `simulation/tests/gameplay_protocol_test.cpp`

**Interfaces:**
- Consumes: `SequencedInput`, `PlayerInput`, `Snapshot`, and the existing simulation tick loop.
- Produces: `serialize_snapshot(const Snapshot&, const std::array<std::uint64_t, 2>&)` and `acknowledgedInput` on each wire player state.

- [x] **Step 1: Write the failing serializer assertions**

Change the snapshot assertion to pass explicit applied sequences and require both values:

```cpp
const auto message = crow::json::load(
    linked_up::serialize_snapshot(snapshot, std::array<std::uint64_t, 2>{41, 73}));
assert(message["players"][0]["acknowledgedInput"].u() == 41);
assert(message["players"][1]["acknowledgedInput"].u() == 73);
```

- [x] **Step 2: Run the focused C++ test and verify RED**

Run:

```sh
cmake --build build -j 4 --target gameplay_protocol_test
```

Expected: compilation fails because `serialize_snapshot` does not accept the acknowledgement array.

- [x] **Step 3: Extend the serializer contract**

Declare the exact signature and include `<array>` explicitly:

```cpp
std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::array<std::uint64_t, 2>& acknowledged_inputs);
```

In the existing player loop, add:

```cpp
player["acknowledgedInput"] = acknowledged_inputs[index];
```

Do not put network sequence state into `PrototypeSimulation` or `PlayerState`.

- [x] **Step 4: Track validated input and sequence atomically**

Replace the server's input-only array with:

```cpp
struct LatestInput {
  PlayerInput input;
  std::uint64_t sequence{};
};

std::array<LatestInput, 2> latest_inputs_{};
```

On successful decode, replace both fields under the existing mutex:

```cpp
latest_inputs_[player_index(session->second.player)] = {
    .input = result.value->input,
    .sequence = result.value->sequence,
};
```

On disconnect, assign `LatestInput{}`. At the start of each simulation tick,
copy the array once under the mutex, apply the copied inputs, then serialize the
post-step snapshot with the copied sequences:

```cpp
const std::array<std::uint64_t, 2> applied{
    inputs[0].sequence,
    inputs[1].sequence,
};
const std::string message = serialize_snapshot(snapshot, applied);
```

This ordering is the invariant: a sequence is acknowledged only in a snapshot
produced after that copied input was applied.

- [x] **Step 5: Build and run all C++ checks**

Run:

```sh
cmake --build build -j 4
ctest --test-dir build --output-on-failure
```

Expected: both C++ tests pass and the server builds without project warnings.

- [x] **Step 6: Exercise acknowledgement timing through the live boundary**

Start `linked-up-server`, connect Blue with a temporary Node WebSocket script,
send sequence `7` with `moveZ: 1`, and inspect snapshots. Assert:

```js
if (blue.acknowledgedInput === 7) {
  assert(Math.hypot(blue.velocity.x, blue.velocity.z) > 0);
  assert.equal(snapshot.players[1].acknowledgedInput, 0);
  passed = true;
}
```

Fail after three seconds unless the applied acknowledgement appears.

---

### Task 2: Client Acknowledgement Contract

**Files:**
- Modify: `client/src/gameplay-protocol.ts`
- Modify: `client/src/gameplay-protocol.test.ts`

**Interfaces:**
- Consumes: the C++ `acknowledgedInput` wire field from Task 1.
- Produces: `NetworkPlayerState.acknowledgedInput: number` for smoothing logic.

- [x] **Step 1: Make the codec tests require acknowledgements**

Add `acknowledgedInput` to both fixture states and assert it survives parsing:

```ts
const blue = {
  id: "blue",
  acknowledgedInput: 12,
  position: { x: -1, y: 1, z: 0 },
  velocity: { x: 0.5, y: 0, z: 0 },
  grounded: true,
};

assert.equal(snapshot.players[0].acknowledgedInput, 12);
```

Add two rejection checks: missing `acknowledgedInput` and a negative value.

- [x] **Step 2: Run client tests and verify RED**

Run:

```sh
npm --prefix client test
```

Expected: the parsed player type/value does not provide `acknowledgedInput` and
the malformed fixture is incorrectly accepted.

- [x] **Step 3: Parse the field strictly**

Extend the interface:

```ts
export interface NetworkPlayerState {
  id: PlayerId;
  acknowledgedInput: number;
  position: Vector3State;
  velocity: Vector3State;
  grounded: boolean;
}
```

Require `count(value.acknowledgedInput)` in `parsePlayer` and copy it into the
returned object. Reuse the existing nonnegative safe-integer validator.

- [x] **Step 4: Run codec tests and typecheck**

Run:

```sh
npm --prefix client test
npm --prefix client run typecheck
```

Expected: all codec/motion tests pass and TypeScript accepts the new contract.

---

### Task 3: Buffered Remote Snapshot Sampling

**Files:**
- Create: `client/src/network-smoothing.ts`
- Create: `client/src/network-smoothing.test.ts`

**Interfaces:**
- Consumes: `ServerSnapshot`, monotonic arrival milliseconds, and welcome `tickRate`.
- Produces: `SmoothingConfig`, `defaultSmoothingConfig`, and `SnapshotBuffer.push/sample/latest`.

- [x] **Step 1: Write failing interpolation and ordering tests**

Create a `snapshotAt(tick, orangeX)` fixture that returns a valid two-player
snapshot with Orange at `orangeX` and distinct velocities, grounded flags,
separation, and tension. Assert:

```ts
const buffer = new SnapshotBuffer({
  ...defaultSmoothingConfig,
  interpolationDelayTicks: 6,
});
assert(buffer.push(snapshotAt(100, 0), 1_000));
assert(buffer.push(snapshotAt(106, 6), 1_100));

const midpoint = buffer.sample(1_150, 60);
assert(midpoint);
assert.equal(midpoint.tick, 103);
assert.equal(midpoint.players[1].position.x, 3);
assert.equal(midpoint.players[1].grounded, true);
```

Also assert:

- targets outside the range hold the oldest/newest state;
- duplicate and lower ticks return `false`;
- an older reset returns `false`;
- a newer reset clears old samples and accepts tick zero;
- in a fresh buffer, inserting ticks one through 33 with capacity 32 makes tick
  two the oldest retained sample.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```sh
node --test client/src/network-smoothing.test.ts
```

Expected: module resolution fails because `network-smoothing.ts` does not exist.

- [x] **Step 3: Define configuration and buffer surface**

Use these exact declarations:

```ts
export interface SmoothingConfig {
  interpolationDelayTicks: number;
  maxSnapshots: number;
  maxPendingInputs: number;
  correctionHalfLifeMs: number;
  snapDistance: number;
}

export const defaultSmoothingConfig: SmoothingConfig = {
  interpolationDelayTicks: 6,
  maxSnapshots: 32,
  maxPendingInputs: 240,
  correctionHalfLifeMs: 80,
  snapDistance: 2,
};

export class SnapshotBuffer {
  constructor(config: SmoothingConfig = defaultSmoothingConfig);
  push(snapshot: ServerSnapshot, receivedAtMs: number): boolean;
  sample(nowMs: number, tickRate: number): ServerSnapshot | undefined;
  get latest(): ServerSnapshot | undefined;
}
```

Keep one private array of `{snapshot, receivedAtMs}`. Validate constructor
values as finite and positive; throw `RangeError` for invalid configuration.

- [x] **Step 4: Implement insertion and interpolation**

On insertion, compare `(resetCount, tick)` with the newest entry using the
spec's reset rules and trim from the front to `maxSnapshots`.

Sampling computes:

```ts
const estimatedTick = newest.snapshot.tick +
  Math.max(0, nowMs - newest.receivedAtMs) * tickRate / 1000;
const renderTick = estimatedTick - config.interpolationDelayTicks;
```

Find the first entry at or after `renderTick`. Hold an endpoint if no bracket
exists. Otherwise interpolate with:

```ts
const amount = (renderTick - older.tick) / (newer.tick - older.tick);
const mix = (left: number, right: number) => left + (right - left) * amount;
```

Return a new snapshot with `tick: renderTick`; interpolate each numeric vector
component, separation, and tension. Choose grounded from the older state below
`0.5` and the newer state at or above `0.5`. Choose IDs,
`acknowledgedInput`, and `resetCount` from the newer snapshot.

- [x] **Step 5: Run smoothing tests and the full client suite**

Run:

```sh
node --test client/src/network-smoothing.test.ts
npm --prefix client test
npm --prefix client run typecheck
```

Expected: interpolation, ordering, reset, capacity, codec, and motion checks pass.

---

### Task 4: Local Prediction and Reconciliation

**Files:**
- Modify: `client/src/network-smoothing.ts`
- Modify: `client/src/network-smoothing.test.ts`
- Reuse: `client/src/motion.ts`

**Interfaces:**
- Consumes: `ClientInput`, `PlayerId`, raw accepted `ServerSnapshot`, and `stepMotion`.
- Produces: `PredictionReconciler.record/reconcile/advanceCorrection/renderState/pendingCount`.

- [x] **Step 1: Write failing prediction and replay tests**

Initialize from an authoritative tick with acknowledgement zero, then record one
world-space input:

```ts
const predictor = new PredictionReconciler("blue", 60);
predictor.reconcile(snapshotAt(100, 0));
predictor.record({
  sequence: 1,
  clientTick: 1,
  moveX: 1,
  moveZ: 0,
  jump: false,
});
assert(predictor.renderState()!.position.x > snapshotAt(100, 0).players[0].position.x);
assert.equal(predictor.pendingCount, 1);
```

Then reconcile a snapshot acknowledging sequence one and assert pending count is
zero. Add a second case with sequences two and three where only two is
acknowledged; assert sequence three is replayed and remains pending.

Add checks for:

- a jump immediately produces positive predicted vertical velocity;
- small correction initially preserves displayed position and has half its
  original offset after 80 ms;
- corrections above 2 metres snap with no offset;
- a higher reset clears pending input and correction;
- exceeding a test configuration of two pending inputs clears history and the
  next authoritative state becomes the hard baseline.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```sh
node --test client/src/network-smoothing.test.ts
```

Expected: `PredictionReconciler` is not exported.

- [x] **Step 3: Add the prediction surface and server-matched config**

Declare:

```ts
export class PredictionReconciler {
  constructor(
    player: PlayerId,
    tickRate: number,
    config: SmoothingConfig = defaultSmoothingConfig,
  );
  record(input: ClientInput): void;
  reconcile(snapshot: ServerSnapshot): void;
  advanceCorrection(deltaMs: number): void;
  renderState(): NetworkPlayerState | undefined;
  get pendingCount(): number;
}
```

Reuse `stepMotion` with:

```ts
const networkMotionConfig: MotionConfig = {
  acceleration: 30,
  floorHeight: 1,
  gravity: -9.81,
  jumpSpeed: 7,
  maxDelta: 1 / 60,
  maxSpeed: 6,
};
```

Pass world movement as `{x: input.moveX, z: input.moveZ, jumpPressed: input.jump}`
with camera yaw zero and delta `1 / tickRate`.

- [x] **Step 4: Implement acknowledgement replay**

`record` appends only to the fixed-cap pending array and immediately steps the
prediction when a baseline exists. `reconcile` selects the configured player,
drops inputs at or below `acknowledgedInput`, starts from the authoritative
motion state, and replays remaining inputs in order.

Before replacing state, capture `renderState()?.position`. After replay, set the
correction offset to old displayed position minus the new predicted position
unless reset changed or Euclidean correction distance exceeds `snapDistance`.
Those cases zero the offset.

At history overflow, clear pending inputs and set a hard-reset flag. The next
`reconcile` accepts the authoritative baseline without replay and clears the
flag.

- [x] **Step 5: Implement presentation correction decay**

For finite positive `deltaMs`, multiply every correction component by:

```ts
Math.pow(0.5, deltaMs / config.correctionHalfLifeMs)
```

`renderState` returns predicted velocity/grounded and a new position equal to
predicted position plus the current correction. It must not mutate authoritative
or predicted physics state.

- [x] **Step 6: Run all pure client checks**

Run:

```sh
npm --prefix client test
npm --prefix client run typecheck
```

Expected: all existing and new checks pass.

---

### Task 5: Babylon Rendering Integration

**Files:**
- Modify: `client/src/game.ts`

**Interfaces:**
- Consumes: `SnapshotBuffer`, `PredictionReconciler`, welcome tick rate, raw snapshots, and successful `GameplayConnection.sendInput` results.
- Produces: predicted local rendering, buffered remote rendering, and an authoritative/interpolated tether presentation.

- [x] **Step 1: Add smoothing ownership to `Game`**

Add:

```ts
readonly #snapshots = new SnapshotBuffer();
#predictor?: PredictionReconciler;
#tickRate?: number;
```

On a valid welcome, store `message.tickRate` and construct:

```ts
this.#predictor = new PredictionReconciler(this.#options.player, message.tickRate);
```

- [x] **Step 2: Route raw snapshots into both pure units**

In `#onSnapshot`, call `#snapshots.push(snapshot, performance.now())`. Ignore a
`false` result. For an accepted snapshot:

```ts
this.#snapshot = snapshot;
this.#predictor?.reconcile(snapshot);
this.#tickLabel.value = `Tick ${snapshot.tick}`;
this.#finishStartup();
```

Delete direct robot position assignment and tether update from the callback.

- [x] **Step 3: Predict only successfully sent input**

Build one `ClientInput` object per send attempt. Preserve the current sequence
and jump behavior, then record only after success:

```ts
const sent = this.#connection.sendInput(wireInput);
if (sent) {
  this.#predictor?.record(wireInput);
} else if (input.jumpPressed) {
  this.#input.queueJump();
}
```

- [x] **Step 4: Render predicted local and buffered remote state**

Each frame:

1. decay correction with `delta * 1000`;
2. sample snapshots with `performance.now()` and welcome tick rate;
3. obtain local state from `renderState()`, falling back to the newest raw local
   state only before prediction initializes;
4. obtain remote state from the sampled snapshot, falling back to the newest
   raw remote state while the buffer warms;
5. assign both robot roots, animate both states, update local speed and camera,
   and update the tether.

Use the sampled authoritative `tetherTension` for opacity. Continue showing the
newest raw server tick in telemetry. Do not call `stepMotion` from `game.ts`.

- [x] **Step 5: Run client build verification**

Run:

```sh
npm --prefix client test
npm --prefix client run build
```

Expected: all tests, strict typecheck, and the Vite production build pass. The
known Babylon main-chunk warning may remain.

---

### Task 6: Conditioned Two-Browser Proof and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/networking.md`
- Modify: `docs/superpowers/plans/2026-08-29-snapshot-smoothing.md`

**Interfaces:**
- Consumes: the completed server/client and Playwright `route_web_socket`.
- Produces: end-to-end evidence under deterministic delay/jitter/loss and retained Phase 5 documentation.

- [x] **Step 1: Extend the temporary two-browser smoke for acknowledgements**

Keep the Phase 4 assertions for common snapshots, independent Blue/Orange
movement, duplicate slot handling, slot selection, and console/page errors.
After Blue sends input, assert a later Blue snapshot has
`acknowledgedInput > 0`; do the same for Orange.

- [x] **Step 2: Add a conditioned WebSocket route**

Before navigating each gameplay page, call:

```py
def condition(route):
    server = route.connect_to_server()
    held = []
    seen = 0

    def from_server(payload):
        nonlocal seen
        message = json.loads(payload) if isinstance(payload, str) else None
        if not message or message.get("type") != "snapshot":
            route.send(payload)
            return
        seen += 1
        if seen % 7 == 0:
            return
        held.append(payload)
        release_after = 2 if seen % 3 == 0 else 1
        if len(held) > release_after:
            route.send(held.pop(0))

    server.on_message(from_server)

page.route_web_socket("ws://127.0.0.1:9002/game*", condition)
```

Client-to-server input remains automatically forwarded. This deterministically
holds one or two snapshots and drops every seventh snapshot without adding
production hooks.

- [x] **Step 3: Run the conditioned browser proof**

Use the existing two-server helper with the temporary Python Playwright script:

```sh
python3 /Users/akshpatel/.agents/skills/webapp-testing/scripts/with_server.py \
  --server './build/simulation/linked-up-server' --port 9002 \
  --server 'npm --prefix client run dev -- --host 127.0.0.1' --port 5173 \
  -- /tmp/linked-up-playwright/bin/python /tmp/linked-up-smoothing-smoke.py
```

Expected: both clients remain ready, conditioned ticks advance, both applied
acknowledgements advance, movement remains independent, no unexpected errors
occur, and `/tmp/linked-up-smoothing-desktop.png` is captured.

- [x] **Step 4: Inspect the conditioned screenshot**

Use the local image viewer and confirm both distinguishable robots, connected
tether, bounded platform, unobscured controls, and readable player/tick status.
Fix only regressions caused by Phase 5 and repeat Step 3 after any edit.

- [x] **Step 5: Update retained documentation**

Document the per-player acknowledgement, six-tick/100 ms interpolation delay,
32-snapshot buffer, local movement/jump prediction, replay, 80 ms visual
correction, 2 metre snap, reset clearing, and the authoritative tether/collision
boundary. Keep WebTransport and backend work explicitly deferred.

- [x] **Step 6: Run the complete verification suite**

Run:

```sh
cmake --build build -j 4
ctest --test-dir build --output-on-failure
npm --prefix client test
npm --prefix client run build
```

Then rerun the conditioned two-browser proof from Step 3.

Expected: all C++ tests pass, all TypeScript tests pass, Vite builds, and the
conditioned browser proof passes.

- [x] **Step 7: Audit scope and close the plan without committing**

Check every completed box in this file. Inspect retained files and confirm no
backend, Redis, gRPC, WebTransport, ticket, reconnection, network-conditioner,
or browser tether-physics scaffolding was added. Leave every change uncommitted
for the user.
