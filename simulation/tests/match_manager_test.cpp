#include "linked_up/match_manager.hpp"
#include "linked_up/match_coordinator_service.hpp"

#include <cassert>
#include <barrier>
#include <chrono>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

using linked_up::MatchManager;
using linked_up::MatchCoordinatorService;
using linked_up::MatchPlayer;
using linked_up::RobotColor;
using linkedup::match::v1::CreateMatchRequest;
using linkedup::match::v1::CreateMatchResponse;

struct FakeClock {
  std::chrono::system_clock::time_point value;
  std::function<std::chrono::system_clock::time_point()> now = [this] { return value; };

  template <typename Duration>
  void advance(Duration duration) {
    value += duration;
  }
};

struct MatchRequest {
  std::string room_id{"00000000-0000-4000-8000-000000000001"};
  std::vector<MatchPlayer> players;
};

MatchRequest request_for(const std::vector<RobotColor>& colors) {
  constexpr const char* ids[] = {
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004",
  };
  constexpr const char* names[] = {"Blue Robot", "Orange Robot", "Green Robot", "Purple Robot"};

  MatchRequest request;
  std::size_t index{};
  for (const auto color : colors) request.players.push_back({ids[index], names[index++], color});
  return request;
}

MatchRequest request_for(std::initializer_list<RobotColor> colors) {
  return request_for(std::vector<RobotColor>(colors));
}

CreateMatchRequest service_request_for(std::initializer_list<const char*> colors) {
  constexpr const char* ids[] = {
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004",
  };
  constexpr const char* names[] = {"Blue Robot", "Orange Robot", "Green Robot", "Purple Robot"};

  CreateMatchRequest request;
  request.set_room_id("00000000-0000-4000-8000-000000000001");
  request.set_capacity(static_cast<std::uint32_t>(colors.size()));
  request.set_map_id("classic-ascent");
  std::size_t index{};
  for (const auto color : colors) {
    auto* player = request.add_players();
    player->set_id(ids[index]);
    player->set_name(names[index++]);
    player->set_color(color);
  }
  return request;
}

CreateMatchResponse create_through_service(MatchCoordinatorService& service,
                                            const CreateMatchRequest& request) {
  grpc::ServerContext context;
  CreateMatchResponse response;
  const auto status = service.CreateMatch(&context, &request, &response);
  assert(status.ok());
  return response;
}

grpc::Status create_status(MatchCoordinatorService& service, const CreateMatchRequest& request) {
  grpc::ServerContext context;
  CreateMatchResponse response;
  return service.CreateMatch(&context, &request, &response);
}

void create_reply_carries_one_launch_for_each_requested_player() {
  MatchManager manager;
  MatchCoordinatorService service(manager);
  const auto reply = create_through_service(
      service, service_request_for({"blue", "orange", "green"}));
  assert(reply.match_id().size() == 36);
  assert(reply.gameplay_url() == "ws://127.0.0.1:9002/game");
  assert(reply.countdown_seconds() == 3);
  assert(reply.launches_size() == 3);
  assert(reply.expires_unix_ms() > 0);
  constexpr const char* ids[] = {
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
  };
  constexpr const char* colors[] = {"blue", "orange", "green"};
  for (int index = 0; index < reply.launches_size(); ++index) {
    assert(reply.launches(index).player_id() == ids[index]);
    assert(reply.launches(index).color() == colors[index]);
    assert(reply.launches(index).ticket().size() == 43);
    assert(reply.launches(index).expires_unix_ms() == reply.expires_unix_ms());
  }
}

void malformed_and_inconsistent_service_requests_are_invalid() {
  MatchManager manager;
  MatchCoordinatorService service(manager);

  auto malformed_room = service_request_for({"blue", "orange"});
  malformed_room.set_room_id("not-a-uuid");
  auto malformed_player = service_request_for({"blue", "orange"});
  malformed_player.mutable_players(0)->set_id("not-a-uuid");
  auto repeated_color = service_request_for({"blue", "blue"});
  auto mismatched_capacity = service_request_for({"blue", "orange"});
  mismatched_capacity.set_capacity(3);

  for (const auto* request :
       {&malformed_room, &malformed_player, &repeated_color, &mismatched_capacity}) {
    assert(create_status(service, *request).error_code() == grpc::StatusCode::INVALID_ARGUMENT);
  }
}

