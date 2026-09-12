#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "linked_up/prototype_simulation.hpp"

namespace linked_up {

struct MatchPlayer {
  std::string id;
  std::string name;
  RobotColor color;
};

struct PlayerLaunch {
  std::string player_id;
  RobotColor color;
  std::string ticket;
};

struct CreateMatchResult {
  std::string match_id;
  std::vector<PlayerLaunch> launches;
  std::chrono::system_clock::time_point expires_at;
};

struct Admission {
  std::string match_id;
  std::string player_id;
  RobotColor color;
  std::string map_id;
  std::vector<RobotColor> roster;
};

struct MatchFrame {
  std::string match_id;
  Snapshot snapshot;
  std::vector<std::uint64_t> acknowledged_inputs;
};

class MatchManager {
 public:
  using Now = std::function<std::chrono::system_clock::time_point()>;

  explicit MatchManager(Now now = std::chrono::system_clock::now);
  ~MatchManager();

  MatchManager(const MatchManager&) = delete;
  MatchManager& operator=(const MatchManager&) = delete;

  CreateMatchResult create(
      std::string room_id, std::string map_id, std::vector<MatchPlayer> players);
  CreateMatchResult create(std::string room_id, std::vector<MatchPlayer> players) {
    return create(std::move(room_id), "classic-ascent", std::move(players));
  }
  std::optional<Admission> admit(std::string_view match_id, std::string_view ticket);
  bool set_input(const Admission& admission, PlayerInput input, std::uint64_t sequence);
  void disconnect(const Admission& admission);
  [[nodiscard]] std::vector<MatchFrame> step_all();
  bool destroy(std::string_view match_id);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace linked_up
