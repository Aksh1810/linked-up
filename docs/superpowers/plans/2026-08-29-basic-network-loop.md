# Basic Network Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two browser pages independently control Blue and Orange in one authoritative C++ tether simulation while both render the same server snapshots.

**Architecture:** A pinned Crow WebSocket server wraps the existing `PrototypeSimulation`, accepts validated world-space input, advances physics at 60 Hz, and broadcasts JSON at 20 Hz. The TypeScript client isolates its wire codec from Babylon.js, renders two authoritative robots plus their tether, and deliberately performs no prediction or interpolation in this milestone.

**Tech Stack:** C++20, Jolt Physics 5.6.0, Crow 1.3.3, standalone Asio 1.30.2, TypeScript 7.0.2, Babylon.js 9.23.0, Vite 8.2.2, Node built-in test runner

**Spec:** `docs/superpowers/specs/2026-08-29-basic-network-loop-design.md`

## Global Constraints

- Do not create commits; the user owns commits.
- Keep C++ authoritative: clients send intent and never trusted transforms.
- Bind the Phase 4 server to loopback; default port is `9002` and `LINKED_UP_GAMEPLAY_PORT` overrides it.
- Simulate at 60 Hz and publish snapshots every third tick (20 Hz).
- Accept only text JSON messages no larger than 512 bytes.
- Limit each client to 120 messages per one-second rate window.
- Do not add ASP.NET Core, Redis, SignalR, gRPC, WebTransport, prediction, interpolation, or reconnection.
- Reuse `PrototypeSimulation`; do not copy movement or tether physics into networking code.

---

### Task 1: Authoritative Gameplay Codec

**Files:**
- Modify: `simulation/CMakeLists.txt`
- Create: `simulation/include/linked_up/gameplay_protocol.hpp`
- Create: `simulation/src/gameplay_protocol.cpp`
- Create: `simulation/tests/gameplay_protocol_test.cpp`

**Interfaces:**
- Consumes: `linked_up::PlayerInput`, `linked_up::PlayerId`, and `linked_up::Snapshot` from `prototype_simulation.hpp`.
- Produces: `InputGate::accept(std::string_view, InputGate::Clock::time_point)`, `serialize_welcome(PlayerId)`, `serialize_snapshot(const Snapshot&)`, and `serialize_error(ProtocolError)`.

- [x] **Step 1: Pin standalone Asio and Crow in CMake**

Add download-only Asio before Crow so Crow's `Findasio.cmake` resolves the
fetched headers. Disable Crow's examples, tests, install, SSL, and compression.

```cmake
FetchContent_Declare(
  asio
  URL https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-30-2.tar.gz
)
FetchContent_MakeAvailable(asio)
set(ASIO_INCLUDE_DIR "${asio_SOURCE_DIR}/asio/include" CACHE PATH "" FORCE)

set(CROW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CROW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CROW_INSTALL OFF CACHE BOOL "" FORCE)
set(CROW_ENABLE_SSL OFF CACHE BOOL "" FORCE)
set(CROW_ENABLE_COMPRESSION OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  Crow
  GIT_REPOSITORY https://github.com/CrowCpp/Crow.git
  GIT_TAG v1.3.3
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(Crow)
```

Create `linked_up_gameplay_protocol`, link it to `linked_up_simulation` and
`Crow::Crow`, then create a `gameplay_protocol_test` CTest target.

- [x] **Step 2: Define the codec contract**

```cpp
enum class ProtocolError {
  None,
  Malformed,
  OutOfRange,
  StaleSequence,
  RateLimited,
  InvalidPlayer,
  SlotTaken,
  BinaryMessage,
};

struct SequencedInput {
  std::uint64_t sequence{};
  std::uint64_t client_tick{};
  PlayerInput input;
};

struct InputResult {
  std::optional<SequencedInput> value;
  ProtocolError error{ProtocolError::None};
};

class InputGate {
 public:
  using Clock = std::chrono::steady_clock;
  InputResult accept(std::string_view message, Clock::time_point now);

 private:
  std::uint64_t last_sequence_{};
  Clock::time_point window_start_{};
  std::size_t messages_in_window_{};
};

std::string serialize_welcome(PlayerId player);
std::string serialize_snapshot(const Snapshot& snapshot);
std::string serialize_error(ProtocolError error);
```

