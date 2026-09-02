#include "linked_up/prototype_simulation.hpp"

#include <Jolt/Jolt.h>
#include <Jolt/Core/Factory.h>
#include <Jolt/Core/JobSystemThreadPool.h>
#include <Jolt/Core/TempAllocator.h>
#include <Jolt/Physics/Body/BodyCreationSettings.h>
#include <Jolt/Physics/Collision/BroadPhase/BroadPhaseLayer.h>
#include <Jolt/Physics/Collision/ObjectLayer.h>
#include <Jolt/Physics/Collision/Shape/BoxShape.h>
#include <Jolt/Physics/Collision/Shape/CapsuleShape.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/RegisterTypes.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace linked_up {
namespace {

constexpr JPH::ObjectLayer kStaticLayer = 0;
constexpr JPH::ObjectLayer kMovingLayer = 1;
constexpr JPH::BroadPhaseLayer kStaticBroadPhase{0};
constexpr JPH::BroadPhaseLayer kMovingBroadPhase{1};
constexpr JPH::uint kBroadPhaseLayerCount = 2;
constexpr float kPlayerCapsuleHalfHeight = 0.6f;
constexpr float kPlayerRadius = 0.4f;
constexpr float kPlayerStandingHeight = kPlayerCapsuleHalfHeight + kPlayerRadius;

#ifdef JPH_ENABLE_ASSERTS
bool jolt_assert_failed(const char* expression, const char* message, const char* file,
                        JPH::uint line) {
  std::cerr << file << ':' << line << ": Jolt assertion " << expression;
  if (message != nullptr) std::cerr << " (" << message << ')';
  std::cerr << '\n';
  return false;
}
#endif

class BroadPhaseLayers final : public JPH::BroadPhaseLayerInterface {
 public:
  JPH::uint GetNumBroadPhaseLayers() const override { return kBroadPhaseLayerCount; }

  JPH::BroadPhaseLayer GetBroadPhaseLayer(JPH::ObjectLayer layer) const override {
    return layer == kStaticLayer ? kStaticBroadPhase : kMovingBroadPhase;
  }
};

class ObjectVsBroadPhase final : public JPH::ObjectVsBroadPhaseLayerFilter {
 public:
  bool ShouldCollide(JPH::ObjectLayer layer, JPH::BroadPhaseLayer broad_phase) const override {
    return layer == kMovingLayer || broad_phase == kMovingBroadPhase;
  }
};

class ObjectPairs final : public JPH::ObjectLayerPairFilter {
 public:
  bool ShouldCollide(JPH::ObjectLayer left, JPH::ObjectLayer right) const override {
    return left == kMovingLayer || right == kMovingLayer;
  }
};

bool finite(float value) { return std::isfinite(value); }

bool finite(Vec3 value) { return finite(value.x) && finite(value.y) && finite(value.z); }

JPH::RVec3 to_jolt_position(Vec3 value) { return {value.x, value.y, value.z}; }

template <typename JoltVector>
Vec3 from_jolt(const JoltVector& value) {
  return {static_cast<float>(value.GetX()), static_cast<float>(value.GetY()),
          static_cast<float>(value.GetZ())};
}

bool known_color(RobotColor color) {
  return static_cast<std::size_t>(color) <= static_cast<std::size_t>(RobotColor::Purple);
}

void validate_roster(const std::vector<RobotColor>& roster) {
  if (roster.size() < 2 || roster.size() > 4) {
    throw std::invalid_argument("roster must have two to four players");
  }
  for (std::size_t index = 0; index < roster.size(); ++index) {
    if (!known_color(roster[index]) ||
        std::find(roster.begin(), roster.begin() + static_cast<std::ptrdiff_t>(index), roster[index]) !=
            roster.begin() + static_cast<std::ptrdiff_t>(index)) {
      throw std::invalid_argument("roster contains an invalid or repeated player color");
    }
  }
}

Config validated(Config config) {
  const std::array values{
      config.tick_rate,          config.move_speed,           config.acceleration,
      config.jump_speed,         config.platform_half_extent, config.tether_slack_length,
      config.tether_hard_length, config.tether_stiffness,     config.tether_damping,
      config.tether_max_force,   config.fail_height,
  };
  if (!std::all_of(values.begin(), values.end(), [](float value) { return finite(value); }) ||
      config.tick_rate <= 0.0f || config.move_speed < 0.0f || config.acceleration < 0.0f ||
      config.jump_speed < 0.0f || config.platform_half_extent <= 0.0f ||
      config.tether_slack_length < 0.0f ||
      config.tether_hard_length <= config.tether_slack_length || config.tether_stiffness < 0.0f ||
      config.tether_damping < 0.0f || config.tether_max_force <= 0.0f ||
      !std::all_of(
          config.spawn_positions.begin(), config.spawn_positions.end(),
          [](Vec3 value) { return finite(value); })) {
    throw std::invalid_argument("invalid simulation configuration");
  }
  return config;
}

}  // namespace

