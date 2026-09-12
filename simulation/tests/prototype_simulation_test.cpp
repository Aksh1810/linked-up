#include "linked_up/prototype_simulation.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace {

using linked_up::Config;
using linked_up::BoxVolume;
using linked_up::Checkpoint;
using linked_up::MatchState;
using linked_up::ObstacleConfig;
using linked_up::ObstacleKind;
using linked_up::ObstaclePhase;
using linked_up::PlayerInput;
using linked_up::RobotColor;
using linked_up::PrototypeSimulation;
using linked_up::Vec3;
using linked_up::Zone;

bool finite(Vec3 value) {
  return std::isfinite(value.x) && std::isfinite(value.y) && std::isfinite(value.z);
}

float dot(Vec3 left, Vec3 right) { return left.x * right.x + left.y * right.y + left.z * right.z; }

Vec3 subtract(Vec3 left, Vec3 right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

float length(Vec3 value) { return std::sqrt(dot(value, value)); }

std::size_t obstacle_count(const Config& config, ObstacleKind kind) {
  return static_cast<std::size_t>(std::count_if(
      config.obstacles.begin(), config.obstacles.end(),
      [kind](const ObstacleConfig& obstacle) { return obstacle.kind == kind; }));
}

bool overlaps(const ObstacleConfig& left, const ObstacleConfig& right) {
  return std::abs(left.origin.x - right.origin.x) < left.half_extent.x + right.half_extent.x &&
         std::abs(left.origin.y - right.origin.y) < left.half_extent.y + right.half_extent.y &&
         std::abs(left.origin.z - right.origin.z) < left.half_extent.z + right.half_extent.z;
}

std::size_t overlapping_force_pairs(const Config& config) {
  std::size_t count = 0;
  for (const auto& fan : config.obstacles) {
    if (fan.kind != ObstacleKind::Fan) continue;
    for (const auto& conveyor : config.obstacles) {
      if (conveyor.kind == ObstacleKind::Conveyor && overlaps(fan, conveyor)) ++count;
    }
  }
  return count;
}

void assert_route_basics(const Config& config, std::string_view prefix,
                         std::size_t minimum, std::size_t maximum) {
  assert(config.checkpoints.size() == 4);
  assert(config.obstacles.size() >= minimum && config.obstacles.size() <= maximum);
  assert(config.summit.half_extent.x > 0.0f && config.summit.half_extent.y > 0.0f &&
         config.summit.half_extent.z > 0.0f);
  std::set<std::string> ids;
  std::set<Zone> zones;
  for (const auto& obstacle : config.obstacles) {
    assert(obstacle.id.starts_with(prefix));
    assert(ids.insert(obstacle.id).second);
    zones.insert(obstacle.zone);
    assert(obstacle.half_extent.x > 0.0f && obstacle.half_extent.y > 0.0f &&
           obstacle.half_extent.z > 0.0f);
    assert(finite(obstacle.origin) && finite(obstacle.travel));
    assert(obstacle.period_ticks > 0.0f);
  }
  assert(zones.size() == 5);
  for (const auto& checkpoint : config.checkpoints) {
    assert(checkpoint.spawn_positions.size() == 4);
    for (const auto& spawn : checkpoint.spawn_positions) {
      assert(std::abs(spawn.x - checkpoint.volume.center.x) <= checkpoint.volume.half_extent.x);
      assert(std::abs(spawn.y - checkpoint.volume.center.y) <= checkpoint.volume.half_extent.y);
      assert(std::abs(spawn.z - checkpoint.volume.center.z) <= checkpoint.volume.half_extent.z);
    }
  }
}

void two_player_tether_hard_limit_is_authoritative() {
  Config config;
  config.platform_half_extent = 20.0f;
  config.tether_slack_length = 2.0f;
  config.tether_hard_length = 5.0f;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Blue, {-1.0f, 0.0f, false});
  simulation.set_input(RobotColor::Orange, {1.0f, 0.0f, false});

  for (int tick = 0; tick < 600; ++tick) simulation.step();

  const auto state = simulation.snapshot();
  assert(length(subtract(state.players[1].position, state.players[0].position)) <=
         config.tether_hard_length + 0.02f);
}

