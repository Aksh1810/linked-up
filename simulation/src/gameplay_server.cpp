#define CROW_ENFORCE_WS_SPEC
#include <crow.h>

#include "linked_up/gameplay_server.hpp"

#include <array>
#include <chrono>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#include "linked_up/gameplay_protocol.hpp"
#include "linked_up/prototype_simulation.hpp"

namespace linked_up {
namespace {

constexpr auto kTickDuration = std::chrono::nanoseconds{1'000'000'000 / 60};
constexpr std::uint16_t kPolicyViolation = 1008;

std::size_t player_index(PlayerId player) { return static_cast<std::size_t>(player); }

struct PendingPlayer {
  std::string name;
};

struct Session {
  PlayerId player{};
  InputGate input_gate;
};

struct LatestInput {
  PlayerInput input;
  std::uint64_t sequence{};
};

}  // namespace

class GameplayServer::Impl {
 public:
  explicit Impl(GameplayServerConfig config) : config_(config) {
    if (config_.port == 0 || config_.max_payload_bytes == 0 ||
        config_.snapshot_every_ticks == 0) {
      throw std::invalid_argument("invalid gameplay server configuration");
    }

    CROW_ROUTE(app_, "/health")
    ([] {
      crow::response response{R"({"status":"ok"})"};
      response.set_header("Content-Type", "application/json");
      return response;
    });

    CROW_WEBSOCKET_ROUTE(app_, "/game")
        .onaccept([](const crow::request& request, void** userdata) {
          const char* requested = request.url_params.get("player");
          *userdata = new PendingPlayer{requested == nullptr ? "" : requested};
          return true;
        })
        .onopen([this](crow::websocket::connection& connection) { open(connection); })
        .onmessage([this](crow::websocket::connection& connection, const std::string& message,
                          bool binary) { receive(connection, message, binary); })
        .onclose([this](crow::websocket::connection& connection, const std::string&,
                        std::uint16_t) { disconnect(connection); })
        .onerror([this](crow::websocket::connection& connection, const std::string& error) {
          std::cerr << "gameplay connection error: " << error << '\n';
          disconnect(connection);
        });
  }

  ~Impl() {
    app_.stop();
    simulation_thread_.request_stop();
    if (simulation_thread_.joinable()) simulation_thread_.join();
  }

  void run() {
    simulation_thread_ = std::jthread([this](std::stop_token stop) { simulate(stop); });
    app_.bindaddr("127.0.0.1")
        .port(config_.port)
        .websocket_max_payload(config_.max_payload_bytes)
        .concurrency(2)
        .run();
  }

 private:
  void open(crow::websocket::connection& connection) {
    std::unique_ptr<PendingPlayer> pending(static_cast<PendingPlayer*>(connection.userdata()));
    connection.userdata(nullptr);

    PlayerId player;
    if (pending->name == "blue") {
      player = PlayerId::Blue;
    } else if (pending->name == "orange") {
      player = PlayerId::Orange;
    } else {
      reject(connection, ProtocolError::InvalidPlayer);
      return;
    }

    bool occupied = false;
    {
      std::lock_guard lock(mutex_);
      auto& slot = slots_[player_index(player)];
      if (slot != nullptr) {
        occupied = true;
      } else {
        slot = &connection;
        sessions_.emplace(&connection, Session{.player = player});
      }
    }
    if (occupied) {
      reject(connection, ProtocolError::SlotTaken);
      return;
    }
    std::cout << (player == PlayerId::Blue ? "Blue" : "Orange") << " player connected\n";
    connection.send_text(serialize_welcome(player));
  }

  void receive(crow::websocket::connection& connection, const std::string& message,
               bool binary) {
    if (binary) {
      reject(connection, ProtocolError::BinaryMessage);
      return;
    }

    ProtocolError error = ProtocolError::None;
    {
      std::lock_guard lock(mutex_);
      const auto session = sessions_.find(&connection);
      if (session == sessions_.end() || pending_rejections_.contains(&connection)) return;

      const InputResult result =
          session->second.input_gate.accept(message, InputGate::Clock::now());
      if (result.value) {
        latest_inputs_[player_index(session->second.player)] = {
            .input = result.value->input,
            .sequence = result.value->sequence,
        };
      } else {
        error = result.error;
      }
    }
    if (error != ProtocolError::None) reject(connection, error);
  }

  void reject(crow::websocket::connection& connection, ProtocolError error) {
    std::cerr << "gameplay client rejected with protocol error " << static_cast<int>(error) << '\n';
    connection.send_text(serialize_error(error));
    // Crow posts text frames but dispatches closes; defer the close one simulation tick
    // so the client receives the useful policy error first.
    std::lock_guard lock(mutex_);
    pending_rejections_.insert(&connection);
  }

  void disconnect(crow::websocket::connection& connection) {
    std::lock_guard lock(mutex_);
    pending_rejections_.erase(&connection);
    const auto session = sessions_.find(&connection);
    if (session == sessions_.end()) return;

    const std::size_t index = player_index(session->second.player);
    std::cout << (session->second.player == PlayerId::Blue ? "Blue" : "Orange")
              << " player disconnected\n";
    latest_inputs_[index] = {};
    slots_[index] = nullptr;
    sessions_.erase(session);
  }

  void simulate(std::stop_token stop) {
    auto next_tick = std::chrono::steady_clock::now();
    while (!stop.stop_requested()) {
      next_tick += kTickDuration;
      std::array<LatestInput, 2> inputs;
      {
        std::lock_guard lock(mutex_);
        inputs = latest_inputs_;
        for (auto* connection : pending_rejections_) {
          connection->close("policy violation", kPolicyViolation);
        }
        pending_rejections_.clear();
      }

      simulation_.set_input(PlayerId::Blue, inputs[0].input);
      simulation_.set_input(PlayerId::Orange, inputs[1].input);
      simulation_.step();
      const Snapshot snapshot = simulation_.snapshot();

      if (snapshot.tick % config_.snapshot_every_ticks == 0) {
        const std::array<std::uint64_t, 2> applied{
            inputs[0].sequence,
            inputs[1].sequence,
        };
        const std::string message = serialize_snapshot(snapshot, applied);
        std::lock_guard lock(mutex_);
        for (const auto& [connection, session] : sessions_) {
          static_cast<void>(session);
          connection->send_text(message);
        }
      }

      const auto now = std::chrono::steady_clock::now();
      if (now > next_tick + kTickDuration) {
        std::cerr << "simulation tick overrun\n";
        next_tick = now + kTickDuration;
      }
      std::this_thread::sleep_until(next_tick);
    }
  }

  GameplayServerConfig config_;
  crow::SimpleApp app_;
  PrototypeSimulation simulation_;
  // ponytail: one lock covers two development slots; split it only for multi-match contention.
  std::mutex mutex_;
  std::array<LatestInput, 2> latest_inputs_{};
  std::array<crow::websocket::connection*, 2> slots_{};
  std::unordered_map<crow::websocket::connection*, Session> sessions_;
  std::unordered_set<crow::websocket::connection*> pending_rejections_;
  std::jthread simulation_thread_;
};

GameplayServer::GameplayServer(GameplayServerConfig config) : impl_(std::make_unique<Impl>(config)) {}

GameplayServer::~GameplayServer() = default;

void GameplayServer::run() { impl_->run(); }

}  // namespace linked_up