const char* color_name(RobotColor color) {
  switch (color) {
    case RobotColor::Blue:
      return "blue";
    case RobotColor::Orange:
      return "orange";
    case RobotColor::Green:
      return "green";
    case RobotColor::Purple:
      return "purple";
  }
  throw std::invalid_argument("unknown robot color");
}

class PrototypeSimulation::Impl {
 public:
  explicit Impl(std::vector<RobotColor> roster, Config config)
      : roster_(std::move(roster)), config_(validated(config)) {
    validate_roster(roster_);
    JPH::RegisterDefaultAllocator();
    JPH_IF_ENABLE_ASSERTS(JPH::AssertFailed = jolt_assert_failed;)
    JPH::Factory::sInstance = new JPH::Factory();
    JPH::RegisterTypes();
    allocator_ = std::make_unique<JPH::TempAllocatorMalloc>();
    jobs_ = std::make_unique<JPH::JobSystemThreadPool>(
        JPH::cMaxPhysicsJobs, JPH::cMaxPhysicsBarriers,
        std::max(1u, std::thread::hardware_concurrency()) - 1);

    physics_.Init(1024, 0, 1024, 1024, broad_phase_layers_, object_vs_broad_phase_, object_pairs_);
    physics_.SetGravity({0.0f, -9.81f, 0.0f});

    auto& bodies = physics_.GetBodyInterface();
    JPH::BodyCreationSettings floor(
        new JPH::BoxShape({config_.platform_half_extent, 0.5f, config_.platform_half_extent}),
        JPH::RVec3(0.0f, -0.5f, 0.0f), JPH::Quat::sIdentity(), JPH::EMotionType::Static,
        kStaticLayer);
    floor_id_ = bodies.CreateAndAddBody(floor, JPH::EActivation::DontActivate);

    player_ids_.reserve(roster_.size());
    inputs_.resize(roster_.size());
    jump_consumed_.resize(roster_.size());
    for (std::size_t player = 0; player < roster_.size(); ++player) {
      JPH::BodyCreationSettings settings(
          new JPH::CapsuleShape(kPlayerCapsuleHalfHeight, kPlayerRadius),
          to_jolt_position(config_.spawn_positions[player]), JPH::Quat::sIdentity(),
          JPH::EMotionType::Dynamic, kMovingLayer);
      settings.mAllowedDOFs = JPH::EAllowedDOFs::TranslationX | JPH::EAllowedDOFs::TranslationY |
                              JPH::EAllowedDOFs::TranslationZ;
      settings.mFriction = 0.8f;
      settings.mLinearDamping = 0.05f;
      settings.mOverrideMassProperties = JPH::EOverrideMassProperties::CalculateInertia;
      settings.mMassPropertiesOverride.mMass = 1.0f;
      player_ids_.push_back(bodies.CreateAndAddBody(settings, JPH::EActivation::Activate));
    }
    physics_.OptimizeBroadPhase();
  }

  ~Impl() {
    auto& bodies = physics_.GetBodyInterface();
    for (const auto body : player_ids_) {
      bodies.RemoveBody(body);
      bodies.DestroyBody(body);
    }
    bodies.RemoveBody(floor_id_);
    bodies.DestroyBody(floor_id_);
    JPH::UnregisterTypes();
    delete JPH::Factory::sInstance;
    JPH::Factory::sInstance = nullptr;
  }

  void set_input(RobotColor player, PlayerInput input) {
    if (!finite(input.move_x) || !finite(input.move_z)) input = {};
    const float length = std::hypot(input.move_x, input.move_z);
    if (length > 1.0f) {
      input.move_x /= length;
      input.move_z /= length;
    }
    inputs_[player_index(player)] = input;
  }