- [x] **Step 3: Write failing protocol checks**

Use one assertion executable covering the trust boundary:

```cpp
InputGate gate;
const auto now = InputGate::Clock::time_point{};
const auto valid = gate.accept(
    R"({"type":"input","sequence":1,"clientTick":9,"moveX":0.5,"moveZ":-1,"jump":true})",
    now);
assert(valid.value.has_value());
assert(valid.value->sequence == 1);
assert(valid.value->input.move_x == 0.5f);
assert(valid.value->input.jump);

assert(gate.accept("not json", now).error == ProtocolError::Malformed);
assert(gate.accept(
    R"({"type":"input","sequence":2,"clientTick":9,"moveX":2,"moveZ":0,"jump":false})",
    now).error == ProtocolError::OutOfRange);
assert(gate.accept(
    R"({"type":"input","sequence":1,"clientTick":10,"moveX":0,"moveZ":0,"jump":false})",
    now).error == ProtocolError::StaleSequence);
```

Use a fresh gate to send 121 valid increasing messages at the same time point
and assert the last returns `RateLimited`. Serialize one snapshot, parse it with
`crow::json::load`, and assert tick, both IDs, positions, tension, and reset count.

- [x] **Step 4: Run the focused test and verify RED**

Run:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4 --target gameplay_protocol_test
ctest --test-dir build -R gameplay-protocol --output-on-failure
```

Expected: compilation fails because the protocol declarations or definitions do
not yet exist.

- [x] **Step 5: Implement strict parsing and serialization**

Use `crow::json::load`. Require an object with `type == "input"`, unsigned
`sequence` and `clientTick`, numeric `moveX` and `moveZ`, and boolean `jump`.
Reject missing fields, wrong types, axes outside `[-1, 1]`, non-increasing
sequences, and the 121st message in one rate window. Reset the counter when
`now - window_start_ >= 1s`.

Map errors to these stable JSON codes:

```cpp
Malformed      -> {"code":"malformed_input","message":"Input message is invalid."}
OutOfRange     -> {"code":"input_out_of_range","message":"Movement input is out of range."}
StaleSequence  -> {"code":"stale_input","message":"Input sequence is stale."}
RateLimited    -> {"code":"input_rate_exceeded","message":"Input rate is too high."}
InvalidPlayer  -> {"code":"invalid_player","message":"Choose Blue or Orange."}
SlotTaken      -> {"code":"slot_taken","message":"That player is already connected."}
BinaryMessage  -> {"code":"binary_message","message":"Gameplay messages must be JSON text."}
```

- [x] **Step 6: Run protocol and existing simulation tests**

```sh
cmake --build build -j 4
ctest --test-dir build --output-on-failure
```

Expected: `gameplay-protocol` and `authoritative-tether` pass.

### Task 2: C++ WebSocket Gameplay Server

**Files:**
- Modify: `simulation/CMakeLists.txt`
- Create: `simulation/include/linked_up/gameplay_server.hpp`
- Create: `simulation/src/gameplay_server.cpp`
- Create: `simulation/src/server_main.cpp`

**Interfaces:**
- Consumes: `InputGate`, protocol serializers, and `PrototypeSimulation`.
- Produces: `GameplayServer::run()` and executable `linked-up-server`.

- [x] **Step 1: Define the server surface and constants**

```cpp
struct GameplayServerConfig {
  std::uint16_t port{9002};
  std::size_t max_payload_bytes{512};
  std::uint32_t snapshot_every_ticks{3};
};

class GameplayServer {
 public:
  explicit GameplayServer(GameplayServerConfig config = {});
  ~GameplayServer();
  GameplayServer(const GameplayServer&) = delete;
  GameplayServer& operator=(const GameplayServer&) = delete;
  void run();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};
