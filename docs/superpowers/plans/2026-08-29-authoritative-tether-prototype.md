# Authoritative Tether Prototype Implementation Plan

> **For agentic workers:** Execute inline in this session. Do not create commits; the user will commit the working tree.

**Goal:** Build and verify a fixed-step C++20/Jolt prototype where two authoritative players move, jump, fall, and pull one another through a configurable tether.

**Architecture:** `PrototypeSimulation` owns one small Jolt world and exposes plain input/snapshot types. A console program scripts the prototype; one assertion-based CTest executable verifies behavior without adding a test framework.

**Tech Stack:** C++20, CMake 3.20+, Jolt Physics v5.6.0, CTest

**Spec:** `docs/superpowers/specs/2026-08-29-linked-up-foundation-and-tether-design.md`

## Global Constraints

- The authoritative simulation advances at a fixed 60 Hz default.
- Jolt owns gravity and collision.
- The tether is a force-capped damped distance constraint, not rope links.
- Inputs are validated at the public boundary.
- No browser, backend, networking, Redis, gRPC, container, or empty scaffolding is added.
- No commits are created.

---

### Task 1: Build boundary and wished-for API

**Files:**
- Create: `.gitignore`
- Create: `CMakeLists.txt`
- Create: `simulation/CMakeLists.txt`
- Create: `simulation/include/linked_up/prototype_simulation.hpp`
- Create: `simulation/tests/prototype_simulation_test.cpp`

**Interfaces:**
- Produces: `linked_up::PrototypeSimulation`, `Config`, `PlayerInput`, `Snapshot`, and `PlayerId`

- [x] Write the assertion executable first. Its four named checks call the public API for bounded separation, falling-player force transfer, malformed input, and reset.
- [x] Configure and build; verify RED because `PrototypeSimulation` has declarations but no definitions.
- [x] Pin Jolt v5.6.0 with `FetchContent` and disable its samples, profiler, debug renderer, compute backends, LTO, and install target.

The public header defines the exact API:

```cpp
enum class PlayerId : std::size_t { Blue, Orange };
struct Vec3 { float x, y, z; };
struct PlayerInput { float move_x{}; float move_z{}; bool jump{}; };
struct PlayerState { Vec3 position; Vec3 velocity; bool grounded; };
struct Snapshot {
  std::uint64_t tick{};
  std::array<PlayerState, 2> players{};
  float separation{};
  float tether_tension{};
  std::uint64_t reset_count{};
};
struct Config {
  float tick_rate{60.0f};
  float move_speed{6.0f};
  float acceleration{30.0f};
  float jump_speed{7.0f};
  float platform_half_extent{5.0f};
  std::array<Vec3, 2> spawn_positions{{{-1.0f, 1.5f, 0.0f}, {1.0f, 1.5f, 0.0f}}};
  float tether_slack_length{4.0f};
  float tether_hard_length{7.0f};
  float tether_stiffness{45.0f};
  float tether_damping{8.0f};
  float tether_max_force{120.0f};
  float fail_height{-12.0f};
};
class PrototypeSimulation {
 public:
  explicit PrototypeSimulation(Config config = {});
  ~PrototypeSimulation();
  void set_input(PlayerId, PlayerInput);
  void step();
  Snapshot snapshot() const;
  void reset();
};
```

### Task 2: Make authoritative physics pass

**Files:**
- Create: `simulation/src/prototype_simulation.cpp`
- Modify: `simulation/tests/prototype_simulation_test.cpp`

**Interfaces:**
- Consumes: the API from Task 1
- Produces: working `set_input`, `step`, `snapshot`, and `reset`

- [x] Implement Jolt allocator/factory/type lifetime, two collision layers, one static platform, and two dynamic capsule bodies.
- [x] Clamp movement magnitude to one and neutralize non-finite input.
- [x] On each step, approach target horizontal velocity, apply one grounded jump, apply equal/opposite tether forces, update Jolt once, enforce the hard tether limit, validate finite state, and team-reset below the fail height.
- [x] Run the test after each behavior and keep the smallest implementation that turns its named RED check GREEN.
- [x] Run all checks with `ctest --test-dir build --output-on-failure`.

### Task 3: Runnable demonstration and documentation

**Files:**
- Create: `simulation/src/main.cpp`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/game-design.md`
- Create: `docs/networking.md`

**Interfaces:**
- Consumes: `PrototypeSimulation`
- Produces: `linked-up-sim` executable and documented build/run commands

- [x] Add a scripted 600-tick scenario that moves the players apart, drives Orange off the platform, and prints periodic tick/separation/tension/player positions.
- [x] Document current scope, ownership boundaries, tuning values, prerequisites, build, test, and run commands; label networking as the next milestone rather than implemented behavior.
- [x] Build with warnings enabled for project code, run CTest, run the demo, and verify all reported state is finite.
- [x] Inspect the working-tree diff and confirm no unrelated or placeholder subsystem files were added.