void destroy_service_is_idempotent() {
  MatchManager manager;
  MatchCoordinatorService service(manager);
  const auto created = create_through_service(service, service_request_for({"blue", "orange"}));

  linkedup::match::v1::DestroyMatchRequest request;
  request.set_match_id(created.match_id());
  grpc::ServerContext first_context;
  linkedup::match::v1::DestroyMatchResponse first_response;
  assert(service.DestroyMatch(&first_context, &request, &first_response).ok());
  assert(first_response.destroyed());

  grpc::ServerContext second_context;
  linkedup::match::v1::DestroyMatchResponse second_response;
  assert(service.DestroyMatch(&second_context, &request, &second_response).ok());
  assert(!second_response.destroyed());
}

void tickets_admit_only_the_assigned_player_once() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange});
  const auto created = manager.create(request.room_id, "relay-ridge", request.players);

  const auto first = manager.admit(created.match_id, created.launches[0].ticket);
  assert(first.has_value());
  assert(first->player_id == request.players[0].id);
  assert(first->map_id == "relay-ridge");
  assert((first->roster == std::vector<RobotColor>{RobotColor::Blue, RobotColor::Orange}));
  assert(!manager.admit(created.match_id, created.launches[0].ticket).has_value());
  assert(!manager.admit(created.match_id, created.launches[1].ticket + "x").has_value());
}

void expired_tickets_and_destroyed_matches_are_rejected() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange, RobotColor::Green});
  const auto created = manager.create(request.room_id, request.players);
  clock.advance(std::chrono::seconds(61));
  assert(!manager.admit(created.match_id, created.launches[0].ticket));
  assert(manager.destroy(created.match_id));
  assert(!manager.admit(created.match_id, created.launches[1].ticket));
}

void tickets_expire_at_the_exact_60_second_boundary() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange});
  const auto created = manager.create(request.room_id, request.players);
  clock.advance(std::chrono::seconds(60));
  assert(!manager.admit(created.match_id, created.launches[0].ticket));
}

void disconnect_neutralizes_input_but_does_not_restore_the_ticket() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange});
  const auto created = manager.create(request.room_id, request.players);
  const auto admission = manager.admit(created.match_id, created.launches[0].ticket);
  assert(admission.has_value());
  assert(manager.set_input(*admission, {1.0f, 0.0f, false}, 7));
  manager.disconnect(*admission);
  assert(!manager.set_input(*admission, {1.0f, 0.0f, false}, 8));

  const auto frames = manager.step_all();
  assert(frames.size() == 1);
  assert(frames[0].acknowledged_inputs[0] == 7);
  assert(frames[0].snapshot.players[0].velocity.x == 0.0f);
  assert(!manager.admit(created.match_id, created.launches[0].ticket));
}

void concurrent_admission_has_exactly_one_claimant() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange});
  const auto created = manager.create(request.room_id, request.players);
  std::barrier start(3);
  std::optional<linked_up::Admission> first;
  std::optional<linked_up::Admission> second;
  std::thread first_thread([&] {
    start.arrive_and_wait();
    first = manager.admit(created.match_id, created.launches[0].ticket);
  });
  std::thread second_thread([&] {
    start.arrive_and_wait();
    second = manager.admit(created.match_id, created.launches[0].ticket);
  });
  start.arrive_and_wait();
  first_thread.join();
  second_thread.join();
  assert(first.has_value() != second.has_value());
}

void creates_one_32_byte_ticket_for_each_player() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  for (const auto colors : std::vector<std::vector<RobotColor>>{
           {RobotColor::Blue, RobotColor::Orange},
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green},
           {RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple},
       }) {
    const auto request = request_for(colors);
    const auto created = manager.create(request.room_id, request.players);
    assert(created.launches.size() == request.players.size());
    assert(created.expires_at == clock.value + std::chrono::seconds(60));

    std::unordered_set<std::string> tickets;
    for (std::size_t index = 0; index < created.launches.size(); ++index) {
      assert(created.launches[index].player_id == request.players[index].id);
      assert(created.launches[index].color == request.players[index].color);
      assert(created.launches[index].ticket.size() == 43);  // 32 bytes as unpadded base64url.
      assert(created.launches[index].ticket.find('=') == std::string::npos);
      tickets.insert(created.launches[index].ticket);
    }
    assert(tickets.size() == created.launches.size());
  }
}

