#include "linked_up/gameplay_protocol.hpp"

#include <crow/json.h>

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

const char* player_name(PlayerId player) {
  switch (player) {
    case PlayerId::Blue:
      return "blue";
    case PlayerId::Orange:
      return "orange";
  }
  throw std::invalid_argument("unknown player id");
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

std::string serialize_welcome(PlayerId player) {
  crow::json::wvalue message;
  message["type"] = "welcome";
  message["player"] = player_name(player);
  message["tickRate"] = 60;
  message["snapshotRate"] = 20;
  return message.dump();
}

std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::array<std::uint64_t, 2>& acknowledged_inputs) {
  crow::json::wvalue message;
  message["type"] = "snapshot";
  message["tick"] = snapshot.tick;
  message["resetCount"] = snapshot.reset_count;
  message["separation"] = snapshot.separation;
  message["tetherTension"] = snapshot.tether_tension;

  for (unsigned index = 0; index < snapshot.players.size(); ++index) {
    auto& player = message["players"][index];
    player["id"] = player_name(static_cast<PlayerId>(index));
    player["acknowledgedInput"] = acknowledged_inputs[index];
    write_vector(player["position"], snapshot.players[index].position);
    write_vector(player["velocity"], snapshot.players[index].velocity);
    player["grounded"] = snapshot.players[index].grounded;
  }
  return message.dump();
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