  void step() {
    const float delta_time = 1.0f / config_.tick_rate;
    auto& bodies = physics_.GetBodyInterface();

    for (std::size_t player = 0; player < player_ids_.size(); ++player) {
      JPH::Vec3 velocity = bodies.GetLinearVelocity(player_ids_[player]);
      const JPH::Vec3 target{inputs_[player].move_x * config_.move_speed, 0.0f,
                             inputs_[player].move_z * config_.move_speed};
      JPH::Vec3 difference{target.GetX() - velocity.GetX(), 0.0f, target.GetZ() - velocity.GetZ()};
      const float max_change = config_.acceleration * delta_time;
      if (difference.Length() > max_change) {
        difference = difference.Normalized() * max_change;
      }
      velocity += difference;

      const bool grounded = is_grounded(player);
      if (inputs_[player].jump && grounded && !jump_consumed_[player]) {
        velocity.SetY(config_.jump_speed);
        jump_consumed_[player] = true;
      } else if (!inputs_[player].jump && grounded) {
        jump_consumed_[player] = false;
      }
      bodies.SetLinearVelocity(player_ids_[player], velocity);
    }

    apply_tether();
    const auto errors = physics_.Update(delta_time, 1, allocator_.get(), jobs_.get());
    if (errors != JPH::EPhysicsUpdateError::None) {
      throw std::runtime_error("Jolt physics update failed with flags " +
                               std::to_string(static_cast<JPH::uint32>(errors)));
    }
    enforce_hard_tether_limit();
    ++tick_;

    const Snapshot state = snapshot();
    for (const auto& player : state.players) {
      if (!finite(player.position) || !finite(player.velocity)) {
        throw std::runtime_error("non-finite authoritative physics state");
      }
      if (player.position.y < config_.fail_height) {
        reset();
        return;
      }
    }
  }

  Snapshot snapshot() const {
    Snapshot result;
    result.tick = tick_;
    result.reset_count = reset_count_;
    result.tether_tension = tether_tension_;
    const auto& bodies = physics_.GetBodyInterface();
    result.players.reserve(player_ids_.size());
    for (std::size_t player = 0; player < player_ids_.size(); ++player) {
      result.players.push_back({roster_[player], from_jolt(bodies.GetPosition(player_ids_[player])),
                                from_jolt(bodies.GetLinearVelocity(player_ids_[player])),
                                is_grounded(player)});
    }
    return result;
  }

  void reset() {
    auto& bodies = physics_.GetBodyInterface();
    for (std::size_t player = 0; player < player_ids_.size(); ++player) {
      bodies.SetPositionRotationAndVelocity(
          player_ids_[player], to_jolt_position(config_.spawn_positions[player]),
          JPH::Quat::sIdentity(), JPH::Vec3::sZero(), JPH::Vec3::sZero());
      inputs_[player] = {};
      jump_consumed_[player] = false;
    }
    tick_ = 0;
    tether_tension_ = 0.0f;
    ++reset_count_;
  }

 private:
  std::size_t player_index(RobotColor player) const {
    const auto found = std::find(roster_.begin(), roster_.end(), player);
    if (found == roster_.end()) throw std::invalid_argument("player is not in the roster");
    return static_cast<std::size_t>(found - roster_.begin());
  }

  bool is_grounded(std::size_t player) const {
    const auto& bodies = physics_.GetBodyInterface();
    const auto position = bodies.GetPosition(player_ids_[player]);
    const auto velocity = bodies.GetLinearVelocity(player_ids_[player]);
    return position.GetY() <= kPlayerStandingHeight + 0.08f &&
           std::abs(position.GetX()) <= config_.platform_half_extent + kPlayerRadius &&
           std::abs(position.GetZ()) <= config_.platform_half_extent + kPlayerRadius &&
           velocity.GetY() <= 0.2f;
  }