void movement_and_jump_are_authoritative() {
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange});
  for (int tick = 0; tick < 90; ++tick) simulation.step();
  const float start_x = simulation.snapshot().players[0].position.x;

  simulation.set_input(RobotColor::Blue, {1.0f, 0.0f, false});
  for (int tick = 0; tick < 30; ++tick) simulation.step();
  assert(simulation.snapshot().players[0].position.x > start_x + 0.2f);

  simulation.set_input(RobotColor::Blue, {1.0f, 0.0f, true});
  simulation.step();
  assert(simulation.snapshot().players[0].velocity.y > 1.0f);
}

void jumping_from_an_elevated_platform_is_authoritative() {
  Config config;
  config.obstacles = {
      {"ledge", ObstacleKind::StaticPlatform, {0.0f, 3.0f, 0.0f}, {4.0f, 0.4f, 4.0f}, {}, 60.0f, 0.0f},
  };
  config.spawn_positions = {{{-1.0f, 4.4f, 0.0f}, {1.0f, 4.4f, 0.0f}}};
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);

  simulation.set_input(RobotColor::Blue, {0.0f, 0.0f, true});
  simulation.step();

  assert(simulation.snapshot().players[0].velocity.y > 1.0f);
}

void falling_player_pulls_teammate() {
  Config config;
  config.platform_half_extent = 2.0f;
  config.spawn_positions = {{{0.0f, 1.5f, 0.0f}, {1.5f, 1.5f, 0.0f}}};
  config.tether_slack_length = 1.0f;
  config.tether_hard_length = 6.0f;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Orange, {1.0f, 0.0f, false});

  bool observed_fall_pull = false;
  for (int tick = 0; tick < 360 && !observed_fall_pull; ++tick) {
    simulation.step();
    const auto state = simulation.snapshot();
    const auto& blue = state.players[0];
    const auto& orange = state.players[1];
    const Vec3 toward_orange = subtract(orange.position, blue.position);
    observed_fall_pull =
        !orange.grounded && orange.position.y < 0.8f && dot(blue.velocity, toward_orange) > 0.05f;
  }

  assert(observed_fall_pull);
}

void one_fallen_player_remains_rescuable() {
  Config config;
  config.platform_half_extent = 2.0f;
  config.spawn_positions = {{{0.0f, 1.5f, 0.0f}, {1.5f, 1.5f, 0.0f}}};
  config.fail_height = 0.0f;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Orange, {1.0f, 0.0f, false});

  for (int tick = 0; tick < 240; ++tick) {
    simulation.step();
    const auto state = simulation.snapshot();
    if (state.reset_count > 0 || state.players[1].position.y < config.fail_height) break;
  }

  const auto state = simulation.snapshot();
  assert(state.reset_count == 0);
  assert(state.players[0].grounded);
  assert(state.players[1].position.y < config.fail_height);
}

void hanging_player_can_reel_toward_the_team() {
  Config config;
  config.platform_half_extent = 20.0f;
  config.spawn_positions = {{{18.0f, 1.5f, 0.0f}, {20.4f, 1.5f, 0.0f}}};
  config.tether_slack_length = 4.0f;
  config.tether_hard_length = 7.0f;
  config.fail_height = -100.0f;
  PrototypeSimulation climbing({RobotColor::Blue, RobotColor::Orange}, config);
  PrototypeSimulation control({RobotColor::Blue, RobotColor::Orange}, config);
  for (auto* simulation : {&climbing, &control}) {
    simulation->set_input(RobotColor::Blue, {-1.0f, 0.0f, false});
    simulation->set_input(RobotColor::Orange, {1.0f, 0.0f, false});
  }

  bool hanging = false;
  for (int tick = 0; tick < 240 && !hanging; ++tick) {
    climbing.step();
    control.step();
    const auto state = climbing.snapshot();
    hanging = state.players[0].grounded && !state.players[1].grounded &&
              state.players[1].position.y < 0.5f;
  }
  assert(hanging);

  climbing.set_input(RobotColor::Orange, {-1.0f, 0.0f, true});
  control.set_input(RobotColor::Orange, {-1.0f, 0.0f, false});
  climbing.step();
  control.step();
  assert(climbing.snapshot().players[1].velocity.y >
         control.snapshot().players[1].velocity.y + 0.5f);
  bool rescued = false;
  for (int tick = 0; tick < 240 && !rescued; ++tick) {
    climbing.step();
    rescued = climbing.snapshot().players[1].grounded;
  }
  assert(rescued);
}

