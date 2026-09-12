# Selectable Maps Design

## Goal

Add three authored maps—Relay Ridge, Crane Shift, and Windworks—alongside the existing route, renamed Classic Ascent. The host can change the selected map in the waiting lobby, every player sees the choice update live, and the C++ simulation remains authoritative for the selected route.

## Scope

This slice includes:

- four fixed map IDs and display names;
- host-only map selection while a room is waiting;
- Redis persistence and SignalR broadcast of the selected map;
- map identity through match creation and gameplay welcome data;
- three complete five-zone route configurations using existing obstacle kinds;
- truthful fan, conveyor, and falling-warning presentation;
- backend, C++, protocol, client, and browser verification.

It does not add a map file format, editor, procedural generation, workshop support, new physics mechanics, difficulty presets, or a dynamic map catalog.

## Approach

Use a small fixed registry at each trust boundary. The browser may request one of four public IDs, ASP.NET validates and persists it, and C++ validates it again before constructing the route. Geometry never crosses from the browser or Redis into the simulation.

The map IDs are:

| ID | Display name |
| --- | --- |
| `classic-ascent` | Classic Ascent |
| `relay-ridge` | Relay Ridge |
| `crane-shift` | Crane Shift |
| `windworks` | Windworks |

New rooms default to `classic-ascent`.

## Data Flow

```text
Host selects map
  -> POST /api/rooms/{code}/map + player token
  -> Redis optimistic room mutation
  -> SignalR RoomUpdated to every lobby member

Host starts room
  -> CreateMatchRequest.map_id
  -> C++ fixed route registry
  -> PrototypeSimulation(roster, selected Config)
  -> gameplay welcome.mapId
  -> browser HUD and authoritative obstacle snapshots
```

## Lobby and Room Model

`Room` gains `MapId`, initialized to Classic Ascent. `PublicRoom` exposes `mapId`; no private or simulation data is added to the public DTO. Missing `MapId` in an older Redis record falls back to Classic Ascent.

Add `SetRoomMapRequest(string MapId)` and `POST /api/rooms/{code}/map`. The endpoint requires `X-Player-Token`, normalizes no arbitrary values, and accepts only an exact registered ID. The room mutation succeeds only when:

- the session is valid;
- the caller is the current host;
- the room status is `Waiting`;
- the requested ID is registered.

Success increments the room version, refreshes its TTL through the existing mutation path, returns `PublicRoom`, and broadcasts `RoomUpdated`. Guests render the selected map but cannot change it. The selector is disabled while a request is in flight and after the room starts.

Host migration requires no special map behavior: the selection remains on the room and the new host gains selector control through the existing host flag.

Errors use the current Problem Details boundary:

- unknown map: `400 Invalid room request`;
- invalid session: `401`;
- non-host: `403`;
- starting or in-game room: `409`.

## Match Contract and Authority

Add `string map_id = 4` to `CreateMatchRequest`, consuming the first reserved field. ASP.NET copies `Room.MapId`; C++ rejects unknown IDs with `INVALID_ARGUMENT` and passes the validated map ID to `MatchManager::create`.

Each match stores its immutable map ID with the simulation. Admission returns it so `GameplayServer` can serialize `welcome.mapId`. The browser requires one of the four IDs in welcome data. Snapshot geometry remains authoritative exactly as today.

The local development match uses Classic Ascent.

## C++ Route Registry

Keep selection boring: one `route_config(std::string_view map_id)` function dispatches to four authored configuration functions. Unknown IDs throw `std::invalid_argument`. No generic loader or base class is introduced.

All routes retain the existing `Config`, five `Zone` values, four checkpoints, all-player summit rule, 60 Hz tick model, and current obstacle kinds. Each route must have unique obstacle IDs, valid positive dimensions and periods, safe four-player checkpoint spawns, and a reachable opening jump.

Moving-platform phase variety uses mirrored origins and opposite travel vectors where possible. No phase-offset field is added solely for these maps.

## Route Designs

### Classic Ascent

The existing 35-obstacle route remains unchanged except for its public identity. This preserves current behavior and provides the compatibility default.

### Relay Ridge

Purpose: forgiving social relay and recovery map.

- Grass teaches wide offset steps, a visible lower rescue shelf, and one slow elevator.
- Construction introduces broad side shuttles separately, then a mirrored shuttle pair with a stable regroup island.
- Industrial uses one low-force conveyor and one sheltered fan lane, never first introduced together.
- Sky alternates roomy rocks, anchor-friendly lower shelves, and a crumble relay with a stable midpoint.
- Summit is stable and hazard-free so the whole crew can gather in the finish volume.

Target: 32–38 obstacles. Primary verbs: scout, anchor, rescue, regroup.

### Crane Shift

Purpose: timing, boarding, and shared countdowns.

