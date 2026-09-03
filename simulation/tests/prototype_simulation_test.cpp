#include "linked_up/prototype_simulation.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
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

bool finite(Vec3 value) {
  return std::isfinite(value.x) && std::isfinite(value.y) && std::isfinite(value.z);
}

float dot(Vec3 left, Vec3 right) { return left.x * right.x + left.y * right.y + left.z * right.z; }

Vec3 subtract(Vec3 left, Vec3 right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

float length(Vec3 value) { return std::sqrt(dot(value, value)); }

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

void fan_force_is_authoritative_and_volume_bound() {
  Config config;
  config.obstacles = {
      {"fan-1", ObstacleKind::Fan, {0.0f, 1.5f, 0.0f}, {5.0f, 2.0f, 5.0f},
       {0.0f, 0.0f, 1.0f}, 60.0f, 30.0f},
  };
  PrototypeSimulation simulation({RobotColor::Blue, RobotColor::Orange}, config);
  for (int tick = 0; tick < 30; ++tick) simulation.step();
  const auto state = simulation.snapshot();
  assert(state.players[0].velocity.z > 0.1f);
  assert(state.players[1].velocity.z > 0.1f);
}

void falling_platform_warns_falls_and_resets() {
  Config config;
  config.obstacles = {
      {"fall-1", ObstacleKind::FallingPlatform, {0.0f, 1.5f, 0.0f}, {5.0f, 2.0f, 5.0f},
       {}, 3.0f, 6.0f},
  };
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
    return obstacle.id == "ledge-1";
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

}  // namespace

int main() {
  movement_and_jump_are_authoritative();
  jumping_from_an_elevated_platform_is_authoritative();
  two_player_tether_hard_limit_is_authoritative();
  falling_player_pulls_teammate();
  malformed_input_is_neutral();
  reset_restores_spawn_state();
  three_and_four_player_rosters_are_authoritative();
  group_tether_pulls_an_outlier_toward_its_teammates();
  invalid_rosters_are_rejected();
  checkpoint_and_summit_are_authoritative_team_progress();
  dynamic_obstacles_follow_deterministic_paths();
  fan_force_is_authoritative_and_volume_bound();
  falling_platform_warns_falls_and_resets();
  normal_matches_receive_a_blockout_route();
  default_route_opening_ledge_fits_a_single_jump();
  std::cout << "authoritative tether checks passed\n";
}
