# Architecture

Linked-Up keeps four ownership boundaries:

| Component | Owns |
| --- | --- |
| Browser | Controls, camera, rendering, animation, audio, interpolation, and local presentation |
| C++ simulation | In-memory match lifecycle, ticket admission, fixed-step physics, player state, and tether forces |
| ASP.NET Core | Temporary player sessions, rooms, lobby presence, host rules, and match orchestration |
| Redis | Expiring room and session state |

The browser sends player intent; it never sends trusted positions. ASP.NET
Core stays out of the high-frequency gameplay path.

```text
Browser -- HTTP/SignalR --> ASP.NET Core -- Redis
ASP.NET Core -- h2c gRPC :50051 --> C++ MatchManager
Browser -- ws match + short-lived ticket :9002 --> C++ authoritative match
```

The API makes a deadline-bound, versioned h2c gRPC call to the loopback C++
`MatchManager` once a full, present room starts. C++ creates the authoritative
in-memory match and returns a launch for every ordered player. The API persists
the room's `InGame` state, publishes its public update, and sends each launch
only through that player's subscribed SignalR connections. Gameplay thereafter
flows directly between browser and C++.

## Authoritative match implementation

`MatchManager` owns each in-memory two-to-four-player match. It mints a
32-byte opaque ticket per player, keeps only its SHA-256 digest, compares
digests in constant time, expires the ticket after 60 seconds, and consumes it
on successful admission. `PrototypeSimulation` owns that match's Jolt world,
ordered capsule roster, validated inputs, and group tether. `step()` advances
exactly one fixed tick; the caller owns wall-clock scheduling.

`linked-up-server` starts both loopback listeners: gRPC on `127.0.0.1:50051`
and gameplay WebSockets on `127.0.0.1:9002`. Crow validates admission and JSON
input, copies the latest intent into the fixed 60 Hz simulation loop, and
broadcasts match snapshots every third tick. The same snapshot carries the
authoritative route state: checkpoint, elapsed ticks, running/finished status,
and ordered obstacle transforms. Each player state acknowledges
the last input sequence actually applied by that tick. A disconnect neutralizes
that player's input.

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
the tether around the displayed ordered roster; it does not simulate tether
physics.

## Lobby-to-match handoff

The root browser route creates temporary rooms with capacities from two to
four. Invite routes join the next Blue, Orange, Green, or Purple slot. The
browser keeps each private session token in that tab's `sessionStorage`, sends
it only for authenticated room operations and SignalR subscription, and
renders only the API's public room shape.

ASP.NET Core owns room validation, host-only start, host migration, and the
`waiting`/`starting`/`inGame` lifecycle. It only creates a match when every
player has an active lobby presence; unavailable C++ creation rolls the room
back to `waiting`. SignalR pushes public room updates and delivers each private
`MatchReady` launch only to the matching player's connections. Presence is
in-process for the single API instance.

Redis owns optimistic room mutations, hashed lobby session tokens, and a
sliding two-hour expiry. It contains neither gameplay snapshots nor gameplay
tickets. Normal browsers retain the private ticket only in memory through the
three-second countdown and use it once to open their direct WebSocket.

`?player=blue|orange` remains a clearly local-only, loopback development bypass
to a fixed two-player match. It skips the lobby and ticket boundary. Accounts,
persistent match storage, a SignalR backplane, WebTransport, production TLS,
and deployment work are outside this slice.