- Grass teaches a slow side shuttle over recoverable ground.
- Construction uses broad elevators and a mirrored shuttle pair with fixed endpoint pads.
- Industrial introduces slow rotating beams on wide decks with visible refuge space.
- Sky forms a three-link crane staircase with a full crew island before the final transfer.
- Summit reuses one slow beam with a generous bypass, followed by stable finish steps.

Target: 34–40 obstacles, at least 45% static surfaces, no more than three rotating-beam encounters. Primary verbs: wait, call, board, regroup.

### Windworks

Purpose: formation control through visible airflow and conveyors.

- Grass introduces weak airflow over continuous safe floor.
- Construction divides a fan crossing with solid sheltered bays.
- Industrial teaches a conveyor, reverses its direction, then combines a mild conveyor and crosswind after a checkpoint.
- Sky alternates short wind links with leeward recovery shelves.
- Summit has one broad final gust with a central refuge, then stable finish steps.

Target: 32–38 obstacles, three or four fan volumes, two or three conveyor volumes, and only one combined-force encounter. Primary verbs: shelter, space, anchor, regroup.

## Hazard Presentation

The browser currently gives every obstacle the same box silhouette. The new maps require the presentation to explain server behavior:

- moving platforms keep a solid box but gain directional top markings;
- rotating beams keep a solid beam and visible hub;
- fan force volumes render as translucent airflow with directional markers, not solid collision geometry;
- conveyors render as thin walkable belt markings aligned with their force direction, paired with the authoritative static floor;
- falling platforms visibly distinguish `warning` with a non-color marker and restrained motion; reduced-motion mode keeps the marker without shaking;
- `falling` continues to follow the authoritative pose and hide only after leaving the visible course.

The SwingingBeam mismatch is outside the three new maps: none of them requires it. Classic Ascent retains its current swing for compatibility; fixing the collider/presentation mismatch is a separate bug fix unless verification shows it blocks the new selector flow.

## Client UX

The lobby shows a labeled Map selector near capacity/start controls.

- Host, waiting: enabled select with four display names.
- Guest, waiting: disabled select showing the live choice.
- Starting/in game: disabled.
- Request failure: restore the authoritative room value and show the existing lobby error treatment.

The gameplay route label includes the map display name from `welcome.mapId`, while checkpoint/zone continues to come from snapshots. Map names are mapped locally from the validated fixed IDs; the wire sends IDs, not presentation strings.

## Compatibility and Failure Handling

- Existing rooms without a stored map use Classic Ascent.
- Existing direct-development URLs use Classic Ascent.
- Unknown browser map values are rejected by ASP.NET.
- Unknown gRPC map values are rejected again by C++.
- A failed map update leaves the authoritative room unchanged.
- A start races safely with map selection through the existing Redis optimistic mutation: whichever waiting-room mutation commits first is authoritative; once status changes, map changes fail.
- Map IDs are logged, but obstacle geometry and tickets are not added to lobby storage or logs.

## Testing

### Backend

- new rooms default to Classic Ascent;
- host can change a waiting room map;
- non-host, unknown map, and non-waiting mutations fail correctly;
- selection survives serialization, join, host migration, and room updates;
- start sends the selected map through gRPC;
- older stored rooms missing `MapId` read as Classic Ascent.

### C++

- each registered map creates a valid route with five zones, four checkpoints, a summit, unique IDs, and its intended obstacle mix;
- unknown map IDs are rejected;
- MatchManager stores and returns map identity;
- gameplay welcome serializes map ID;
- existing route and physics checks remain green.

### Client

- public room parsing requires a known map ID;
- only a waiting host can operate the selector;
- live room updates change the displayed choice;
- map update failure restores authoritative state;
- welcome parsing validates map ID;
- gameplay HUD renders the selected display name;
- hazard presentation helpers cover fan, conveyor, moving, rotating, warning, and reduced-motion states.

### End-to-End

Start the local stack, create a room, join a guest, and verify:

1. the host can select each of the three new maps;
2. the guest receives each change live and cannot edit it;
3. starting launches both players into the selected map;
4. welcome map identity and snapshot obstacle IDs agree;
5. each selected route renders distinct geometry and its intended hazard types;
6. Classic Ascent remains selectable and launchable.

## Acceptance Criteria

- All four maps are host-selectable in a waiting lobby.
- All players see the authoritative selection live.
- The selected map, not a client fallback, determines the C++ route.
- Relay Ridge, Crane Shift, and Windworks are complete five-zone authored routes with four checkpoints and distinct obstacle compositions.
- Hazard visuals do not represent fan/conveyor force volumes as solid colliders and expose falling warnings without color alone.
- Invalid or late map changes are rejected without corrupting room or match state.
- Existing Classic Ascent behavior remains available.
- Backend, C++, client, and browser verification pass.
