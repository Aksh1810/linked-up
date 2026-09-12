#include "linked_up/gameplay_protocol.hpp"

#include <crow/json.h>

#include <cassert>
#include <chrono>
#include <cmath>
#include <iostream>
#include <string>
#include <stdexcept>
#include <vector>

namespace {

using linked_up::InputGate;
using linked_up::ProtocolError;
using linked_up::RobotColor;
using linked_up::Snapshot;

void valid_input_is_decoded() {
  InputGate gate;
  const auto result = gate.accept(
      R"({"type":"input","sequence":1,"clientTick":9,"moveX":0.5,"moveZ":-1,"jump":true})",
      InputGate::Clock::time_point{});

  assert(result.value.has_value());
  assert(result.error == ProtocolError::None);
  assert(result.value->sequence == 1);
  assert(result.value->client_tick == 9);
  assert(std::abs(result.value->input.move_x - 0.5f) < 0.001f);
  assert(std::abs(result.value->input.move_z + 1.0f) < 0.001f);
  assert(result.value->input.jump);
}

void malformed_and_out_of_range_input_is_rejected() {
  const auto now = InputGate::Clock::time_point{};
  InputGate gate;
  assert(gate.accept("not json", now).error == ProtocolError::Malformed);
  assert(gate.accept(
                 R"({"type":"input","sequence":1,"clientTick":1,"moveX":0,"moveZ":0})",
                 now)
             .error == ProtocolError::Malformed);
  assert(gate.accept(
                 R"({"type":"input","sequence":1,"clientTick":1,"moveX":"right","moveZ":0,"jump":false})",
                 now)
             .error == ProtocolError::Malformed);
  assert(gate.accept(
                 R"({"type":"input","sequence":1,"clientTick":1,"moveX":1.01,"moveZ":0,"jump":false})",
                 now)
             .error == ProtocolError::OutOfRange);
}

void stale_and_excessive_input_is_rejected() {
  const auto now = InputGate::Clock::time_point{};
  InputGate stale_gate;
  const std::string first =
      R"({"type":"input","sequence":5,"clientTick":5,"moveX":0,"moveZ":0,"jump":false})";
  assert(stale_gate.accept(first, now).value.has_value());
  assert(stale_gate.accept(first, now).error == ProtocolError::StaleSequence);

  InputGate rate_gate;
  for (std::uint64_t sequence = 1; sequence <= 120; ++sequence) {
    const std::string message =
        "{\"type\":\"input\",\"sequence\":" + std::to_string(sequence) +
        ",\"clientTick\":" + std::to_string(sequence) +
        ",\"moveX\":0,\"moveZ\":0,\"jump\":false}";
    assert(rate_gate.accept(message, now).value.has_value());
  }
  const std::string excessive =
      R"({"type":"input","sequence":121,"clientTick":121,"moveX":0,"moveZ":0,"jump":false})";
  assert(rate_gate.accept(excessive, now).error == ProtocolError::RateLimited);

  const std::string next_window =
      R"({"type":"input","sequence":122,"clientTick":122,"moveX":0,"moveZ":0,"jump":false})";
  assert(rate_gate.accept(next_window, now + std::chrono::seconds(1)).value.has_value());
}

void roster_aware_server_messages_preserve_authoritative_state() {
  Snapshot snapshot;
  snapshot.tick = 180;
  snapshot.reset_count = 2;
  snapshot.tether_tension = 0.18f;
  snapshot.elapsed_ticks = 180;
  snapshot.checkpoint = 1;
  snapshot.match_state = linked_up::MatchState::Finished;
  snapshot.obstacles = {
      {"lift-1", linked_up::ObstacleKind::MovingPlatform, {0.0f, 3.0f, 0.0f},
       {0.0f, 0.0f, 0.0f}, {2.0f, 0.3f, 2.0f}, linked_up::Zone::Construction},
  };
  snapshot.players = {
      {RobotColor::Blue, {-1.0f, 1.0f, 2.0f}, {0.5f, 0.0f, 0.0f}, true},
      {RobotColor::Orange, {1.0f, 2.0f, -2.0f}, {0.0f, -1.0f, 0.25f}, false},
      {RobotColor::Green, {3.0f, 1.0f, 0.0f}, {0.0f, 0.0f, 1.0f}, true},
      {RobotColor::Purple, {-3.0f, 1.0f, 0.0f}, {0.0f, 0.0f, -1.0f}, false},
  };

  const auto message = crow::json::load(
      linked_up::serialize_snapshot(snapshot, {41, 73, 101, 151}));
  assert(message);
  assert(message["type"].s() == "snapshot");
  assert(message["tick"].u() == 180);
  assert(message["resetCount"].u() == 2);
  assert(std::abs(message["tetherTension"].d() - 0.18) < 0.001);
  assert(message["matchState"].s() == "finished");
  assert(message["elapsedTicks"].u() == 180);
  assert(message["checkpoint"].u() == 1);
  assert(message["obstacles"].size() == 1);
  assert(message["obstacles"][0]["id"].s() == "lift-1");
  assert(message["obstacles"][0]["kind"].s() == "movingPlatform");
  assert(message["obstacles"][0]["zone"].s() == "construction");
  assert(std::abs(message["obstacles"][0]["halfExtent"]["x"].d() - 2.0) < 0.001);
  assert(!message.has("separation"));
  assert(message["players"].size() == 4);
  assert(message["players"][0]["id"].s() == "blue");
  assert(message["players"][1]["id"].s() == "orange");
  assert(message["players"][2]["id"].s() == "green");
  assert(message["players"][3]["id"].s() == "purple");
  assert(message["players"][0]["acknowledgedInput"].u() == 41);
  assert(message["players"][1]["acknowledgedInput"].u() == 73);
  assert(message["players"][2]["acknowledgedInput"].u() == 101);
  assert(message["players"][3]["acknowledgedInput"].u() == 151);
  assert(std::abs(message["players"][0]["position"]["x"].d() + 1.0) < 0.001);
  assert(message["players"][0]["grounded"].b());
  assert(!message["players"][1]["grounded"].b());

  const auto welcome = crow::json::load(linked_up::serialize_welcome(
      RobotColor::Orange,
      {RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple},
      "windworks"));
  assert(welcome["type"].s() == "welcome");
  assert(welcome["player"].s() == "orange");
  assert(welcome["players"].size() == 4);
  assert(welcome["players"][0].s() == "blue");
  assert(welcome["players"][1].s() == "orange");
  assert(welcome["players"][2].s() == "green");
  assert(welcome["players"][3].s() == "purple");
  assert(welcome["mapId"].s() == "windworks");
  assert(welcome["tickRate"].u() == 60);
  assert(welcome["snapshotRate"].u() == 20);

  const auto error = crow::json::load(linked_up::serialize_error(ProtocolError::SlotTaken));
  assert(error["type"].s() == "error");
  assert(error["code"].s() == "slot_taken");

  const auto invalid_ticket = crow::json::load(linked_up::serialize_error(ProtocolError::InvalidTicket));
  assert(invalid_ticket["code"].s() == "invalid_ticket");
  assert(invalid_ticket["message"].s() == "Gameplay connection is not valid.");
}

void invalid_welcome_rosters_are_rejected() {
  for (const auto& roster : std::vector<std::vector<RobotColor>>{
           {RobotColor::Blue},
           {RobotColor::Blue, RobotColor::Blue},
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple,
            RobotColor::Blue}}) {
    bool rejected = false;
    try {
      static_cast<void>(linked_up::serialize_welcome(RobotColor::Blue, roster));
    } catch (const std::invalid_argument&) {
      rejected = true;
    }
    assert(rejected);
  }
}

}  // namespace

int main() {
  valid_input_is_decoded();
  malformed_and_out_of_range_input_is_rejected();
  stale_and_excessive_input_is_rejected();
  roster_aware_server_messages_preserve_authoritative_state();
  invalid_welcome_rosters_are_rejected();
  std::cout << "gameplay protocol checks passed\n";
}
