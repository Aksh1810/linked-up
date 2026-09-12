#include "linked_up/match_manager.hpp"

#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <array>
#include <cctype>
#include <cstddef>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace linked_up {
namespace {

constexpr auto kTicketLifetime = std::chrono::seconds(60);
constexpr std::size_t kTicketBytes = 32;

bool is_uuid(std::string_view value) {
  if (value.size() != 36) return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
    } else if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
      return false;
    }
  }
  return true;
}

void validate_players(std::string_view room_id, const std::vector<MatchPlayer>& players) {
  if (!is_uuid(room_id)) throw std::invalid_argument("room id must be a UUID");
  if (players.size() < 2 || players.size() > 4) {
    throw std::invalid_argument("match must have two to four players");
  }
  for (std::size_t index = 0; index < players.size(); ++index) {
    if (!is_uuid(players[index].id) || players[index].name.empty() ||
        players[index].color != static_cast<RobotColor>(index)) {
      throw std::invalid_argument("players must have UUIDs, names, and ordered unique colors");
    }
  }
}

template <std::size_t Size>
std::array<unsigned char, Size> random_bytes() {
  std::array<unsigned char, Size> bytes;
  if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
    throw std::runtime_error("secure ticket generation failed");
  }
  return bytes;
}

std::string base64url(const std::array<unsigned char, kTicketBytes>& bytes) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string result;
  result.reserve(43);
  std::size_t index{};
  while (index + 3 <= bytes.size()) {
    const auto value = (static_cast<unsigned int>(bytes[index]) << 16U) |
                       (static_cast<unsigned int>(bytes[index + 1]) << 8U) | bytes[index + 2];
    result.push_back(alphabet[(value >> 18U) & 0x3fU]);
    result.push_back(alphabet[(value >> 12U) & 0x3fU]);
    result.push_back(alphabet[(value >> 6U) & 0x3fU]);
    result.push_back(alphabet[value & 0x3fU]);
    index += 3;
  }
  if (index < bytes.size()) {
    const auto value = static_cast<unsigned int>(bytes[index]) << 16U |
                       static_cast<unsigned int>(bytes[index + 1]) << 8U;
    result.push_back(alphabet[(value >> 18U) & 0x3fU]);
    result.push_back(alphabet[(value >> 12U) & 0x3fU]);
    result.push_back(alphabet[(value >> 6U) & 0x3fU]);
  }
  return result;
}

std::array<unsigned char, SHA256_DIGEST_LENGTH> digest(std::string_view value) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> result;
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), result.data());
  return result;
}

std::string new_match_id() {
  auto bytes = random_bytes<16>();
  bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0fU) | 0x40U);
  bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3fU) | 0x80U);
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  result.reserve(36);
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    if (index == 4 || index == 6 || index == 8 || index == 10) result.push_back('-');
    result.push_back(hex[bytes[index] >> 4U]);
    result.push_back(hex[bytes[index] & 0x0fU]);
  }
  return result;
}

}  // namespace

class MatchManager::Impl {
 public:
  struct PlayerState {
    MatchPlayer player;
    std::array<unsigned char, SHA256_DIGEST_LENGTH> ticket_digest;
    PlayerInput input;
    std::uint64_t sequence{};
    bool active{};
    bool consumed{};
  };

  struct Match {
    std::string room_id;
    std::string map_id;
    std::chrono::system_clock::time_point expires_at;
    std::vector<PlayerState> players;
    std::unique_ptr<PrototypeSimulation> simulation;
  };

  explicit Impl(Now now) : now(std::move(now)) {}

  // ponytail: one global lock suits the local multi-match ceiling; split per match if contention matters.
  std::mutex mutex;
  Now now;
  std::unordered_map<std::string, std::unique_ptr<Match>> matches;
};

MatchManager::MatchManager(Now now) : impl_(std::make_unique<Impl>(std::move(now))) {
  if (!impl_->now) throw std::invalid_argument("clock is required");
}

MatchManager::~MatchManager() = default;

