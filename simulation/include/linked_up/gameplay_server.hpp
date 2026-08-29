#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

namespace linked_up {

struct GameplayServerConfig {
  std::uint16_t port{9002};
  std::size_t max_payload_bytes{512};
  std::uint32_t snapshot_every_ticks{3};
};

class GameplayServer {
 public:
  explicit GameplayServer(GameplayServerConfig config = {});
  ~GameplayServer();

  GameplayServer(const GameplayServer&) = delete;
  GameplayServer& operator=(const GameplayServer&) = delete;

  void run();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace linked_up