void hanging_player_can_clear_an_overhead_ledge() {
  Config config;
  config.platform_half_extent = 0.5f;
  config.obstacles = {
      {"ledge", ObstacleKind::StaticPlatform, {0.0f, 4.0f, 0.0f}, {3.0f, 0.5f, 3.0f}, {}, 60.0f, 0.0f},
  };
  config.spawn_positions = {{{0.0f, 5.5f, 0.0f}, {2.5f, 2.5f, 0.0f}}};
  config.fail_height = -100.0f;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Orange, {0.0f, 0.0f, true});

  bool rescued = false;
  for (int tick = 0; tick < 360 && !rescued; ++tick) {
    simulation.step();
    const auto orange = simulation.snapshot().players[1];
    rescued = orange.grounded && orange.position.y > 4.5f;
  }

  assert(rescued);
}

void full_team_fall_resets_the_checkpoint() {
  Config config;
  config.platform_half_extent = 2.0f;
  config.spawn_positions = {{{-1.5f, 1.5f, 0.0f}, {1.5f, 1.5f, 0.0f}}};
  config.fail_height = 0.0f;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Blue, {-1.0f, 0.0f, false});
  simulation.set_input(RobotColor::Orange, {1.0f, 0.0f, false});

  for (int tick = 0; tick < 300 && simulation.snapshot().reset_count == 0; ++tick) {
    simulation.step();
  }

  assert(simulation.snapshot().reset_count == 1);
}

void falling_team_cannot_reel_without_a_grounded_anchor() {
  Config config;
  config.platform_half_extent = 2.0f;
  config.spawn_positions = {{{0.5f, 1.5f, 0.0f}, {1.5f, 1.5f, 0.0f}}};
  config.fail_height = -100.0f;
  PrototypeSimulation jumping({RobotColor::Blue, RobotColor::Orange}, config);
  PrototypeSimulation control({RobotColor::Blue, RobotColor::Orange}, config);
  for (auto* simulation : {&jumping, &control}) {
    simulation->set_input(RobotColor::Blue, {1.0f, 0.0f, false});
    simulation->set_input(RobotColor::Orange, {1.0f, 0.0f, false});
  }

  bool team_falling = false;
  for (int tick = 0; tick < 240 && !team_falling; ++tick) {
    jumping.step();
    control.step();
    const auto state = jumping.snapshot();
    team_falling = !state.players[0].grounded && !state.players[1].grounded &&
                   state.players[0].position.y < 0.8f && state.players[1].position.y < 0.8f;
  }
  assert(team_falling);

  jumping.set_input(RobotColor::Blue, {0.0f, 0.0f, true});
  jumping.set_input(RobotColor::Orange, {0.0f, 0.0f, true});
  control.set_input(RobotColor::Blue, {});
  control.set_input(RobotColor::Orange, {});
  jumping.step();
  control.step();
  assert(std::abs(jumping.snapshot().players[0].velocity.y -
                  control.snapshot().players[0].velocity.y) < 0.001f);
  assert(std::abs(jumping.snapshot().players[1].velocity.y -
                  control.snapshot().players[1].velocity.y) < 0.001f);
}

void malformed_input_is_neutral() {
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange});
  const float nan = std::numeric_limits<float>::quiet_NaN();
  const float infinity = std::numeric_limits<float>::infinity();
  simulation.set_input(RobotColor::Blue, {nan, infinity, true});

  for (int tick = 0; tick < 120; ++tick) simulation.step();

  const auto blue = simulation.snapshot().players[0];
  assert(finite(blue.position));
  assert(finite(blue.velocity));
  assert(std::hypot(blue.velocity.x, blue.velocity.z) < 0.05f);
}

