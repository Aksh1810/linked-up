# Selectable Maps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Relay Ridge, Crane Shift, and Windworks beside Classic Ascent, with the host choosing the authoritative map in the waiting lobby.

**Architecture:** ASP.NET owns the public four-map registry, persists the selected ID on the Redis room, and sends it through the existing gRPC match-creation boundary. C++ validates the ID again and chooses one of four authored route configurations; gameplay welcome data carries the immutable ID back to the browser for the HUD. The browser uses the same closed ID union for its selector and renders existing obstacle state with kind-specific visual treatment.

**Tech Stack:** .NET 10 minimal APIs, SignalR, StackExchange.Redis, protobuf/gRPC, C++20, Jolt Physics, Crow JSON/WebSocket, TypeScript 7, Babylon.js 9, Vite 8, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-12-selectable-maps-design.md`

## Global Constraints

- Public map IDs are exactly `classic-ascent`, `relay-ridge`, `crane-shift`, and `windworks`.
- New and legacy rooms default to `classic-ascent`.
- Only the host may change maps, and only while room status is `Waiting`.
- Geometry remains server-authored; no map loader, editor, procedural generation, dependency, or new obstacle mechanic is added.
- Every route retains five zones, four checkpoints, safe four-player checkpoint spawns, and the existing all-player summit rule.
- Relay Ridge has 32–38 obstacles; Crane Shift has 34–40 with at least 45% static surfaces and at most three rotating beams; Windworks has 32–38 with 3–4 fans, 2–3 conveyors, and one combined-force encounter.
- The new maps do not use `SwingingBeam`; Classic Ascent remains behavior-compatible.
- Fan and conveyor volumes must not look like solid collision boxes; falling warnings must expose a non-color cue that also works with reduced motion.

---

### Task 1: Persist and broadcast the lobby map selection

**Files:**
- Create: `backend/LinkedUp.Api/Rooms/RoomMaps.cs`
- Modify: `backend/LinkedUp.Api/Rooms/Room.cs`
- Modify: `backend/LinkedUp.Api/Rooms/RoomContracts.cs`
- Modify: `backend/LinkedUp.Api/Rooms/RedisRoomStore.cs`
- Modify: `backend/LinkedUp.Api/Rooms/RoomEndpoints.cs`
- Test: `backend/LinkedUp.Api.Tests/RoomTests.cs`
- Test: `backend/LinkedUp.Api.Tests/RedisRoomStoreTests.cs`
- Test: `backend/LinkedUp.Api.Tests/RoomApiTests.cs`

**Interfaces:**
- Produces: `RoomMaps.ClassicAscent`, `RoomMaps.IsKnown(string)`, `Room.MapId`, `Room.SetMap(string tokenHash, string mapId)`, `RedisRoomStore.SetMapAsync(string, string, string, CancellationToken)`, and `POST /api/rooms/{code}/map` accepting `SetRoomMapRequest(string MapId)`.
- Produces: `PublicRoom.MapId` in every room response and SignalR `RoomUpdated` payload.

- [ ] **Step 1: Write failing domain and API tests**

```csharp
[Fact]
public void New_room_defaults_to_classic_ascent() =>
    Assert.Equal(RoomMaps.ClassicAscent, TestRoom().MapId);

[Fact]
public void Host_can_select_a_known_map_while_waiting()
{
    var room = TestRoom();
    room.SetMap(TestTokenHash, RoomMaps.RelayRidge);
    Assert.Equal(RoomMaps.RelayRidge, room.MapId);
    Assert.Equal(2, room.Version);
}

