#define CROW_ENFORCE_WS_SPEC
#include <crow.h>

#include "linked_up/gameplay_server.hpp"

#include <array>
#include <chrono>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "linked_up/gameplay_protocol.hpp"
#include "linked_up/match_coordinator_service.hpp"

namespace linked_up {
namespace {

constexpr auto kTickDuration = std::chrono::nanoseconds{1'000'000'000 / 60};
constexpr std::uint16_t kPolicyViolation = 1008;

bool is_loopback(std::string_view address) {
  return address == "127.0.0.1" || address == "::1" || address == "localhost";
}

struct PendingAdmission {
  std::string match_id;
  std::string ticket;
};

struct PendingConnection {
  std::optional<PendingAdmission> admission;
  std::string dev_player;
  bool invalid{};
};

struct Session {
  Admission admission;
  InputGate input_gate;
};

constexpr std::array<RobotColor, 2> kDevColors{RobotColor::Blue, RobotColor::Orange};
constexpr std::array<std::string_view, 2> kDevNames{"blue", "orange"};
constexpr std::string_view kDevRoomId = "00000000-0000-4000-8000-000000000001";
constexpr std::array<std::string_view, 2> kDevPlayerIds{
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
};

std::optional<std::size_t> dev_player_index(std::string_view player) {
  for (std::size_t index = 0; index < kDevNames.size(); ++index) {
    if (player == kDevNames[index]) return index;
  }
  return std::nullopt;
}

}  // namespace

class GameplayServer::Impl {
 public:
  explicit Impl(GameplayServerConfig config) : config_(config) {
    if (config_.port == 0 || config_.coordination_port == 0 || config_.bind_address.empty() ||
        config_.max_payload_bytes == 0 ||
        config_.snapshot_every_ticks == 0) {
      throw std::invalid_argument("invalid gameplay server configuration");
    }

    if (is_loopback(config_.bind_address)) create_dev_match();
    // Crow's info log includes request URLs and query strings.
    app_.loglevel(crow::LogLevel::Warning);

    CROW_ROUTE(app_, "/health")
    ([] {
      crow::response response{R"({"status":"ok"})"};
      response.set_header("Content-Type", "application/json");
      return response;
    });

    CROW_WEBSOCKET_ROUTE(app_, "/game")
        .onaccept([this](const crow::request& request, void** userdata) {
          auto pending = std::make_unique<PendingConnection>();
          const char* match_id = request.url_params.get("match");
          const char* ticket = request.url_params.get("ticket");
          if (match_id != nullptr || ticket != nullptr) {
            if (match_id == nullptr || ticket == nullptr) {
              pending->invalid = true;
            } else {
              pending->admission = PendingAdmission{match_id, ticket};
            }
          } else if (dev_match_id_.has_value()) {
            if (const char* player = request.url_params.get("player")) pending->dev_player = player;
          } else {
            pending->invalid = true;
          }
          *userdata = pending.release();
          return true;
        })
        .onopen([this](crow::websocket::connection& connection) { open(connection); })
        .onmessage([this](crow::websocket::connection& connection, const std::string& message,
                          bool binary) { receive(connection, message, binary); })
        .onclose([this](crow::websocket::connection& connection, const std::string&,
                        std::uint16_t) { disconnect(connection); })
        .onerror([this](crow::websocket::connection& connection, const std::string&) {
          std::cerr << "gameplay connection error\n";
          disconnect(connection);
        });
  }

  ~Impl() {
    app_.stop();
    simulation_thread_.request_stop();
    if (simulation_thread_.joinable()) simulation_thread_.join();
    if (coordinator_server_) coordinator_server_->Shutdown();
    if (coordinator_thread_.joinable()) coordinator_thread_.join();
  }

  void run() {
    start_coordinator();
    simulation_thread_ = std::jthread([this](std::stop_token stop) { simulate(stop); });
    app_.bindaddr(config_.bind_address)
        .port(config_.port)
        .websocket_max_payload(config_.max_payload_bytes)
        .concurrency(2)
        .run();
  }

 private:
  void create_dev_match() {
    std::vector<MatchPlayer> players;
    players.reserve(kDevColors.size());
    for (std::size_t index = 0; index < kDevColors.size(); ++index) {
      players.push_back(
          {std::string(kDevPlayerIds[index]), std::string(kDevNames[index]), kDevColors[index]});
    }
    const auto created = matches_.create(std::string(kDevRoomId), std::move(players));
    dev_match_id_ = created.match_id;
    for (std::size_t index = 0; index < created.launches.size(); ++index) {
      dev_tickets_[index] = created.launches[index].ticket;
    }
  }

