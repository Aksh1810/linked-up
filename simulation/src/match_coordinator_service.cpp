#include "linked_up/match_coordinator_service.hpp"

#include <chrono>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace linked_up {
namespace {

constexpr std::string_view kGameplayUrl = "ws://127.0.0.1:9002/game";
constexpr std::uint32_t kCountdownSeconds = 3;

RobotColor parse_color(std::string_view color) {
  if (color == "blue") return RobotColor::Blue;
  if (color == "orange") return RobotColor::Orange;
  if (color == "green") return RobotColor::Green;
  if (color == "purple") return RobotColor::Purple;
  throw std::invalid_argument("unknown player color");
}

std::int64_t unix_milliseconds(std::chrono::system_clock::time_point value) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(value.time_since_epoch()).count();
}

}  // namespace

MatchCoordinatorService::MatchCoordinatorService(MatchManager& matches) : matches_(matches) {}

grpc::Status MatchCoordinatorService::CreateMatch(
    grpc::ServerContext*, const linkedup::match::v1::CreateMatchRequest* request,
    linkedup::match::v1::CreateMatchResponse* response) {
  try {
    if (request == nullptr || response == nullptr ||
        request->capacity() != static_cast<std::uint32_t>(request->players_size())) {
      throw std::invalid_argument("capacity must match roster");
    }

    std::vector<MatchPlayer> players;
    players.reserve(static_cast<std::size_t>(request->players_size()));
    for (const auto& player : request->players()) {
      players.push_back({player.id(), player.name(), parse_color(player.color())});
    }

    const auto created = matches_.create(request->room_id(), std::move(players));
    const auto expires_unix_ms = unix_milliseconds(created.expires_at);
    response->set_match_id(created.match_id);
    response->set_gameplay_url(kGameplayUrl.data(), kGameplayUrl.size());
    response->set_countdown_seconds(kCountdownSeconds);
    response->set_expires_unix_ms(expires_unix_ms);
    for (const auto& launch : created.launches) {
      auto* mapped = response->add_launches();
      mapped->set_player_id(launch.player_id);
      mapped->set_color(color_name(launch.color));
      mapped->set_ticket(launch.ticket);
      mapped->set_expires_unix_ms(expires_unix_ms);
    }
    return grpc::Status::OK;
  } catch (const std::invalid_argument&) {
    return {grpc::StatusCode::INVALID_ARGUMENT, "invalid match request"};
  } catch (const std::runtime_error& error) {
    if (std::string_view(error.what()) == "match id collision") {
      return {grpc::StatusCode::ALREADY_EXISTS, "match already exists"};
    }
    return {grpc::StatusCode::INTERNAL, "match creation failed"};
  } catch (const std::exception&) {
    return {grpc::StatusCode::INTERNAL, "match creation failed"};
  }
}

grpc::Status MatchCoordinatorService::DestroyMatch(
    grpc::ServerContext*, const linkedup::match::v1::DestroyMatchRequest* request,
    linkedup::match::v1::DestroyMatchResponse* response) {
  if (request == nullptr || response == nullptr) {
    return {grpc::StatusCode::INVALID_ARGUMENT, "invalid destroy request"};
  }
  response->set_destroyed(matches_.destroy(request->match_id()));
  return grpc::Status::OK;
}

}  // namespace linked_up