[Theory]
[InlineData("unknown", RoomError.InvalidMap)]
public void Invalid_map_is_rejected(string mapId, RoomError error)
{
    var exception = Assert.Throws<RoomException>(() => TestRoom().SetMap(TestTokenHash, mapId));
    Assert.Equal(error, exception.Error);
}
```

Add endpoint tests that send `POST /api/rooms/{code}/map` with `X-Player-Token`, assert `mapId`, status 400 for an unknown ID, 403 for a guest, 409 after starting, and a received `RoomUpdated` with the incremented version.

- [ ] **Step 2: Run the focused tests and confirm the missing contract fails**

Run: `dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj --filter "FullyQualifiedName~RoomTests|FullyQualifiedName~RedisRoomStoreTests|FullyQualifiedName~RoomApiTests"`

Expected: FAIL because `RoomMaps`, `MapId`, `SetMap`, and the map endpoint do not exist.

- [ ] **Step 3: Implement the closed registry and room mutation**

```csharp
public static class RoomMaps
{
    public const string ClassicAscent = "classic-ascent";
    public const string RelayRidge = "relay-ridge";
    public const string CraneShift = "crane-shift";
    public const string Windworks = "windworks";
    private static readonly HashSet<string> Known = [ClassicAscent, RelayRidge, CraneShift, Windworks];
    public static bool IsKnown(string mapId) => mapId is not null && Known.Contains(mapId);
}
```

Initialize `Room.MapId` to `RoomMaps.ClassicAscent`, add `InvalidMap` to `RoomError`, and implement `SetMap` by validating the token, host, waiting status, and exact ID before assigning and incrementing `Version`. Because the property initializer runs when an older JSON object omits the property, legacy Redis values resolve to Classic Ascent.

- [ ] **Step 4: Add the store and endpoint path**

```csharp
public async Task<Room> SetMapAsync(string code, string rawToken, string mapId, CancellationToken token)
{
    var (room, _) = await MutateAsync(code, current => {
        current.SetMap(HashToken(rawToken), mapId);
        return (true, true);
    }, token);
    return room!;
}
```

Map `POST /{code}/map`, call the store with `RequireToken`, broadcast `RoomUpdated`, and map `InvalidMap` to the existing 400 `Invalid room request` title. Add `MapId` to `PublicRoom.From` and log only room code plus map ID.

- [ ] **Step 5: Run backend tests**

Run: `dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj`

Expected: PASS.

- [ ] **Step 6: Commit the lobby persistence slice**

```bash
git add backend/LinkedUp.Api backend/LinkedUp.Api.Tests
git commit -m "feat: persist lobby map selection"
```

---

### Task 2: Carry map identity through match creation and gameplay welcome

**Files:**
- Modify: `contracts/proto/linked_up/match/v1/match_service.proto`
- Modify: `backend/LinkedUp.Api/Matches/SimulationMatchClient.cs`
- Test: `backend/LinkedUp.Api.Tests/MatchStartTests.cs`
- Modify: `simulation/include/linked_up/match_manager.hpp`
- Modify: `simulation/src/match_manager.cpp`
- Modify: `simulation/src/match_coordinator_service.cpp`
- Modify: `simulation/include/linked_up/gameplay_protocol.hpp`
- Modify: `simulation/src/gameplay_protocol.cpp`
- Modify: `simulation/src/gameplay_server.cpp`
- Test: `simulation/tests/match_manager_test.cpp`
- Test: `simulation/tests/gameplay_protocol_test.cpp`

**Interfaces:**
- Consumes: `Room.MapId` and the exact registered IDs from Task 1.
- Produces: protobuf `CreateMatchRequest.map_id = 4`, `MatchManager::create(std::string room_id, std::string map_id, std::vector<MatchPlayer>)`, `Admission::map_id`, and `serialize_welcome(RobotColor, const std::vector<RobotColor>&, std::string_view map_id)`.

- [ ] **Step 1: Write failing boundary tests**

```cpp
const auto created = manager.create(request.room_id, "relay-ridge", request.players);
const auto admitted = manager.admit(created.match_id, created.launches.front().ticket);
REQUIRE(admitted->map_id == "relay-ridge");

const auto welcome = crow::json::load(
    linked_up::serialize_welcome(RobotColor::Blue, roster, "windworks"));
REQUIRE(welcome["mapId"].s() == "windworks");
```

Add a backend match-start assertion that the captured `CreateMatchRequest.MapId` equals the selected room map.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj --filter FullyQualifiedName~MatchStartTests`

Run: `cmake --build build --target linked-up-tests && ctest --test-dir build --output-on-failure`

Expected: FAIL to compile because the new protobuf field and C++ signatures are absent.

- [ ] **Step 3: Extend the protobuf and backend request**

