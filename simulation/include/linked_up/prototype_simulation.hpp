#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace linked_up {

enum class RobotColor : std::size_t { Blue, Orange, Green, Purple };

using PlayerId = RobotColor;  // Legacy local development server compatibility.

const char* color_name(RobotColor color);

struct Vec3 {
  float x{};
  float y{};
  float z{};
};

struct BoxVolume {
  Vec3 center;
  Vec3 half_extent;
};

struct Checkpoint {
  BoxVolume volume;
  std::array<Vec3, 4> spawn_positions;
};

enum class MatchState { Running, Finished };

enum class Zone { Grass, Construction, Industrial, Sky, Summit };

enum class ObstacleKind { StaticPlatform, MovingPlatform, RotatingBeam, SwingingBeam, Fan, Conveyor, FallingPlatform };
enum class ObstaclePhase { Armed, Warning, Falling };

struct ObstacleConfig {
  std::string id;
  ObstacleKind kind{};
  Vec3 origin;
  Vec3 half_extent;
  Vec3 travel;
  float period_ticks{60.0f};
  float amplitude{};
  Zone zone{Zone::Grass};
};

struct DynamicObstacleState {
  std::string id;
  ObstacleKind kind{};
  Vec3 position;
  Vec3 rotation;
  Vec3 half_extent;
  Zone zone{Zone::Grass};
  ObstaclePhase phase{ObstaclePhase::Armed};
};

struct PlayerInput {
  float move_x{};
  float move_z{};
  bool jump{};
};

struct PlayerState {
  RobotColor id{};
  Vec3 position;
  Vec3 velocity;
  bool grounded{};
};

struct Snapshot {
  std::uint64_t tick{};
  std::vector<PlayerState> players;
  float tether_tension{};
  std::uint64_t reset_count{};
  std::uint64_t elapsed_ticks{};
  std::size_t checkpoint{};
  MatchState match_state{MatchState::Running};
  std::vector<DynamicObstacleState> obstacles;
};

struct Config {
  float tick_rate{60.0f};
  float move_speed{6.0f};
  float acceleration{30.0f};
  float jump_speed{7.0f};
  float platform_half_extent{5.0f};
  std::array<Vec3, 4> spawn_positions{{{-1.0f, 1.5f, 0.0f}, {1.0f, 1.5f, 0.0f},
                                        {-3.0f, 1.5f, 0.0f}, {3.0f, 1.5f, 0.0f}}};
  float tether_slack_length{4.0f};
  float tether_hard_length{7.0f};
  float tether_stiffness{45.0f};
  float tether_damping{8.0f};
  float tether_max_force{120.0f};
  float fail_height{-12.0f};
  std::vector<Checkpoint> checkpoints;
  BoxVolume summit{{0.0f, 1000.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
  std::vector<ObstacleConfig> obstacles;
};

[[nodiscard]] Config default_route_config();
[[nodiscard]] Config route_config(std::string_view map_id);

class PrototypeSimulation {
 public:
  PrototypeSimulation();  // Legacy local development server compatibility.
  explicit PrototypeSimulation(std::vector<RobotColor> roster, Config config = {});
  ~PrototypeSimulation();

  PrototypeSimulation(const PrototypeSimulation&) = delete;
  PrototypeSimulation& operator=(const PrototypeSimulation&) = delete;

  void set_input(RobotColor player, PlayerInput input);
  void step();
  [[nodiscard]] Snapshot snapshot() const;
  void reset();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace linked_up