void reset_restores_spawn_state() {
  Config config;
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.set_input(RobotColor::Blue, {1.0f, 0.0f, true});
  for (int tick = 0; tick < 30; ++tick) simulation.step();

  simulation.reset();
  const auto state = simulation.snapshot();

  assert(state.tick == 0);
  assert(state.reset_count == 1);
  assert(state.tether_tension == 0.0f);
  for (std::size_t index = 0; index < state.players.size(); ++index) {
    assert(std::abs(state.players[index].position.x - config.spawn_positions[index].x) < 0.001f);
    assert(std::abs(state.players[index].position.y - config.spawn_positions[index].y) < 0.001f);
    assert(std::abs(state.players[index].position.z - config.spawn_positions[index].z) < 0.001f);
    assert(std::hypot(state.players[index].velocity.x, state.players[index].velocity.z) < 0.001f);
    assert(std::abs(state.players[index].velocity.y) < 0.001f);
  }
}

void three_and_four_player_rosters_are_authoritative() {
  for (const auto& roster : std::vector<std::vector<RobotColor>>{
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green},
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple}}) {
    PrototypeSimulation simulation(roster);
    for (int tick = 0; tick < 120; ++tick) simulation.step();
    const auto snapshot = simulation.snapshot();
    assert(snapshot.players.size() == roster.size());
    for (std::size_t index = 0; index < roster.size(); ++index) {
      assert(snapshot.players[index].id == roster[index]);
    }
  }
}

void group_tether_pulls_an_outlier_toward_its_teammates() {
  Config config;
  config.platform_half_extent = 20.0f;
  config.tether_slack_length = 1.0f;
  PrototypeSimulation simulation(
      {RobotColor::Blue, RobotColor::Orange, RobotColor::Green}, config);
  const auto initial = simulation.snapshot();
  const Vec3 initial_average{
      (initial.players[0].position.x + initial.players[1].position.x) * 0.5f,
      (initial.players[0].position.y + initial.players[1].position.y) * 0.5f,
      (initial.players[0].position.z + initial.players[1].position.z) * 0.5f,
  };
  const float initial_distance = length(subtract(initial.players[2].position, initial_average));

  simulation.set_input(RobotColor::Green, {-1.0f, 0.0f, false});
  for (int tick = 0; tick < 360; ++tick) simulation.step();
  const auto state = simulation.snapshot();
  const Vec3 average{
      (state.players[0].position.x + state.players[1].position.x) * 0.5f,
      (state.players[0].position.y + state.players[1].position.y) * 0.5f,
      (state.players[0].position.z + state.players[1].position.z) * 0.5f,
  };
  assert(length(subtract(state.players[2].position, average)) < initial_distance);
  assert(state.tether_tension > 0.0f);
}

void invalid_rosters_are_rejected() {
  for (const auto& roster : std::vector<std::vector<RobotColor>>{
           {RobotColor::Blue},
           {RobotColor::Blue, RobotColor::Blue},
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple,
            RobotColor::Blue}}) {
    bool rejected = false;
    try {
      PrototypeSimulation simulation(roster);
    } catch (const std::invalid_argument&) {
      rejected = true;
    }
    assert(rejected);
  }
}

void checkpoint_and_summit_are_authoritative_team_progress() {
  Config config;
  config.checkpoints = {{
      .volume = {{0.0f, 1.5f, 0.0f}, {5.0f, 1.0f, 5.0f}},
      .spawn_positions = config.spawn_positions,
  }};
  config.summit = {{0.0f, 1.5f, 0.0f}, {5.0f, 1.0f, 5.0f}};
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);

  simulation.step();
  const auto completed = simulation.snapshot();
  assert(completed.checkpoint == 1);
  assert(completed.match_state == MatchState::Finished);
  assert(completed.elapsed_ticks == 1);
  simulation.step();
  assert(simulation.snapshot().elapsed_ticks == completed.elapsed_ticks);
}

