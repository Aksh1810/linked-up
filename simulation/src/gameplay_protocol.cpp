#include "linked_up/gameplay_protocol.hpp"

#include <crow/json.h>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <utility>

namespace linked_up {
namespace {

constexpr std::size_t kMaxMessagesPerSecond = 120;

bool unsigned_integer(const crow::json::rvalue& value) {
  return value.t() == crow::json::type::Number &&
         value.nt() == crow::json::num_type::Unsigned_integer;
}

bool number(const crow::json::rvalue& value) {
  return value.t() == crow::json::type::Number;
}

bool boolean(const crow::json::rvalue& value) {
  return value.t() == crow::json::type::True || value.t() == crow::json::type::False;
}

void validate_roster(const std::vector<RobotColor>& roster) {
  if (roster.size() < 2 || roster.size() > 4) {
    throw std::invalid_argument("roster must contain two to four unique colors");
  }
  for (std::size_t index = 0; index < roster.size(); ++index) {
    static_cast<void>(color_name(roster[index]));
    if (std::find(roster.begin(), roster.begin() + static_cast<std::ptrdiff_t>(index), roster[index]) !=
        roster.begin() + static_cast<std::ptrdiff_t>(index)) {
      throw std::invalid_argument("roster must contain two to four unique colors");
    }
  }
}

std::pair<const char*, const char*> error_details(ProtocolError error) {
  switch (error) {
    case ProtocolError::Malformed:
      return {"malformed_input", "Input message is invalid."};
    case ProtocolError::OutOfRange:
      return {"input_out_of_range", "Movement input is out of range."};
    case ProtocolError::StaleSequence:
      return {"stale_input", "Input sequence is stale."};
    case ProtocolError::RateLimited:
      return {"input_rate_exceeded", "Input rate is too high."};
    case ProtocolError::InvalidPlayer:
      return {"invalid_player", "Choose Blue or Orange."};
    case ProtocolError::SlotTaken:
      return {"slot_taken", "That player is already connected."};
    case ProtocolError::InvalidTicket:
      return {"invalid_ticket", "Gameplay connection is not valid."};
    case ProtocolError::BinaryMessage:
      return {"binary_message", "Gameplay messages must be JSON text."};
    case ProtocolError::None:
      return {"unknown_error", "Gameplay connection failed."};
  }
  return {"unknown_error", "Gameplay connection failed."};
}

void write_vector(crow::json::wvalue& target, Vec3 value) {
  target["x"] = value.x;
  target["y"] = value.y;
  target["z"] = value.z;
}

}  // namespace

InputResult InputGate::accept(std::string_view message, Clock::time_point now) {
  if (messages_in_window_ > 0 && now - window_start_ >= std::chrono::seconds(1)) {
    messages_in_window_ = 0;
  }
  if (messages_in_window_ == 0) window_start_ = now;
  if (messages_in_window_ >= kMaxMessagesPerSecond) {
    return {.error = ProtocolError::RateLimited};
  }
  ++messages_in_window_;

  try {
    const auto body = crow::json::load(message.data(), message.size());
    if (!body || body.t() != crow::json::type::Object || !body.has("type") ||
        !body.has("sequence") || !body.has("clientTick") || !body.has("moveX") ||
        !body.has("moveZ") || !body.has("jump") ||
        body["type"].t() != crow::json::type::String ||
        std::string(body["type"].s()) != "input" || !unsigned_integer(body["sequence"]) ||
        !unsigned_integer(body["clientTick"]) || !number(body["moveX"]) ||
        !number(body["moveZ"]) || !boolean(body["jump"])) {
      return {.error = ProtocolError::Malformed};
    }

    const auto sequence = body["sequence"].u();
    const double move_x = body["moveX"].d();
    const double move_z = body["moveZ"].d();
    if (!std::isfinite(move_x) || !std::isfinite(move_z) || std::abs(move_x) > 1.0 ||
        std::abs(move_z) > 1.0) {
      return {.error = ProtocolError::OutOfRange};
    }
    if (sequence <= last_sequence_) return {.error = ProtocolError::StaleSequence};

    last_sequence_ = sequence;
    return {
        .value = SequencedInput{
            .sequence = sequence,
            .client_tick = body["clientTick"].u(),
            .input = {static_cast<float>(move_x), static_cast<float>(move_z), body["jump"].b()},
        },
    };
  } catch (const std::exception&) {
    return {.error = ProtocolError::Malformed};
  }
}

std::string serialize_welcome(RobotColor player, const std::vector<RobotColor>& roster) {
  validate_roster(roster);
  if (std::find(roster.begin(), roster.end(), player) == roster.end()) {
    throw std::invalid_argument("welcome player is not in the roster");
  }
  crow::json::wvalue message;
  message["type"] = "welcome";
  message["player"] = color_name(player);
  for (std::size_t index = 0; index < roster.size(); ++index) {
    message["players"][index] = color_name(roster[index]);
  }
  message["tickRate"] = 60;
  message["snapshotRate"] = 20;
  return message.dump();
}

std::string serialize_welcome(RobotColor player) {
  return serialize_welcome(player, {RobotColor::Blue, RobotColor::Orange});
}

std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::vector<std::uint64_t>& acknowledged_inputs) {
  if (snapshot.players.size() != acknowledged_inputs.size()) {
    throw std::invalid_argument("acknowledged inputs must match snapshot players");
  }
  crow::json::wvalue message;
  message["type"] = "snapshot";
  message["tick"] = snapshot.tick;
  message["resetCount"] = snapshot.reset_count;
  message["tetherTension"] = snapshot.tether_tension;

  for (std::size_t index = 0; index < snapshot.players.size(); ++index) {
    auto& player = message["players"][index];
    player["id"] = color_name(snapshot.players[index].id);
    player["acknowledgedInput"] = acknowledged_inputs[index];
    write_vector(player["position"], snapshot.players[index].position);
    write_vector(player["velocity"], snapshot.players[index].velocity);
    player["grounded"] = snapshot.players[index].grounded;
  }
  return message.dump();
}

std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::array<std::uint64_t, 2>& acknowledged_inputs) {
  return serialize_snapshot(snapshot,
                            std::vector<std::uint64_t>(acknowledged_inputs.begin(),
                                                       acknowledged_inputs.end()));
}

std::string serialize_error(ProtocolError error) {
  const auto [code, text] = error_details(error);
  crow::json::wvalue message;
  message["type"] = "error";
  message["code"] = code;
  message["message"] = text;
  return message.dump();
}

}  // namespace linked_up