```proto
message CreateMatchRequest {
  string room_id = 1;
  uint32 capacity = 2;
  repeated Player players = 3;
  string map_id = 4;
  reserved 5 to 15;
}
```

Set `MapId = room.MapId` in `SimulationMatchClient.CreateMatchAsync`.

- [ ] **Step 4: Store and return the immutable map ID**

Add `map_id` to the private match state and `Admission`, change every `MatchManager::create` call to supply the ID, construct with `route_config(map_id)`, and pass `request->map_id()` from the coordinator. The dev match supplies `classic-ascent`.

- [ ] **Step 5: Add map ID to welcome JSON**

```cpp
message["mapId"] = std::string(map_id);
```

Change `GameplayServer` to call `serialize_welcome(color, roster, admission.map_id)`. Keep the single-player convenience overload defaulting to `classic-ascent` for local test compatibility.

- [ ] **Step 6: Run backend and C++ tests**

Run: `dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj`

Run: `cmake --build build --target linked-up-tests && ctest --test-dir build --output-on-failure`

Expected: PASS.

- [ ] **Step 7: Commit the match identity slice**

```bash
git add contracts backend simulation
git commit -m "feat: carry map identity into matches"
```

---

### Task 3: Author and validate all four C++ routes

**Files:**
- Modify: `simulation/include/linked_up/prototype_simulation.hpp`
- Modify: `simulation/src/prototype_simulation.cpp`
- Test: `simulation/tests/prototype_simulation_test.cpp`

**Interfaces:**
- Produces: `Config route_config(std::string_view map_id)` and keeps `default_route_config()` as the Classic Ascent compatibility alias.
- Consumes: map ID from `MatchManager::create` in Task 2.

- [ ] **Step 1: Write failing registry and composition tests**

```cpp
for (const std::string_view id : {"classic-ascent", "relay-ridge", "crane-shift", "windworks"}) {
  const auto config = linked_up::route_config(id);
  REQUIRE(config.checkpoints.size() == 4);
  REQUIRE(config.summit.half_extent.x > 0.0f);
  REQUIRE(std::unordered_set<std::string>(ids.begin(), ids.end()).size() == ids.size());
}
REQUIRE_THROWS_AS(linked_up::route_config("unknown"), std::invalid_argument);
```

Add exact assertions for each new route's target obstacle-count range, no swinging beams, all five zones, and the mix limits in Global Constraints.

- [ ] **Step 2: Run the route tests and confirm they fail**

Run: `cmake --build build --target linked-up-tests && ctest --test-dir build --output-on-failure`

Expected: FAIL because `route_config` and the three routes do not exist.

- [ ] **Step 3: Extract Classic Ascent behind the registry**

```cpp
Config route_config(std::string_view map_id) {
  if (map_id == "classic-ascent") return classic_ascent_config();
  if (map_id == "relay-ridge") return relay_ridge_config();
  if (map_id == "crane-shift") return crane_shift_config();
  if (map_id == "windworks") return windworks_config();
  throw std::invalid_argument("unknown map id");
}

Config default_route_config() { return route_config("classic-ascent"); }
```

Move the current body unchanged into `classic_ascent_config` inside the translation unit.

- [ ] **Step 4: Author Relay Ridge**

Create 32–38 obstacle records across all zones: wide static ledges and rescue shelves; one slow grass elevator; construction side shuttles plus mirrored pair and regroup platform; an industrial conveyor on a static base followed by a sheltered fan lane; sky rocks, lower anchor shelves, and a short falling-platform relay; stable summit steps. Use unique `relay-*` IDs and keep vertical/forward gaps within the current route's established 1.2–2.2 m rise and 3–6 m forward ranges.

- [ ] **Step 5: Author Crane Shift**

Create 34–40 records with at least 45% static surfaces: a recoverable grass shuttle; broad construction elevators and opposing mirrored shuttles with fixed pads; at most three slow rotating beams on wide industrial/summit decks; three moving crane staircase links separated by a full-crew sky island; a stable summit bypass. Use unique `crane-*` IDs and no force volumes or swinging beams.

- [ ] **Step 6: Author Windworks**

