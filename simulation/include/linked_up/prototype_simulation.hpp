#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace linked_up {

enum class PlayerId : std::size_t { Blue, Orange };

struct Vec3 {
  float x{};
  float y{};
  float z{};
};

struct PlayerInput {
  float move_x{};
  float move_z{};
  bool jump{};
};

struct PlayerState {
  Vec3 position;
  Vec3 velocity;
  bool grounded{};
};

struct Snapshot {
  std::uint64_t tick{};
  std::array<PlayerState, 2> players;
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

  PrototypeSimulation(const PrototypeSimulation&) = delete;
  PrototypeSimulation& operator=(const PrototypeSimulation&) = delete;

  void set_input(PlayerId player, PlayerInput input);
  void step();
  [[nodiscard]] Snapshot snapshot() const;
  void reset();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace linked_up