```

`server_main.cpp` reads `LINKED_UP_GAMEPLAY_PORT` with `std::from_chars`, rejects
invalid values outside `1..65535`, logs the loopback URL, and calls `run()`.

- [x] **Step 2: Add the executable and verify its empty surface builds**

```cmake
add_executable(linked-up-server src/server_main.cpp src/gameplay_server.cpp)
target_link_libraries(linked-up-server PRIVATE linked_up_gameplay_protocol Crow::Crow)
```

Apply the same warning flags used by `linked_up_simulation`, then run:

```sh
cmake --build build -j 4 --target linked-up-server
```

Expected: PASS with no project warnings.

- [x] **Step 3: Implement connection ownership**

Register `GET /health` returning `{"status":"ok"}` and a WebSocket route at
`/game`. Its `onaccept` stores the requested `player` query value in the
connection userdata and returns true so a friendly protocol error can be sent
after upgrade. In `onopen`, take ownership of that userdata and reserve one of
two slots under the mutex:

```cpp
struct Session {
  crow::websocket::connection* connection{};
  PlayerId player{};
  InputGate input_gate;
};
```

An invalid query receives `malformed_input`; an occupied slot receives a
`slot_taken` JSON error. Both close with WebSocket status `1008`. An accepted
session receives `serialize_welcome(player)`.

In `onclose` and `onerror`, erase the session, clear that slot, and assign a
neutral `PlayerInput{}`.

- [x] **Step 4: Implement input handling**

Reject binary messages. Look up the session by connection pointer, pass the
text to its `InputGate`, and replace only that player's latest input on success.
For any protocol error, send `serialize_error(error)` and close with `1008`.

- [x] **Step 5: Implement fixed stepping and broadcast**

Start one `std::jthread` before Crow's blocking `run()`. Each iteration:

1. copies both latest inputs while holding the mutex;
2. applies inputs and calls `simulation.step()` on the simulation thread only;
3. every third tick serializes one snapshot;
4. copies current connection pointers under the mutex and calls `send_text`;
5. sleeps until the next `steady_clock` deadline;
6. if more than one tick late, logs an overrun and resets the next deadline to
   `now + tick_duration`.

Stop and join the simulation thread during destruction.

- [x] **Step 6: Exercise health, welcome, input, and snapshots**

Start the server:

```sh
LINKED_UP_GAMEPLAY_PORT=9002 ./build/simulation/linked-up-server
```

In another shell:

```sh
curl --fail http://127.0.0.1:9002/health
node -e '
const ws = new WebSocket("ws://127.0.0.1:9002/game?player=blue");
let seen = 0;
ws.onmessage = ({data}) => {
  const message = JSON.parse(data);
  if (message.type === "welcome") ws.send(JSON.stringify({type:"input",sequence:1,clientTick:1,moveX:1,moveZ:0,jump:false}));
  if (message.type === "snapshot" && ++seen === 3) { console.log(data); ws.close(); }
};
setTimeout(() => process.exit(seen >= 3 ? 0 : 1), 3000);
'
```

Expected: health is `ok`, welcome arrives once, at least three increasing
snapshots arrive, and Blue has positive horizontal velocity.

### Task 3: TypeScript Gameplay Codec and Connection

**Files:**
- Create: `client/src/gameplay-protocol.ts`
- Create: `client/src/gameplay-protocol.test.ts`
- Create: `client/src/gameplay-connection.ts`
- Modify: `client/src/motion.ts`
- Modify: `client/src/motion.test.ts`

**Interfaces:**
- Produces: `PlayerId`, `ServerSnapshot`, `ServerMessage`, `encodeInput`, `parseServerMessage`, `worldMovement`, and `GameplayConnection`.
- Consumed by: `Game` in Task 4.

- [x] **Step 1: Write failing codec tests**

```ts
assert.equal(
  encodeInput({ sequence: 4, clientTick: 9, moveX: 0.5, moveZ: -1, jump: true }),
  '{"type":"input","sequence":4,"clientTick":9,"moveX":0.5,"moveZ":-1,"jump":true}',
);