Create 32–38 records: continuous static floors under three or four `Fan` volumes; sheltered construction bays; two or three `Conveyor` volumes paired with static bases; exactly one industrial platform where conveyor and crosswind volumes overlap; short sky wind links with leeward recovery shelves; a broad final gust with a central static refuge and stable finish steps. Use unique `wind-*` IDs and no swinging beams.

- [ ] **Step 7: Publish force direction using existing rotation state**

For `Fan` and `Conveyor` dynamic states, set yaw from their normalized travel vector with `std::atan2(travel.x, travel.z)` so the renderer can align markings without expanding snapshot JSON. Do not alter force application.

- [ ] **Step 8: Run all C++ tests**

Run: `cmake --build build --target linked-up-tests && ctest --test-dir build --output-on-failure`

Expected: PASS, including route validation and legacy physics tests.

- [ ] **Step 9: Commit the authored routes**

```bash
git add simulation
git commit -m "feat: add three authored routes"
```

---

### Task 4: Add the host map selector to the lobby

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/styles.css`
- Modify: `client/src/lobby-state.ts`
- Modify: `client/src/lobby-api.ts`
- Modify: `client/src/lobby.ts`
- Test: `client/src/lobby-state.test.ts`
- Test: `client/src/lobby.test.ts`

**Interfaces:**
- Consumes: `PublicRoom.mapId` and `POST /api/rooms/{code}/map` from Task 1.
- Produces: `MapId`, `mapName(MapId)`, `canSelectMap(RoomState, playerId)`, and `LobbyApi.setMap(code, token, mapId)`.

- [ ] **Step 1: Write failing parser, policy, and request tests**

```ts
assert.equal(parseRoom({ ...validRoom, mapId: "windworks" }).mapId, "windworks");
assert.throws(() => parseRoom({ ...validRoom, mapId: "unknown" }), TypeError);
assert.equal(canSelectMap({ ...validRoom, status: "waiting" }, hostId), true);
assert.equal(canSelectMap({ ...validRoom, status: "starting" }, hostId), false);
```

Exercise `setMap` and assert method `POST`, body `{ "mapId": "relay-ridge" }`, content type, and player token header.

- [ ] **Step 2: Run client tests and confirm they fail**

Run: `npm test --prefix client`

Expected: FAIL because map types, parsing, policy, and API method are missing.

- [ ] **Step 3: Add the closed client map model**

```ts
export const mapNames = {
  "classic-ascent": "Classic Ascent",
  "relay-ridge": "Relay Ridge",
  "crane-shift": "Crane Shift",
  windworks: "Windworks",
} as const;
export type MapId = keyof typeof mapNames;
export const mapName = (id: MapId): string => mapNames[id];
```

Require `mapId` in the strict `parseRoom` key list and validate it with `Object.hasOwn(mapNames, value.mapId)`. Add `canSelectMap` using waiting status and host identity.

- [ ] **Step 4: Add the API request**

```ts
setMap(code: string, token: string, mapId: MapId): Promise<RoomState> {
  return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/map`, {
    method: "POST",
    headers: { "X-Player-Token": token },
    body: JSON.stringify({ mapId }),
  }, parseRoom);
}
```

- [ ] **Step 5: Render and operate the selector**

Add a labeled `#room-map` select with all four options beside lobby controls. `renderRoom` always assigns `room.mapId` and disables it for guests, non-waiting status, or busy requests. On change, set busy, call `setMap`, render the returned room; on failure, restore `currentRoom.mapId` and use `friendlyLobbyError`. SignalR updates continue to use `renderRoom`, so guests see committed changes.

- [ ] **Step 6: Run tests, typecheck, and build**

Run: `npm test --prefix client`

Run: `npm run build --prefix client`

Expected: PASS.

- [ ] **Step 7: Commit the lobby selector**

```bash
git add client
git commit -m "feat: add lobby map selector"
```

---

### Task 5: Show map identity and truthful obstacle visuals in gameplay

**Files:**
- Modify: `client/src/gameplay-protocol.ts`
- Test: `client/src/gameplay-protocol.test.ts`
- Modify: `client/src/game.ts`
- Modify: `client/src/world-blockout.ts`
- Create: `client/src/world-blockout.test.ts`

**Interfaces:**
- Consumes: gameplay `welcome.mapId` from Task 2 and obstacle yaw from Task 3.
- Produces: `WelcomeMessage.mapId`, `obstaclePresentation(NetworkObstacleState, reducedMotion)`, and a HUD route label prefixed with the display map name.

- [ ] **Step 1: Write failing welcome and presentation tests**

```ts
assert.equal(parseServerMessage(JSON.stringify({
  type: "welcome", player: "blue", players: ["blue", "orange"],
  mapId: "crane-shift", tickRate: 60, snapshotRate: 20,
})).mapId, "crane-shift");
assert.throws(() => parseServerMessage(JSON.stringify({ ...welcome, mapId: "unknown" })));

assert.deepEqual(obstaclePresentation(fan, false), {
  solid: false, alpha: 0.24, surfaceHeight: fan.halfExtent.y * 2,
  verticalOffset: 0, marker: "flow", warning: false,
});
assert.equal(obstaclePresentation({ ...falling, phase: "warning" }, true).warning, true);
```

- [ ] **Step 2: Run client tests and confirm they fail**

Run: `npm test --prefix client`

Expected: FAIL because welcome map validation and presentation helpers are missing.

- [ ] **Step 3: Validate welcome map identity**

Import `MapId` validation from `lobby-state.ts`, require `mapId` in the exact welcome keys, and return it on `WelcomeMessage`. Store it in `Game.#onWelcome`; on snapshots set the label to `${mapName(mapId)} · ${zone} · Checkpoint ${checkpoint}`.

- [ ] **Step 4: Implement kind-specific presentation data**

Return solid/default dimensions for platforms; translucent `flow` treatment for fans; a thin surface at the bottom of the authoritative volume for conveyor markings; `motion` top markings for moving platforms; `hub` for rotating beams; and `warning: true` for warning-phase falling platforms independent of reduced-motion preference.

- [ ] **Step 5: Apply Babylon visuals**

Represent each obstacle as a root plus top marker. Fans use alpha-enabled, non-pickable airflow material and two parented chevrons. Conveyors use a thin belt mesh plus parented direction stripes, leaving their paired static base as the solid floor. Moving platforms receive top direction stripes; rotating beams receive a parented cylinder hub. Falling warning phase shrinks/pulses the inset top marker; when reduced motion is active, keep the inset marker static. Parent flow/belt markings to the root so authoritative yaw aligns them.

- [ ] **Step 6: Run tests, typecheck, and build**

Run: `npm test --prefix client`

Run: `npm run build --prefix client`

Expected: PASS.

- [ ] **Step 7: Commit gameplay presentation**

```bash
git add client
git commit -m "feat: render selected maps and hazards"
```

---

### Task 6: Full-stack regression and browser acceptance

**Files:**
- Modify only files already listed if verification exposes a defect.

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: verified four-map lobby-to-simulation flow.

- [ ] **Step 1: Run all automated suites from a clean build**

Run: `dotnet test backend/LinkedUp.Api.Tests/LinkedUp.Api.Tests.csproj`

Run: `cmake --build build && ctest --test-dir build --output-on-failure`

Run: `npm test --prefix client && npm run build --prefix client`

Expected: all commands PASS.

- [ ] **Step 2: Start the local stack and execute lobby acceptance**

Use the repository's documented local services. Create a four-player room, open another browser session as a guest, choose each of Relay Ridge, Crane Shift, Windworks, and Classic Ascent, and verify the guest receives every selection while its selector stays disabled.

- [ ] **Step 3: Launch and inspect every route**

For each map, start a match and verify `welcome.mapId` matches the lobby choice, first snapshot obstacle IDs use that route's prefix, the five-zone geometry is visibly distinct, fans/conveyors are not rendered as solid colliders, and warning falling platforms expose a shape marker. Confirm Classic Ascent still launches.

- [ ] **Step 4: Run final diff hygiene checks**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors and only intended selectable-map changes.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add backend client contracts simulation
git commit -m "fix: verify selectable map flow"
```

Skip this commit if verification required no edits.
