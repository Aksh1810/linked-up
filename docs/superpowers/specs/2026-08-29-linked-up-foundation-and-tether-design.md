# Linked-Up Foundation and Authoritative Tether Design

Date: 2026-08-29
Status: Approved for implementation

## Purpose

Establish the monorepo and prove Linked-Up's central mechanic before building
the lobby, final networking transport, or climbing world. The retained result
is a small C++20/Jolt simulation in which two players stand on one platform,
move, jump, fall, and affect one another through an authoritative energy
tether.

This is the first subproject of the larger Linked-Up specification. Later
subprojects add browser rendering and gameplay networking, lobby
orchestration, the complete course, polish, and deployment.

## Success criteria

- The repository has a minimal documented monorepo layout and repeatable build
  commands.
- A fixed 60 Hz C++ simulation owns both players' positions and velocities.
- Jolt Physics owns gravity, collision, and player/environment interaction.
- A configurable damped tether prevents unbounded separation and transfers
  force between players.
- The prototype demonstrates that one falling player pulls the other.
- One runnable automated check covers tether distance, force transfer, input
  validation, and deterministic reset behavior.
- Stubbed browser, ASP.NET, Redis, gRPC, and deployment code is not created.

## Non-goals

- A polished robot, final level, lobby, accounts, persistence, or matchmaking
- Browser-to-C++ networking, prediction, reconciliation, or WebTransport
- ASP.NET Core, SignalR, Redis, gRPC, Protocol Buffer generation, or containers
- More than two players, alternate tether topologies, or realistic rope links
- Production performance, clustering, reconnection, metrics, or CI

These remain in the master roadmap; omitting them here prevents infrastructure
from hiding whether the tether is stable and fun.

## Repository shape

```text
linked-up/
├── README.md
├── client/                 # Added with the browser prototype
├── simulation/
│   ├── CMakeLists.txt
│   ├── include/linked_up/
│   ├── src/
│   └── tests/
├── backend/                # Added with the lobby milestone
├── contracts/proto/        # Added when the first contract is consumed
├── docs/
│   ├── architecture.md
│   ├── game-design.md
│   ├── networking.md
│   └── superpowers/specs/
└── infrastructure/         # Added with Redis/deployment work
```

Only `simulation`, the required root documentation, and this design area are
created in the first implementation. Empty placeholder directories are not.

## Simulation design

The first executable owns one `PrototypeSimulation`. It contains Jolt world
state, two player bodies, the platform, fixed-step timing state, current input,
and tether tuning. This is one concrete component, not an interface hierarchy.

Public behavior is intentionally narrow:

```cpp
PrototypeSimulation(Config config);
void set_input(PlayerId player, PlayerInput input);
void step();
Snapshot snapshot() const;
void reset();
```

`step()` advances exactly one configured fixed timestep. Wall-clock scheduling
belongs to the executable, keeping tests deterministic. `Snapshot` exposes
only data that a later browser client will need: tick, position, velocity,
grounded state, and normalized tether tension.

Player inputs contain horizontal movement and a jump edge. Inputs are rejected
or clamped at this trust boundary: non-finite values become neutral input,
movement magnitude is capped at one, and repeated jump state cannot create
multiple impulses without becoming grounded again.

## Physics and tether

Players use stable capsule-shaped bodies rather than ragdolls. Movement applies
a target horizontal velocity with bounded acceleration; jumping applies one
vertical impulse while grounded. Jolt resolves gravity and collision against a
single static platform.

The two-player tether is a damped distance constraint implemented as forces,
not chain links:

```text
stretch = max(0, distance - slackLength)
closingSpeed = dot(relativeVelocity, direction)
force = clamp(stiffness * stretch + damping * closingSpeed, 0, maxForce)
```

Equal and opposite forces are applied along the player-to-player direction.
No tether force is applied inside the slack length. A separate hard distance
limit prevents numerical instability if a large impulse or tick overrun gets
past the soft force. The correction conserves the midpoint where collision
allows it instead of teleporting only one player.

Development defaults live together in `Config`:

- tick rate: 60 Hz
- player speed, acceleration, jump impulse
- gravity multiplier
- tether slack length, hard length, stiffness, damping, and force cap
- spawn positions and fail height

The exact numeric defaults are implementation-time tuning values and are
printed by the prototype so results can be reproduced. They are not spread
through source files.

## Prototype scenario

The executable runs a simple scripted demonstration unless launched in check
mode:

1. Spawn both players safely on one platform.
2. Move them apart until the tether becomes taut.
3. Move one player beyond the platform edge.
4. Continue stepping while reporting tick, separation, and tension.
5. Reset both players if they pass the configured fail height.

This demonstrates authoritative behavior without pretending that browser
networking exists. The next subproject replaces scripted inputs with commands
from two browser clients while keeping the simulation API.

## Failure handling

- Invalid configuration fails at process startup with a clear message.
- Invalid input is neutralized and never reaches Jolt.
- Fixed-step overruns are reported by the executable; simulation steps are not
  changed to variable delta time.
- Non-finite physics state aborts the prototype/check rather than emitting a
  plausible-looking snapshot.
- Falling below the fail height resets both players to the known spawn state.

## Verification

A small CTest executable uses assertions and deterministic calls to `step()`.
It proves:

1. Two players driven apart cannot remain beyond the configured hard limit.
2. When one unsupported player falls and tensions the tether, the supported
   player's velocity changes toward the falling player.
3. Non-finite and oversized movement inputs cannot produce non-finite or
   out-of-range movement.
4. Team reset restores spawn transforms, zero velocity, and tether state.

The implementation is complete only when configuration and build commands are
documented, a clean build succeeds, CTest passes, and the scripted executable
runs without non-finite state.

## Dependencies

- C++20 compiler
- CMake as the build tool
- Jolt Physics as the only runtime library
- CTest and plain assertions for the prototype check

Jolt is pinned to release `v5.6.0` through CMake dependency management. No
logging, test, JSON, networking, or dependency-injection library is added.

## Future boundaries

The next retained slice adds Babylon.js rendering and a simple WebSocket path
from two browser clients directly to C++. The wire format and WebTransport
decision belong to that slice because no wire protocol is consumed here.

ASP.NET Core, SignalR, Redis, and gRPC enter only when rooms and match lifecycle
exist. Their ownership remains fixed by the master specification:

- Browser: input and presentation
- C++: authoritative physical outcome
- ASP.NET Core: room and match lifecycle
- Redis: expiring room state

## Milestone sequence

1. Repository foundation and this authoritative tether prototype
2. Babylon.js local movement/camera and robot presentation
3. Two-browser authoritative gameplay loop over WebSockets
4. Snapshot interpolation, local movement prediction, and reconciliation
5. ASP.NET Core lobby, SignalR presence, and Redis TTL state
6. gRPC match lifecycle between ASP.NET Core and C++
7. Obstacles, checkpoints, team reset, summit, and timer
8. Five-zone blockout and playtesting
9. Visual/audio polish, replay, cleanup, and deployment preparation

Each milestone must run end to end for the behavior it claims before the next
one begins.