void dynamic_obstacles_follow_deterministic_paths() {
  Config config;
  config.obstacles = {
      {"lift-1", ObstacleKind::MovingPlatform, {0.0f, 1.0f, 0.0f}, {1.0f, 0.2f, 1.0f},
       {0.0f, 4.0f, 0.0f}, 120.0f, 0.0f},
      {"beam-1", ObstacleKind::RotatingBeam, {3.0f, 1.0f, 0.0f}, {2.0f, 0.2f, 0.2f},
       {}, 120.0f, 0.0f},
  };
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  for (int tick = 0; tick < 30; ++tick) simulation.step();
  const auto state = simulation.snapshot();
  assert(state.obstacles.size() == 2);
  assert(std::abs(state.obstacles[0].position.y - 2.0f) < 0.05f);
  assert(std::abs(state.obstacles[1].rotation.y - 1.570796f) < 0.05f);
}

void moving_platform_reverses_without_teleporting() {
  Config config;
  config.obstacles = {
      {"lift-1", ObstacleKind::MovingPlatform, {0.0f, 3.0f, 0.0f}, {2.0f, 0.3f, 2.0f},
       {0.0f, 4.0f, 0.0f}, 120.0f, 0.0f},
  };
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  for (int tick = 0; tick < 119; ++tick) simulation.step();
  const float before_turnaround = simulation.snapshot().obstacles[0].position.y;

  simulation.step();
  const float at_turnaround = simulation.snapshot().obstacles[0].position.y;

  assert(std::abs(at_turnaround - before_turnaround) < 0.05f);
}

void fan_force_is_authoritative_and_volume_bound() {
  Config config;
  config.obstacles = {
      {"fan-1", ObstacleKind::Fan, {0.0f, 1.5f, 0.0f}, {5.0f, 2.0f, 5.0f},
       {1.0f, 0.0f, 0.0f}, 60.0f, 30.0f},
  };
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  for (int tick = 0; tick < 30; ++tick) simulation.step();
  const auto state = simulation.snapshot();
  assert(state.players[0].velocity.x > 0.1f);
  assert(state.players[1].velocity.x > 0.1f);
  assert(std::abs(state.obstacles[0].rotation.y - 1.570796f) < 0.001f);
}

void falling_platform_warns_falls_and_resets() {
  Config config;
  config.obstacles = {
      {"fall-1", ObstacleKind::FallingPlatform, {0.0f, 3.0f, 0.0f}, {2.0f, 0.3f, 2.0f},
       {}, 3.0f, 6.0f},
  };
  config.spawn_positions = {{{-1.0f, 4.3f, 0.0f}, {1.0f, 4.3f, 0.0f}}};
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  simulation.step();
  assert(simulation.snapshot().obstacles[0].phase == ObstaclePhase::Warning);
  for (int tick = 0; tick < 4; ++tick) simulation.step();
  const auto falling = simulation.snapshot().obstacles[0];
  assert(falling.phase == ObstaclePhase::Falling);
  assert(falling.position.y < config.obstacles[0].origin.y);
  simulation.reset();
  const auto reset = simulation.snapshot().obstacles[0];
  assert(reset.phase == ObstaclePhase::Armed);
  assert(std::abs(reset.position.y - config.obstacles[0].origin.y) < 0.001f);
}

void normal_matches_receive_a_blockout_route() {
  PrototypeSimulation simulation;
  const auto state = simulation.snapshot();
  assert(state.obstacles.size() >= 5);
  assert(state.obstacles[0].kind == ObstacleKind::StaticPlatform);
}

void default_route_opening_ledge_fits_a_single_jump() {
  const Config config = linked_up::default_route_config();
  const auto ledge = std::find_if(config.obstacles.begin(), config.obstacles.end(), [](const ObstacleConfig& obstacle) {
    return obstacle.id == "grass-ledge-1";
  });
  assert(ledge != config.obstacles.end());
  PrototypeSimulation simulation;
  for (int tick = 0; tick < 90; ++tick) simulation.step();

  simulation.set_input(RobotColor::Blue, {0.0f, 0.0f, true});
  float apex = 0.0f;
  for (int tick = 0; tick < 90; ++tick) {
    simulation.step();
    apex = std::max(apex, simulation.snapshot().players[0].position.y);
  }

  assert(apex >= ledge->origin.y + ledge->half_extent.y + 1.1f);
}

