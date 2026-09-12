#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "linked_up/prototype_simulation.hpp"

namespace linked_up {

enum class ProtocolError {
  None,
  Malformed,
  OutOfRange,
  StaleSequence,
  RateLimited,
  InvalidPlayer,
  SlotTaken,
  InvalidTicket,
  BinaryMessage,
};

struct SequencedInput {
  std::uint64_t sequence{};
  std::uint64_t client_tick{};
  PlayerInput input;
};

struct InputResult {
  std::optional<SequencedInput> value;
  ProtocolError error{ProtocolError::None};
};

class InputGate {
 public:
  using Clock = std::chrono::steady_clock;

  InputResult accept(std::string_view message, Clock::time_point now);

 private:
  std::uint64_t last_sequence_{};
  Clock::time_point window_start_{};
  std::size_t messages_in_window_{};
};

std::string serialize_welcome(
    RobotColor player, const std::vector<RobotColor>& roster, std::string_view map_id);
std::string serialize_welcome(RobotColor player, const std::vector<RobotColor>& roster);
std::string serialize_welcome(RobotColor player);
std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::vector<std::uint64_t>& acknowledged_inputs);
std::string serialize_snapshot(
    const Snapshot& snapshot,
    const std::array<std::uint64_t, 2>& acknowledged_inputs);
std::string serialize_error(ProtocolError error);

}  // namespace linked_up
