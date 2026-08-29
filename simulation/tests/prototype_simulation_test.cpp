#include "linked_up/prototype_simulation.hpp"

#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

namespace {

using linked_up::Config;
using linked_up::PlayerId;
using linked_up::PlayerInput;
using linked_up::PrototypeSimulation;
using linked_up::Vec3;

bool finite(Vec3 value) {
  return std::isfinite(value.x) && std::isfinite(value.y) && std::isfinite(value.z);
}

float dot(Vec3 left, Vec3 right) { return left.x * right.x + left.y * right.y + left.z * right.z; }

Vec3 subtract(Vec3 left, Vec3 right) {
  return {left.x - right.x, left.y - right.y, left.z - right.z};
}

void bounded_separation() {
  Config config;
  config.platform_half_extent = 20.0f;
  config.tether_slack_length = 2.0f;
  config.tether_hard_length = 5.0f;
  PrototypeSimulation simulation(config);
  simulation.set_input(PlayerId::Blue, {-1.0f, 0.0f, false});
  simulation.set_input(PlayerId::Orange, {1.0f, 0.0f, false});

  for (int tick = 0; tick < 600; ++tick) simulation.step();

  assert(simulation.snapshot().separation <= config.tether_hard_length + 0.02f);
}

void movement_and_jump_are_authoritative() {
  PrototypeSimulation simulation;
  for (int tick = 0; tick < 90; ++tick) simulation.step();
  const float start_x = simulation.snapshot().players[0].position.x;

  simulation.set_input(PlayerId::Blue, {1.0f, 0.0f, false});
  for (int tick = 0; tick < 30; ++tick) simulation.step();
  assert(simulation.snapshot().players[0].position.x > start_x + 0.2f);

  simulation.set_input(PlayerId::Blue, {1.0f, 0.0f, true});
  simulation.step();
  assert(simulation.snapshot().players[0].velocity.y > 1.0f);
}

void falling_player_pulls_teammate() {
  Config config;
  config.platform_half_extent = 2.0f;
  config.spawn_positions = {{{0.0f, 1.5f, 0.0f}, {1.5f, 1.5f, 0.0f}}};
  config.tether_slack_length = 1.0f;
  config.tether_hard_length = 6.0f;
  PrototypeSimulation simulation(config);
  simulation.set_input(PlayerId::Orange, {1.0f, 0.0f, false});

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
  PrototypeSimulation simulation;
  const float nan = std::numeric_limits<float>::quiet_NaN();
  const float infinity = std::numeric_limits<float>::infinity();
  simulation.set_input(PlayerId::Blue, {nan, infinity, true});

  for (int tick = 0; tick < 120; ++tick) simulation.step();

  const auto blue = simulation.snapshot().players[0];
  assert(finite(blue.position));
  assert(finite(blue.velocity));
  assert(std::hypot(blue.velocity.x, blue.velocity.z) < 0.05f);
}

void reset_restores_spawn_state() {
  Config config;
  PrototypeSimulation simulation(config);
  simulation.set_input(PlayerId::Blue, {1.0f, 0.0f, true});
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

}  // namespace

int main() {
  movement_and_jump_are_authoritative();
  bounded_separation();
  falling_player_pulls_teammate();
  malformed_input_is_neutral();
  reset_restores_spawn_state();
  std::cout << "authoritative tether checks passed\n";
}