  void start_coordinator() {
    if (coordinator_server_) return;
    grpc::ServerBuilder builder;
    int selected_port{};
    builder.AddListeningPort("127.0.0.1:" + std::to_string(config_.coordination_port),
                             grpc::InsecureServerCredentials(), &selected_port);
    builder.RegisterService(&coordinator_service_);
    coordinator_server_ = builder.BuildAndStart();
    if (!coordinator_server_ || selected_port != config_.coordination_port) {
      throw std::runtime_error("could not start match coordinator");
    }
    coordinator_thread_ = std::jthread([this] { coordinator_server_->Wait(); });
  }

  void open(crow::websocket::connection& connection) {
    std::unique_ptr<PendingConnection> pending(
        static_cast<PendingConnection*>(connection.userdata()));
    connection.userdata(nullptr);

    if (!pending || pending->invalid) {
      reject(connection, ProtocolError::InvalidTicket);
      return;
    }

    std::optional<Admission> admission;
    if (pending->admission) {
      admission = matches_.admit(pending->admission->match_id, pending->admission->ticket);
      pending->admission->ticket.clear();
    } else {
      const auto index = dev_player_index(pending->dev_player);
      if (!index) {
        reject(connection, ProtocolError::InvalidPlayer);
        return;
      }
      bool occupied = false;
      {
        std::lock_guard lock(mutex_);
        occupied = dev_active_[*index];
      }
      if (occupied) {
        reject(connection, ProtocolError::SlotTaken);
        return;
      }
      admission = matches_.admit(*dev_match_id_, dev_tickets_[*index]);
      if (admission) {
        std::lock_guard lock(mutex_);
        dev_active_[*index] = true;
      }
    }
    if (!admission) {
      reject(connection, ProtocolError::InvalidTicket);
      return;
    }

    const auto color = admission->color;
    const auto roster = admission->roster;
    const auto map_id = admission->map_id;
    {
      std::lock_guard lock(mutex_);
      sessions_.emplace(&connection, Session{.admission = std::move(*admission)});
    }
    connection.send_text(serialize_welcome(color, roster, map_id));
  }

  void receive(crow::websocket::connection& connection, const std::string& message,
               bool binary) {
    if (binary) {
      reject(connection, ProtocolError::BinaryMessage);
      return;
    }

    ProtocolError error = ProtocolError::None;
    std::optional<Admission> admission;
    std::optional<SequencedInput> input;
    {
      std::lock_guard lock(mutex_);
      const auto session = sessions_.find(&connection);
      if (session == sessions_.end() || pending_rejections_.contains(&connection)) return;

      const InputResult result =
          session->second.input_gate.accept(message, InputGate::Clock::now());
      if (result.value) {
        admission = session->second.admission;
        input = *result.value;
      } else {
        error = result.error;
      }
    }
    if (input && !matches_.set_input(*admission, input->input, input->sequence)) {
      reject(connection, ProtocolError::InvalidTicket);
      return;
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
    std::optional<Admission> admission;
    {
      std::lock_guard lock(mutex_);
      pending_rejections_.erase(&connection);
      const auto session = sessions_.find(&connection);
      if (session == sessions_.end()) return;
      admission = std::move(session->second.admission);
      if (dev_match_id_ && admission->match_id == *dev_match_id_) {
        if (const auto index = dev_player_index(color_name(admission->color))) {
          dev_active_[*index] = false;
        }
      }
      sessions_.erase(session);
    }
    matches_.disconnect(*admission);
  }

  void simulate(std::stop_token stop) {
    auto next_tick = std::chrono::steady_clock::now();
    while (!stop.stop_requested()) {
      next_tick += kTickDuration;
      {
        std::lock_guard lock(mutex_);
        for (auto* connection : pending_rejections_) {
          connection->close("policy violation", kPolicyViolation);
        }
        pending_rejections_.clear();
      }

      for (const auto& frame : matches_.step_all()) {
        if (frame.snapshot.tick % config_.snapshot_every_ticks != 0) continue;
        const std::string message = serialize_snapshot(frame.snapshot, frame.acknowledged_inputs);
        std::lock_guard lock(mutex_);
        for (const auto& [connection, session] : sessions_) {
          if (session.admission.match_id == frame.match_id) connection->send_text(message);
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
  MatchManager matches_;
  MatchCoordinatorService coordinator_service_{matches_};
  std::unique_ptr<grpc::Server> coordinator_server_;
  std::jthread coordinator_thread_;
  std::optional<std::string> dev_match_id_;
  std::array<std::string, 2> dev_tickets_;
  // ponytail: one lock covers local sessions; split it per match if contention matters.
  std::mutex mutex_;
  std::array<bool, 2> dev_active_{};
  std::unordered_map<crow::websocket::connection*, Session> sessions_;
  std::unordered_set<crow::websocket::connection*> pending_rejections_;
  std::jthread simulation_thread_;
};

GameplayServer::GameplayServer(GameplayServerConfig config)
    : impl_(std::make_unique<Impl>(config)) {}

GameplayServer::~GameplayServer() = default;

void GameplayServer::run() { impl_->run(); }

}  // namespace linked_up