void default_route_covers_all_five_blockout_zones() {
  const Config config = linked_up::default_route_config();
  std::set<Zone> zones;
  for (const ObstacleConfig& obstacle : config.obstacles) {
    zones.insert(obstacle.zone);
    assert(obstacle.half_extent.x > 0.0f);
    assert(obstacle.half_extent.y > 0.0f);
    assert(obstacle.half_extent.z > 0.0f);
  }
  assert(config.checkpoints.size() == 4);
  assert(config.obstacles.size() >= 35);
  assert(zones.size() == 5);
}

void authored_route_registry_enforces_each_maps_composition() {
  const auto classic = linked_up::route_config("classic-ascent");
  assert(classic.obstacles.size() == linked_up::default_route_config().obstacles.size());

  const auto relay = linked_up::route_config("relay-ridge");
  assert_route_basics(relay, "relay-", 32, 38);
  assert(obstacle_count(relay, ObstacleKind::MovingPlatform) >= 3);
  assert(obstacle_count(relay, ObstacleKind::Fan) == 1);
  assert(obstacle_count(relay, ObstacleKind::Conveyor) == 1);
  assert(obstacle_count(relay, ObstacleKind::FallingPlatform) >= 2);
  assert(obstacle_count(relay, ObstacleKind::SwingingBeam) == 0);

  const auto crane = linked_up::route_config("crane-shift");
  assert_route_basics(crane, "crane-", 34, 40);
  assert(obstacle_count(crane, ObstacleKind::StaticPlatform) * 100 >=
         crane.obstacles.size() * 45);
  assert(obstacle_count(crane, ObstacleKind::MovingPlatform) >= 6);
  assert(obstacle_count(crane, ObstacleKind::RotatingBeam) >= 1);
  assert(obstacle_count(crane, ObstacleKind::RotatingBeam) <= 3);
  assert(obstacle_count(crane, ObstacleKind::SwingingBeam) == 0);

  const auto wind = linked_up::route_config("windworks");
  assert_route_basics(wind, "wind-", 32, 38);
  assert(obstacle_count(wind, ObstacleKind::Fan) >= 3);
  assert(obstacle_count(wind, ObstacleKind::Fan) <= 4);
  assert(obstacle_count(wind, ObstacleKind::Conveyor) >= 2);
  assert(obstacle_count(wind, ObstacleKind::Conveyor) <= 3);
  assert(overlapping_force_pairs(wind) == 1);
  assert(obstacle_count(wind, ObstacleKind::SwingingBeam) == 0);

  bool rejected = false;
  try {
    static_cast<void>(linked_up::route_config("unknown"));
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);
}

}  // namespace

int main() {
  movement_and_jump_are_authoritative();
  jumping_from_an_elevated_platform_is_authoritative();
  two_player_tether_hard_limit_is_authoritative();
  falling_player_pulls_teammate();
  hanging_player_can_reel_toward_the_team();
  hanging_player_can_clear_an_overhead_ledge();
  one_fallen_player_remains_rescuable();
  full_team_fall_resets_the_checkpoint();
  falling_team_cannot_reel_without_a_grounded_anchor();
  malformed_input_is_neutral();
  reset_restores_spawn_state();
  three_and_four_player_rosters_are_authoritative();
  group_tether_pulls_an_outlier_toward_its_teammates();
  invalid_rosters_are_rejected();
  checkpoint_and_summit_are_authoritative_team_progress();
  dynamic_obstacles_follow_deterministic_paths();
  fan_force_is_authoritative_and_volume_bound();
  falling_platform_warns_falls_and_resets();
  moving_platform_reverses_without_teleporting();
  normal_matches_receive_a_blockout_route();
  default_route_opening_ledge_fits_a_single_jump();
  default_route_covers_all_five_blockout_zones();
  authored_route_registry_enforces_each_maps_composition();
  std::cout << "authoritative tether checks passed\n";
}