void active_matches_keep_rosters_and_input_acknowledgements_isolated() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  const auto first_request = request_for({RobotColor::Blue, RobotColor::Orange});
  const auto second_request = request_for({RobotColor::Blue, RobotColor::Orange, RobotColor::Green});
  const auto first = manager.create(first_request.room_id, first_request.players);
  const auto second = manager.create(second_request.room_id, second_request.players);

  const auto first_admission = manager.admit(first.match_id, first.launches[0].ticket);
  const auto second_admission = manager.admit(second.match_id, second.launches[2].ticket);
  assert(first_admission.has_value());
  assert(second_admission.has_value());
  assert(manager.set_input(*first_admission, {1.0f, 0.0f, false}, 7));
  assert(manager.set_input(*second_admission, {0.0f, 1.0f, false}, 99));

  const auto frames = manager.step_all();
  assert(frames.size() == 2);
  for (const auto& frame : frames) {
    if (frame.match_id == first.match_id) {
      assert(frame.snapshot.players.size() == 2);
      assert((frame.acknowledged_inputs == std::vector<std::uint64_t>{7, 0}));
    } else {
      assert(frame.match_id == second.match_id);
      assert(frame.snapshot.players.size() == 3);
      assert((frame.acknowledged_inputs == std::vector<std::uint64_t>{0, 0, 99}));
    }
  }
}

void invalid_match_requests_are_rejected() {
  FakeClock clock{std::chrono::system_clock::time_point{}};
  MatchManager manager(clock.now);
  auto invalid_id = request_for({RobotColor::Blue, RobotColor::Orange});
  invalid_id.room_id = "not-a-uuid";
  auto empty_name = request_for({RobotColor::Blue, RobotColor::Orange});
  empty_name.players[0].name.clear();
  auto invalid_player_id = request_for({RobotColor::Blue, RobotColor::Orange});
  invalid_player_id.players[0].id = "not-a-uuid";
  for (auto request : std::vector<MatchRequest>{
           request_for({RobotColor::Blue}),
           request_for({RobotColor::Blue, RobotColor::Blue}),
           request_for({RobotColor::Blue, RobotColor::Orange, RobotColor::Green, RobotColor::Purple}),
           std::move(invalid_id),
           std::move(empty_name),
           std::move(invalid_player_id),
       }) {
    if (request.players.size() == 4) request.players.push_back(request.players.back());
    bool rejected = false;
    try {
      static_cast<void>(manager.create(request.room_id, request.players));
    } catch (const std::invalid_argument&) {
      rejected = true;
    }
    assert(rejected);
  }
}

void unknown_map_ids_are_rejected() {
  MatchManager manager;
  const auto request = request_for({RobotColor::Blue, RobotColor::Orange});
  bool rejected = false;
  try {
    static_cast<void>(manager.create(request.room_id, "unknown", request.players));
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  assert(rejected);

  MatchCoordinatorService service(manager);
  auto service_request = service_request_for({"blue", "orange"});
  service_request.set_map_id("unknown");
  assert(create_status(service, service_request).error_code() == grpc::StatusCode::INVALID_ARGUMENT);
}

}  // namespace

int main() {
  create_reply_carries_one_launch_for_each_requested_player();
  malformed_and_inconsistent_service_requests_are_invalid();
  destroy_service_is_idempotent();
  tickets_admit_only_the_assigned_player_once();
  expired_tickets_and_destroyed_matches_are_rejected();
  tickets_expire_at_the_exact_60_second_boundary();
  disconnect_neutralizes_input_but_does_not_restore_the_ticket();
  concurrent_admission_has_exactly_one_claimant();
  creates_one_32_byte_ticket_for_each_player();
  active_matches_keep_rosters_and_input_acknowledgements_isolated();
  invalid_match_requests_are_rejected();
  unknown_map_ids_are_rejected();
  std::cout << "match manager checks passed\n";
}
