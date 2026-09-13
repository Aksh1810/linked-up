#include "linked_up/prototype_simulation.hpp"

#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using linked_up::DynamicObstacleState;
using linked_up::ObstacleKind;
using linked_up::ObstaclePhase;
using linked_up::PrototypeSimulation;
using linked_up::RobotColor;
using linked_up::Snapshot;
using linked_up::Vec3;
using linked_up::Zone;

std::unique_ptr<PrototypeSimulation> simulation;
std::vector<RobotColor> roster;
std::array<std::uint64_t, 4> acknowledged{};
std::string snapshot_json;

const char* kind_name(ObstacleKind kind) {
  switch (kind) {
    case ObstacleKind::StaticPlatform: return "staticPlatform";
    case ObstacleKind::MovingPlatform: return "movingPlatform";
    case ObstacleKind::RotatingBeam: return "rotatingBeam";
    case ObstacleKind::SwingingBeam: return "swingingBeam";
    case ObstacleKind::Fan: return "fan";
    case ObstacleKind::Conveyor: return "conveyor";
    case ObstacleKind::FallingPlatform: return "fallingPlatform";
  }
  return "staticPlatform";
}

const char* zone_name(Zone zone) {
  switch (zone) {
    case Zone::Grass: return "grass";
    case Zone::Construction: return "construction";
    case Zone::Industrial: return "industrial";
    case Zone::Sky: return "sky";
    case Zone::Summit: return "summit";
  }
  return "grass";
}

const char* phase_name(ObstaclePhase phase) {
  switch (phase) {
    case ObstaclePhase::Armed: return "armed";
    case ObstaclePhase::Warning: return "warning";
    case ObstaclePhase::Falling: return "falling";
  }
  return "armed";
}

void vector_json(std::ostringstream& output, Vec3 value) {
  output << "{\"x\":" << value.x << ",\"y\":" << value.y << ",\"z\":" << value.z << '}';
}

std::vector<RobotColor> parse_roster(std::string_view encoded) {
  constexpr std::array<std::pair<std::string_view, RobotColor>, 4> colors{{
      {"blue", RobotColor::Blue}, {"orange", RobotColor::Orange},
      {"green", RobotColor::Green}, {"purple", RobotColor::Purple}}};
  std::vector<RobotColor> result;
  while (!encoded.empty()) {
    const auto separator = encoded.find(',');
    const auto name = encoded.substr(0, separator);
    const auto found = std::find_if(colors.begin(), colors.end(),
                                    [name](const auto& color) { return color.first == name; });
    if (found == colors.end()) throw std::invalid_argument("unknown player");
    result.push_back(found->second);
    if (separator == std::string_view::npos) break;
    encoded.remove_prefix(separator + 1);
  }
  if (result.size() < 2 || result.size() > 4) throw std::invalid_argument("invalid roster");
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end()) throw std::invalid_argument("duplicate player");
  return result;
}

std::string serialize(const Snapshot& state) {
  std::ostringstream output;
  output << std::setprecision(9) << "{\"type\":\"snapshot\",\"tick\":" << state.tick
         << ",\"resetCount\":" << state.reset_count << ",\"tetherTension\":" << state.tether_tension
         << ",\"players\":[";
  for (std::size_t index = 0; index < state.players.size(); ++index) {
    if (index > 0) output << ',';
    const auto& player = state.players[index];
    output << "{\"id\":\"" << linked_up::color_name(player.id) << "\",\"acknowledgedInput\":"
           << acknowledged[static_cast<std::size_t>(player.id)] << ",\"position\":";
    vector_json(output, player.position);
    output << ",\"velocity\":";
    vector_json(output, player.velocity);
    output << ",\"grounded\":" << (player.grounded ? "true" : "false") << '}';
  }
  output << "],\"matchState\":\"" << (state.match_state == linked_up::MatchState::Running ? "running" : "finished")
         << "\",\"elapsedTicks\":" << state.elapsed_ticks << ",\"checkpoint\":" << state.checkpoint
         << ",\"obstacles\":[";
  for (std::size_t index = 0; index < state.obstacles.size(); ++index) {
    if (index > 0) output << ',';
    const auto& obstacle = state.obstacles[index];
    output << "{\"id\":\"" << obstacle.id << "\",\"kind\":\"" << kind_name(obstacle.kind)
           << "\",\"zone\":\"" << zone_name(obstacle.zone) << "\",\"phase\":\""
           << phase_name(obstacle.phase) << "\",\"halfExtent\":";
    vector_json(output, obstacle.half_extent);
    output << ",\"position\":";
    vector_json(output, obstacle.position);
    output << ",\"rotation\":";
    vector_json(output, obstacle.rotation);
    output << '}';
  }
  output << "]}";
  return output.str();
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int lu_create(const char* map_id, const char* roster_csv) {
  try {
    if (map_id == nullptr || roster_csv == nullptr) return 0;
    const auto config = linked_up::route_config(map_id);
    roster = parse_roster(roster_csv);
    acknowledged.fill(0);
    simulation = std::make_unique<PrototypeSimulation>(roster, config);
    snapshot_json.clear();
    return 1;
  } catch (...) {
    simulation.reset();
    roster.clear();
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE int lu_set_input(int player_index, std::uint32_t sequence,
                                     float move_x, float move_z, int jump) {
  if (!simulation || player_index < 0 || static_cast<std::size_t>(player_index) >= roster.size()
      || !std::isfinite(move_x) || !std::isfinite(move_z) || move_x < -1.0f || move_x > 1.0f
      || move_z < -1.0f || move_z > 1.0f || sequence <= acknowledged[static_cast<std::size_t>(roster[player_index])]) {
    return 0;
  }
  simulation->set_input(roster[player_index], {move_x, move_z, jump != 0});
  acknowledged[static_cast<std::size_t>(roster[player_index])] = sequence;
  snapshot_json.clear();
  return 1;
}

EMSCRIPTEN_KEEPALIVE void lu_step() {
  if (simulation) simulation->step();
  snapshot_json.clear();
}

EMSCRIPTEN_KEEPALIVE const char* lu_snapshot() {
  if (!simulation) return nullptr;
  snapshot_json = serialize(simulation->snapshot());
  return snapshot_json.c_str();
}

EMSCRIPTEN_KEEPALIVE void lu_destroy() {
  simulation.reset();
  roster.clear();
  acknowledged.fill(0);
  snapshot_json.clear();
}

}
