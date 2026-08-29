#include "linked_up/gameplay_protocol.hpp"

#include <crow/json.h>

#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

namespace {

using linked_up::InputGate;
using linked_up::PlayerId;
using linked_up::ProtocolError;
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

void server_messages_preserve_authoritative_state() {
  Snapshot snapshot;
  snapshot.tick = 180;
  snapshot.reset_count = 2;
  snapshot.separation = 3.25f;
  snapshot.tether_tension = 0.18f;
  snapshot.players[0] = {{-1.0f, 1.0f, 2.0f}, {0.5f, 0.0f, 0.0f}, true};
  snapshot.players[1] = {{1.0f, 2.0f, -2.0f}, {0.0f, -1.0f, 0.25f}, false};

  const auto message = crow::json::load(
      linked_up::serialize_snapshot(snapshot, std::array<std::uint64_t, 2>{41, 73}));
  assert(message);
  assert(message["type"].s() == "snapshot");
  assert(message["tick"].u() == 180);
  assert(message["resetCount"].u() == 2);
  assert(std::abs(message["separation"].d() - 3.25) < 0.001);
  assert(std::abs(message["tetherTension"].d() - 0.18) < 0.001);
  assert(message["players"].size() == 2);
  assert(message["players"][0]["id"].s() == "blue");
  assert(message["players"][1]["id"].s() == "orange");
  assert(message["players"][0]["acknowledgedInput"].u() == 41);
  assert(message["players"][1]["acknowledgedInput"].u() == 73);
  assert(std::abs(message["players"][0]["position"]["x"].d() + 1.0) < 0.001);
  assert(message["players"][0]["grounded"].b());
  assert(!message["players"][1]["grounded"].b());

  const auto welcome = crow::json::load(linked_up::serialize_welcome(PlayerId::Orange));
  assert(welcome["type"].s() == "welcome");
  assert(welcome["player"].s() == "orange");
  assert(welcome["tickRate"].u() == 60);
  assert(welcome["snapshotRate"].u() == 20);

  const auto error = crow::json::load(linked_up::serialize_error(ProtocolError::SlotTaken));
  assert(error["type"].s() == "error");
  assert(error["code"].s() == "slot_taken");
}

}  // namespace

int main() {
  valid_input_is_decoded();
  malformed_and_out_of_range_input_is_rejected();
  stale_and_excessive_input_is_rejected();
  server_messages_preserve_authoritative_state();
  std::cout << "gameplay protocol checks passed\n";
}