CreateMatchResult MatchManager::create(
    std::string room_id, std::string map_id, std::vector<MatchPlayer> players) {
  validate_players(room_id, players);
  auto config = route_config(map_id);
  std::lock_guard lock(impl_->mutex);
  const auto expires_at = impl_->now() + kTicketLifetime;
  auto match = std::make_unique<Impl::Match>();
  match->room_id = std::move(room_id);
  match->map_id = std::move(map_id);
  match->expires_at = expires_at;

  std::vector<RobotColor> roster;
  roster.reserve(players.size());
  for (const auto& player : players) roster.push_back(player.color);
  match->simulation = std::make_unique<PrototypeSimulation>(std::move(roster), std::move(config));

  CreateMatchResult result;
  result.match_id = new_match_id();
  result.expires_at = expires_at;
  result.launches.reserve(players.size());
  match->players.reserve(players.size());
  for (auto& player : players) {
    const auto ticket = base64url(random_bytes<kTicketBytes>());
    result.launches.push_back({player.id, player.color, ticket});
    match->players.push_back({std::move(player), digest(ticket), {}, 0, false, false});
  }

  const auto [_, inserted] = impl_->matches.emplace(result.match_id, std::move(match));
  if (!inserted) throw std::runtime_error("match id collision");
  return result;
}

std::optional<Admission> MatchManager::admit(std::string_view match_id, std::string_view ticket) {
  const auto candidate = digest(ticket);
  std::lock_guard lock(impl_->mutex);
  const auto found = impl_->matches.find(std::string(match_id));
  if (found == impl_->matches.end() || impl_->now() >= found->second->expires_at) return std::nullopt;

  for (auto& state : found->second->players) {
    if (CRYPTO_memcmp(candidate.data(), state.ticket_digest.data(), candidate.size()) == 0 &&
        !state.active && !state.consumed) {
      state.active = true;
      state.consumed = true;
      std::vector<RobotColor> roster;
      roster.reserve(found->second->players.size());
      for (const auto& player : found->second->players) roster.push_back(player.player.color);
      return Admission{std::string(match_id), state.player.id, state.player.color,
                       found->second->map_id, std::move(roster)};
    }
  }
  return std::nullopt;
}

bool MatchManager::set_input(const Admission& admission, PlayerInput input, std::uint64_t sequence) {
  std::lock_guard lock(impl_->mutex);
  const auto found = impl_->matches.find(admission.match_id);
  if (found == impl_->matches.end()) return false;
  for (auto& state : found->second->players) {
    if (state.player.id == admission.player_id && state.player.color == admission.color && state.active) {
      state.input = input;
      state.sequence = sequence;
      return true;
    }
  }
  return false;
}

void MatchManager::disconnect(const Admission& admission) {
  std::lock_guard lock(impl_->mutex);
  const auto found = impl_->matches.find(admission.match_id);
  if (found == impl_->matches.end()) return;
  for (auto& state : found->second->players) {
    if (state.player.id == admission.player_id && state.player.color == admission.color) {
      state.active = false;
      state.input = {};
      return;
    }
  }
}

std::vector<MatchFrame> MatchManager::step_all() {
  std::lock_guard lock(impl_->mutex);
  std::vector<MatchFrame> frames;
  frames.reserve(impl_->matches.size());
  for (auto& [match_id, match] : impl_->matches) {
    MatchFrame frame;
    frame.match_id = match_id;
    frame.acknowledged_inputs.reserve(match->players.size());
    for (const auto& state : match->players) {
      match->simulation->set_input(state.player.color, state.input);
      frame.acknowledged_inputs.push_back(state.sequence);
    }
    match->simulation->step();
    frame.snapshot = match->simulation->snapshot();
    frames.push_back(std::move(frame));
  }
  return frames;
}

bool MatchManager::destroy(std::string_view match_id) {
  std::lock_guard lock(impl_->mutex);
  return impl_->matches.erase(std::string(match_id)) != 0;
}

}  // namespace linked_up