const snapshot = parseServerMessage(JSON.stringify({
  type: "snapshot",
  tick: 8,
  resetCount: 0,
  separation: 2,
  tetherTension: 0,
  players: [blueState, orangeState],
}));
assert.equal(snapshot.type, "snapshot");
assert.equal(snapshot.players[1].id, "orange");
assert.throws(() => parseServerMessage('{"type":"snapshot","tick":"bad"}'));
```

Add a motion test asserting `worldMovement({x: 0, z: 1}, Math.PI / 2)` points
along positive X and diagonal input is normalized.

- [x] **Step 2: Run tests and verify RED**

```sh
cd client
npm test
```

Expected: the new modules/functions cannot be resolved.

- [x] **Step 3: Implement pure client protocol helpers**

Define exact discriminated unions:

```ts
export type PlayerId = "blue" | "orange";
export interface NetworkPlayerState {
  id: PlayerId;
  position: Vector3State;
  velocity: Vector3State;
  grounded: boolean;
}
export interface ServerSnapshot {
  type: "snapshot";
  tick: number;
  resetCount: number;
  separation: number;
  tetherTension: number;
  players: [NetworkPlayerState, NetworkPlayerState];
}
export type ServerMessage = WelcomeMessage | ServerSnapshot | ErrorMessage;
```

`parseServerMessage` parses unknown JSON, checks finite numbers, exact player
IDs/order, booleans, and nonnegative integer ticks. It throws `ProtocolError`
on any mismatch. `encodeInput` uses `JSON.stringify` on a fixed object literal.

Extract the current camera rotation math into:

```ts
export function worldMovement(
  input: Pick<MotionInput, "x" | "z">,
  cameraYaw: number,
): { x: number; z: number };
```

Use it from both `stepMotion` and network input generation so camera semantics
remain identical.

- [x] **Step 4: Implement the browser WebSocket owner**

```ts
export interface GameplayConnectionHandlers {
  onWelcome(message: WelcomeMessage): void;
  onSnapshot(message: ServerSnapshot): void;
  onError(message: string): void;
  onStatus(status: "connecting" | "connected" | "disconnected"): void;
}

export class GameplayConnection {
  constructor(url: string, player: PlayerId, handlers: GameplayConnectionHandlers);
  connect(): void;
  sendInput(input: ClientInput): boolean;
  dispose(): void;
}
```

Append `?player=<id>` with `URL`, use browser-native `WebSocket`, parse every
message through `parseServerMessage`, and close/show a protocol error if parsing
fails. `sendInput` returns false unless `readyState === WebSocket.OPEN`.

- [x] **Step 5: Run client tests and typecheck**

```sh
npm test
npm run typecheck
```

Expected: all motion and gameplay-protocol checks pass.

### Task 4: Render the Authoritative Pair and Tether

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/main.ts`
- Modify: `client/src/game.ts`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `GameplayConnection`, `ServerSnapshot`, `PlayerId`, `worldMovement`, and `InputController`.
- Produces: the playable `?player=blue` and `?player=orange` pages.

- [x] **Step 1: Add local-slot and network telemetry UI**

Add native links shown only when `player` is missing/invalid:

```html
<nav id="slot-picker" aria-label="Choose local test player" hidden>
  <a href="?player=blue">Play as Blue</a>
  <a href="?player=orange">Play as Orange</a>
</nav>
```

Add `#player-label` and `#tick-label` outputs to the existing telemetry. Reuse
the current loading/error overlay and equipment-tag styling.

- [x] **Step 2: Make robot creation data-driven**

Change the existing builder to:

```ts
interface RobotVisual {
  root: TransformNode;
  visual: TransformNode;
  leftArm: TransformNode;
  rightArm: TransformNode;
  leftLeg: TransformNode;
  rightLeg: TransformNode;
}

#createRobot(id: PlayerId): RobotVisual;
```

Keep geometry identical. Blue uses `#38bdf8/#167ca8`; Orange uses
`#ff914d/#bd5c20`. Store the pair as `Record<PlayerId, RobotVisual>`.

- [x] **Step 3: Align the visible floor and create the tether**

Replace the broad walkable-looking lawn with a clearly bounded 10×10 grass
platform matching `Config::platform_half_extent == 5`. Create one updatable
Babylon line with two points and orange color. Update its endpoints from the
robots' backpack/socket positions after every snapshot.

- [x] **Step 4: Replace local stepping with authoritative snapshots**