  void apply_tether() {
    auto& bodies = physics_.GetBodyInterface();
    tether_tension_ = 0.0f;
    std::vector<JPH::RVec3> positions;
    std::vector<JPH::Vec3> velocities;
    positions.reserve(player_ids_.size());
    velocities.reserve(player_ids_.size());
    for (const auto body : player_ids_) {
      positions.push_back(bodies.GetPosition(body));
      velocities.push_back(bodies.GetLinearVelocity(body));
    }

    for (std::size_t player = 0; player < player_ids_.size(); ++player) {
      JPH::RVec3 average_position = JPH::RVec3::sZero();
      JPH::Vec3 average_velocity = JPH::Vec3::sZero();
      for (std::size_t teammate = 0; teammate < player_ids_.size(); ++teammate) {
        if (teammate == player) continue;
        average_position += positions[teammate];
        average_velocity += velocities[teammate];
      }
      const float teammate_count = static_cast<float>(player_ids_.size() - 1);
      average_position /= teammate_count;
      average_velocity /= teammate_count;
      const JPH::Vec3 inward = JPH::Vec3(average_position - positions[player]);
      const float distance = inward.Length();
      if (distance <= config_.tether_slack_length || distance < 0.0001f) continue;

      const JPH::Vec3 direction = inward / distance;
      const float outward_speed = (velocities[player] - average_velocity).Dot(-direction);
      const float force =
          std::clamp(config_.tether_stiffness * (distance - config_.tether_slack_length) +
                         config_.tether_damping * outward_speed,
                     0.0f, config_.tether_max_force);
      bodies.AddForce(player_ids_[player], direction * force);
      tether_tension_ = std::max(tether_tension_, force / config_.tether_max_force);
    }
  }

  void enforce_hard_tether_limit() {
    auto& bodies = physics_.GetBodyInterface();
    std::vector<JPH::RVec3> positions;
    std::vector<JPH::Vec3> velocities;
    positions.reserve(player_ids_.size());
    velocities.reserve(player_ids_.size());
    for (const auto body : player_ids_) {
      positions.push_back(bodies.GetPosition(body));
      velocities.push_back(bodies.GetLinearVelocity(body));
    }

    for (std::size_t player = 0; player < player_ids_.size(); ++player) {
      JPH::RVec3 average_position = JPH::RVec3::sZero();
      for (std::size_t teammate = 0; teammate < player_ids_.size(); ++teammate) {
        if (teammate == player) continue;
        average_position += positions[teammate];
      }
      const float teammate_count = static_cast<float>(player_ids_.size() - 1);
      average_position /= teammate_count;
      const JPH::Vec3 inward = JPH::Vec3(average_position - positions[player]);
      const float distance = inward.Length();
      if (distance <= config_.tether_hard_length || distance < 0.0001f) continue;

      const JPH::Vec3 direction = inward / distance;
      const JPH::Vec3 outward = -direction;
      JPH::Vec3 velocity = velocities[player];
      const float outward_speed = velocity.Dot(outward);
      if (outward_speed > 0.0f) velocity -= outward * outward_speed;
      bodies.SetPositionRotationAndVelocity(player_ids_[player],
                                            positions[player] + direction * (distance - config_.tether_hard_length),
                                            JPH::Quat::sIdentity(), velocity, JPH::Vec3::sZero());
    }
  }

  std::vector<RobotColor> roster_;
  Config config_;
  BroadPhaseLayers broad_phase_layers_;
  ObjectVsBroadPhase object_vs_broad_phase_;
  ObjectPairs object_pairs_;
  JPH::PhysicsSystem physics_;
  std::unique_ptr<JPH::TempAllocatorMalloc> allocator_;
  std::unique_ptr<JPH::JobSystemThreadPool> jobs_;
  JPH::BodyID floor_id_;
  std::vector<JPH::BodyID> player_ids_;
  std::vector<PlayerInput> inputs_;
  std::vector<bool> jump_consumed_;
  std::uint64_t tick_{};
  std::uint64_t reset_count_{};
  float tether_tension_{};
};

PrototypeSimulation::PrototypeSimulation()
    : PrototypeSimulation({RobotColor::Blue, RobotColor::Orange}) {}

PrototypeSimulation::PrototypeSimulation(std::vector<RobotColor> roster, Config config)
    : impl_(std::make_unique<Impl>(std::move(roster), config)) {}

PrototypeSimulation::~PrototypeSimulation() = default;

void PrototypeSimulation::set_input(RobotColor player, PlayerInput input) {
  impl_->set_input(player, input);
}

void PrototypeSimulation::step() { impl_->step(); }

Snapshot PrototypeSimulation::snapshot() const { return impl_->snapshot(); }

void PrototypeSimulation::reset() { impl_->reset(); }

}  // namespace linked_up