`Game.create` receives these options:

```ts
interface GameOptions {
  player: PlayerId;
  gameplayUrl: string;
  onReady(): void;
  onStatus(message: string): void;
  onError(message: string): void;
}
```

It creates the `GameplayConnection`, stores the latest snapshot, and applies
snapshot positions directly to both roots. Reuse the existing animation math in
a helper that takes one `NetworkPlayerState`; derive speed and grounded state
only from the snapshot.

The camera target follows the requested local robot. The render loop sends input
at most once per `1 / 60` seconds:

```ts
const input = this.#input.consume();
const movement = worldMovement(input, this.#camera.alpha + Math.PI / 2);
this.#connection.sendInput({
  sequence: ++this.#sequence,
  clientTick: ++this.#clientTick,
  moveX: movement.x,
  moveZ: movement.z,
  jump: input.jumpPressed,
});
```

Do not call `stepMotion` in networked play.

- [x] **Step 5: Wire startup and friendly failures**

`main.ts` validates `player`. Invalid/missing values reveal `#slot-picker` and
do not construct Babylon or WebSocket. Valid values start the game, show
`Connecting as Blue/Orange`, and only clear loading after `welcome` plus the
first snapshot. Connection errors show the server command and keep a clickable
return-to-slot-selection link.

- [x] **Step 6: Run focused client verification**

```sh
cd client
npm test
npm run build
```

Expected: TypeScript, tests, and Vite production build pass. Babylon's known
main-chunk size warning may remain visible; no configuration is added merely to
silence it.

### Task 5: Two-Browser End-to-End Proof and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/networking.md`
- Modify: `docs/superpowers/plans/2026-08-29-basic-network-loop.md`

**Interfaces:**
- Consumes: `linked-up-server` and the Vite client.
- Produces: retained run instructions and completion evidence for Phase 4.

- [x] **Step 1: Start both local services with the testing helper**

Use the existing helper with two servers:

```sh
python3 /Users/akshpatel/.agents/skills/webapp-testing/scripts/with_server.py \
  --server './build/simulation/linked-up-server' --port 9002 \
  --server 'npm --prefix client run dev -- --host 127.0.0.1' --port 5173 \
  -- node /tmp/linked-up-network-smoke.js
```

The temporary Playwright script opens Blue and Orange pages, listens to
WebSocket frames from both, and stores snapshots by tick.

- [x] **Step 2: Prove independent authority and matching state**

The browser check must:

1. wait until both pages report connected and ticks advance;
2. hold `W` in Blue and assert Blue's authoritative speed becomes positive
   while Orange remains near zero;
3. release Blue, hold `D` in Orange, and assert Orange's authoritative speed
   becomes positive;
4. find at least one common server tick received by both pages and deep-compare
   both snapshot JSON objects;
5. open a third Blue page and assert `slot_taken` is visible;
6. capture `/tmp/linked-up-network-desktop.png` containing both robots and the
   tether;
7. fail on unexpected page errors or console errors.

- [x] **Step 3: Inspect the final screenshot**

Use the local image viewer. Confirm two distinguishable robots, a visible tether,
the bounded platform edge, unobscured controls, and readable player/tick status.
Fix only defects that contradict the approved design, then repeat Step 2.

- [x] **Step 4: Update retained documentation**

README commands must include:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j 4
./build/simulation/linked-up-server
npm --prefix client run dev
```

Document the two player URLs, loopback-only Phase 4 limitation, JSON/WebSocket
boundary, 60/20 Hz rates, disconnect neutralization, and that lobby/tickets,
prediction, and WebTransport remain unimplemented.

- [x] **Step 5: Run the complete verification suite**

```sh
cmake --build build -j 4
ctest --test-dir build --output-on-failure
npm --prefix client test
npm --prefix client run build
```

Expected: all C++ and TypeScript tests pass, the client builds, and the two-page
browser proof from Step 2 passes.

- [x] **Step 6: Mark this plan complete without committing**

Check every completed box in this file. Inspect the retained file list and
confirm no backend, Redis, gRPC, TLS, prediction, or interpolation scaffolding
was added. Leave all changes uncommitted for the user.
