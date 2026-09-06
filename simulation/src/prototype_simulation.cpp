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
#include <optional>
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
constexpr float kPi = 3.14159265358979323846f;

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

bool contains(BoxVolume box, Vec3 point) {
  return std::abs(point.x - box.center.x) <= box.half_extent.x &&
         std::abs(point.y - box.center.y) <= box.half_extent.y &&
         std::abs(point.z - box.center.z) <= box.half_extent.z;
}

JPH::RVec3 to_jolt_position(Vec3 value) { return {value.x, value.y, value.z}; }

template <typename JoltVector>
Vec3 from_jolt(const JoltVector& value) {
  return {static_cast<float>(value.GetX()), static_cast<float>(value.GetY()),
          static_cast<float>(value.GetZ())};
}

bool known_color(RobotColor color) {
  return static_cast<std::size_t>(color) <= static_cast<std::size_t>(RobotColor::Purple);
}

bool known_zone(Zone zone) {
  return static_cast<std::size_t>(zone) <= static_cast<std::size_t>(Zone::Summit);
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
  const auto valid_volume = [](BoxVolume box) {
    return finite(box.center) && finite(box.half_extent) && box.half_extent.x >= 0.0f &&
           box.half_extent.y >= 0.0f && box.half_extent.z >= 0.0f;
  };
  if (!valid_volume(config.summit) || !std::all_of(config.checkpoints.begin(),
      config.checkpoints.end(), [&](const Checkpoint& checkpoint) {
        return valid_volume(checkpoint.volume) && std::all_of(
            checkpoint.spawn_positions.begin(), checkpoint.spawn_positions.end(),
            [](Vec3 value) { return finite(value); });
      })) {
    throw std::invalid_argument("invalid progression configuration");
  }
  for (std::size_t index = 0; index < config.obstacles.size(); ++index) {
    const auto& obstacle = config.obstacles[index];
    if (obstacle.id.empty() || !finite(obstacle.origin) || !finite(obstacle.half_extent) ||
        !finite(obstacle.travel) || !finite(obstacle.period_ticks) || !finite(obstacle.amplitude) ||
        obstacle.half_extent.x <= 0.0f || obstacle.half_extent.y <= 0.0f ||
        obstacle.half_extent.z <= 0.0f || obstacle.period_ticks <= 0.0f ||
        obstacle.amplitude < 0.0f || !known_zone(obstacle.zone) ||
        std::any_of(config.obstacles.begin(), config.obstacles.begin() + static_cast<std::ptrdiff_t>(index),
                    [&](const ObstacleConfig& previous) { return previous.id == obstacle.id; })) {
      throw std::invalid_argument("invalid obstacle configuration");
    }
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

Config default_route_config() {
  Config config;
  config.platform_half_extent = 8.0f;
  config.fail_height = -24.0f;
  config.checkpoints = {
      {{{0.0f, 9.8f, 29.0f}, {5.0f, 2.0f, 4.0f}},
       {{{-1.0f, 9.8f, 29.0f}, {1.0f, 9.8f, 29.0f}, {-3.0f, 9.8f, 29.0f}, {3.0f, 9.8f, 29.0f}}}},
      {{{0.0f, 20.2f, 65.0f}, {5.0f, 2.0f, 4.0f}},
       {{{-1.0f, 20.2f, 65.0f}, {1.0f, 20.2f, 65.0f}, {-3.0f, 20.2f, 65.0f}, {3.0f, 20.2f, 65.0f}}}},
      {{{0.0f, 30.4f, 101.0f}, {5.0f, 2.0f, 4.0f}},
       {{{-1.0f, 30.4f, 101.0f}, {1.0f, 30.4f, 101.0f}, {-3.0f, 30.4f, 101.0f}, {3.0f, 30.4f, 101.0f}}}},
      {{{0.0f, 40.8f, 137.0f}, {5.0f, 2.0f, 4.0f}},
       {{{-1.0f, 40.8f, 137.0f}, {1.0f, 40.8f, 137.0f}, {-3.0f, 40.8f, 137.0f}, {3.0f, 40.8f, 137.0f}}}},
  };
  config.summit = {{0.0f, 46.2f, 155.0f}, {5.0f, 2.0f, 4.0f}};
  config.obstacles = {
      {"grass-ledge-1", ObstacleKind::StaticPlatform, {0.0f, 1.8f, 5.0f}, {4.5f, 0.4f, 3.0f}, {}, 60.0f, 0.0f, Zone::Grass},
      {"grass-ledge-2", ObstacleKind::StaticPlatform, {0.0f, 3.8f, 11.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Grass},
      {"grass-elevator-1", ObstacleKind::MovingPlatform, {0.0f, 5.4f, 17.0f}, {2.5f, 0.35f, 2.5f}, {0.0f, 1.0f, 0.0f}, 180.0f, 0.0f, Zone::Grass},
      {"grass-ledge-3", ObstacleKind::StaticPlatform, {0.0f, 7.0f, 23.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Grass},
      {"grass-ledge-4", ObstacleKind::StaticPlatform, {0.0f, 8.4f, 29.0f}, {5.0f, 0.4f, 3.5f}, {}, 60.0f, 0.0f, Zone::Grass},

      {"construction-ledge-0", ObstacleKind::StaticPlatform, {1.5f, 9.2f, 32.0f}, {3.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Construction},
      {"construction-ledge-1", ObstacleKind::StaticPlatform, {-1.5f, 10.5f, 35.0f}, {3.5f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Construction},
      {"construction-mover-1", ObstacleKind::MovingPlatform, {1.5f, 12.1f, 41.0f}, {2.0f, 0.3f, 2.0f}, {-3.0f, 0.0f, 0.0f}, 150.0f, 0.0f, Zone::Construction},
      {"construction-ledge-2", ObstacleKind::StaticPlatform, {0.0f, 13.8f, 47.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Construction},
      {"construction-beam-1", ObstacleKind::RotatingBeam, {0.0f, 14.6f, 47.0f}, {3.5f, 0.2f, 0.25f}, {}, 180.0f, 0.0f, Zone::Construction},
      {"construction-fall-1", ObstacleKind::FallingPlatform, {-2.4f, 15.6f, 53.0f}, {1.4f, 0.3f, 1.4f}, {}, 120.0f, 7.0f, Zone::Construction},
      {"construction-ledge-3", ObstacleKind::StaticPlatform, {1.5f, 15.6f, 53.0f}, {2.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Construction},
      {"construction-elevator-1", ObstacleKind::MovingPlatform, {0.0f, 17.2f, 59.0f}, {2.5f, 0.35f, 2.0f}, {0.0f, 1.0f, 0.0f}, 180.0f, 0.0f, Zone::Construction},
      {"construction-checkpoint", ObstacleKind::StaticPlatform, {0.0f, 18.8f, 65.0f}, {5.0f, 0.4f, 3.5f}, {}, 60.0f, 0.0f, Zone::Construction},

      {"industrial-ledge-1", ObstacleKind::StaticPlatform, {0.0f, 21.0f, 71.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Industrial},
      {"industrial-conveyor-base", ObstacleKind::StaticPlatform, {0.0f, 22.6f, 77.0f}, {4.5f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Industrial},
      {"industrial-conveyor-1", ObstacleKind::Conveyor, {0.0f, 24.0f, 77.0f}, {4.5f, 1.2f, 2.5f}, {0.0f, 0.0f, -1.0f}, 60.0f, 3.0f, Zone::Industrial},
      {"industrial-ledge-2", ObstacleKind::StaticPlatform, {-1.5f, 24.2f, 83.0f}, {3.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Industrial},
      {"industrial-fan-1", ObstacleKind::Fan, {-1.5f, 25.7f, 83.0f}, {3.0f, 1.6f, 2.0f}, {1.0f, 0.0f, 0.0f}, 60.0f, 18.0f, Zone::Industrial},
      {"industrial-elevator-1", ObstacleKind::MovingPlatform, {1.5f, 25.8f, 89.0f}, {2.0f, 0.35f, 2.0f}, {0.0f, 1.2f, 0.0f}, 180.0f, 0.0f, Zone::Industrial},
      {"industrial-ledge-3", ObstacleKind::StaticPlatform, {0.0f, 27.8f, 95.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Industrial},
      {"industrial-beam-1", ObstacleKind::RotatingBeam, {0.0f, 28.6f, 95.0f}, {3.5f, 0.2f, 0.25f}, {}, 160.0f, 0.0f, Zone::Industrial},
      {"industrial-checkpoint", ObstacleKind::StaticPlatform, {0.0f, 29.0f, 101.0f}, {5.0f, 0.4f, 3.5f}, {}, 60.0f, 0.0f, Zone::Industrial},

      {"sky-rock-1", ObstacleKind::StaticPlatform, {-2.0f, 31.2f, 107.0f}, {2.5f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Sky},
      {"sky-mover-1", ObstacleKind::MovingPlatform, {2.0f, 32.8f, 113.0f}, {2.0f, 0.35f, 2.0f}, {-3.0f, 0.0f, 0.0f}, 180.0f, 0.0f, Zone::Sky},
      {"sky-rock-2", ObstacleKind::StaticPlatform, {0.0f, 34.5f, 119.0f}, {3.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Sky},
      {"sky-swing-1", ObstacleKind::SwingingBeam, {0.0f, 35.5f, 119.0f}, {3.0f, 0.2f, 0.25f}, {}, 180.0f, 1.0f, Zone::Sky},
      {"sky-fan-1", ObstacleKind::Fan, {0.0f, 36.0f, 119.0f}, {3.5f, 1.5f, 2.0f}, {1.0f, 0.0f, 0.0f}, 60.0f, 14.0f, Zone::Sky},
      {"sky-rock-3", ObstacleKind::StaticPlatform, {-2.0f, 36.4f, 125.0f}, {2.5f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Sky},
      {"sky-mover-2", ObstacleKind::MovingPlatform, {2.0f, 38.0f, 131.0f}, {2.0f, 0.35f, 2.0f}, {-3.0f, 0.0f, 0.0f}, 160.0f, 0.0f, Zone::Sky},
      {"sky-checkpoint", ObstacleKind::StaticPlatform, {0.0f, 39.4f, 137.0f}, {5.0f, 0.4f, 3.5f}, {}, 60.0f, 0.0f, Zone::Sky},

      {"summit-ledge-0", ObstacleKind::StaticPlatform, {1.5f, 40.2f, 140.0f}, {3.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Summit},
      {"summit-ledge-1", ObstacleKind::StaticPlatform, {0.0f, 41.4f, 143.0f}, {4.0f, 0.4f, 2.5f}, {}, 60.0f, 0.0f, Zone::Summit},
      {"summit-ledge-2", ObstacleKind::StaticPlatform, {-1.5f, 43.0f, 149.0f}, {3.0f, 0.4f, 2.0f}, {}, 60.0f, 0.0f, Zone::Summit},
      {"summit-ledge-3", ObstacleKind::StaticPlatform, {0.0f, 44.8f, 155.0f}, {5.0f, 0.4f, 3.5f}, {}, 60.0f, 0.0f, Zone::Summit},
  };
  return config;
}

class PrototypeSimulation::Impl {
 public:
  explicit Impl(std::vector<RobotColor> roster, Config config)
      : roster_(std::move(roster)), config_(validated(config)) {
    validate_roster(roster_);
    falling_started_ticks_.resize(config_.obstacles.size());
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
    obstacle_ids_.reserve(config_.obstacles.size());
    for (const auto& obstacle : config_.obstacles) {
      if (obstacle.kind == ObstacleKind::StaticPlatform) {
        JPH::BodyCreationSettings settings(
            new JPH::BoxShape({obstacle.half_extent.x, obstacle.half_extent.y, obstacle.half_extent.z}),
            to_jolt_position(obstacle.origin), JPH::Quat::sIdentity(), JPH::EMotionType::Static, kStaticLayer);
        obstacle_ids_.push_back(bodies.CreateAndAddBody(settings, JPH::EActivation::DontActivate));
        continue;
      }
      if (obstacle.kind != ObstacleKind::MovingPlatform && obstacle.kind != ObstacleKind::RotatingBeam &&
          obstacle.kind != ObstacleKind::SwingingBeam && obstacle.kind != ObstacleKind::FallingPlatform) {
        obstacle_ids_.push_back(std::nullopt);
        continue;
      }
      JPH::BodyCreationSettings settings(
          new JPH::BoxShape({obstacle.half_extent.x, obstacle.half_extent.y, obstacle.half_extent.z}),
          to_jolt_position(obstacle.origin), JPH::Quat::sIdentity(), JPH::EMotionType::Kinematic,
          kMovingLayer);
      settings.mFriction = 0.8f;
      obstacle_ids_.push_back(bodies.CreateAndAddBody(settings, JPH::EActivation::Activate));
    }
    physics_.OptimizeBroadPhase();
  }

  ~Impl() {
    auto& bodies = physics_.GetBodyInterface();
    for (const auto body : player_ids_) {
      bodies.RemoveBody(body);
      bodies.DestroyBody(body);
    }
    for (const auto body : obstacle_ids_) {
      if (!body) continue;
      bodies.RemoveBody(*body);
      bodies.DestroyBody(*body);
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
    if (match_state_ == MatchState::Finished) return;
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
      } else if (inputs_[player].jump && !grounded) {
        JPH::RVec3 anchor_position = JPH::RVec3::sZero();
        std::size_t anchor_count = 0;
        for (std::size_t teammate = 0; teammate < player_ids_.size(); ++teammate) {
          if (teammate == player || !is_grounded(teammate)) continue;
          anchor_position += bodies.GetPosition(player_ids_[teammate]);
          ++anchor_count;
        }
        if (anchor_count > 0) {
          anchor_position /= static_cast<float>(anchor_count);
          const auto player_position = bodies.GetPosition(player_ids_[player]);
          const JPH::Vec3 toward_anchor =
              JPH::Vec3(anchor_position - player_position);
          const float distance = toward_anchor.Length();
          const auto ledge_target = ledge_reel_target(player_position, anchor_position);
          const JPH::Vec3 toward_target = JPH::Vec3(
              ledge_target.value_or(anchor_position) - player_position);
          const float target_distance = toward_target.Length();
          if ((distance > config_.tether_slack_length || ledge_target) &&
              toward_anchor.GetY() > kPlayerRadius && target_distance > 0.0001f) {
            const JPH::Vec3 direction = toward_target / target_distance;
            const float reel_speed = config_.jump_speed * 0.75f;
            const float current_speed = velocity.Dot(direction);
            if (current_speed < reel_speed) velocity += direction * (reel_speed - current_speed);
            if (ledge_target && std::abs(toward_target.GetY()) < 0.001f) {
              velocity.SetY(std::max(velocity.GetY(), 0.0f));
            }
            jump_consumed_[player] = true;
          }
        }
      } else if (!inputs_[player].jump && grounded) {
        jump_consumed_[player] = false;
      }
      bodies.SetLinearVelocity(player_ids_[player], velocity);
    }

    apply_tether();
    apply_environment_forces();
    update_falling_platforms();
    update_kinematic_obstacles(delta_time);
    const auto errors = physics_.Update(delta_time, 1, allocator_.get(), jobs_.get());
    if (errors != JPH::EPhysicsUpdateError::None) {
      throw std::runtime_error("Jolt physics update failed with flags " +
                               std::to_string(static_cast<JPH::uint32>(errors)));
    }
    enforce_hard_tether_limit();
    ++tick_;
    ++elapsed_ticks_;

    const Snapshot state = snapshot();
    for (const auto& player : state.players) {
      if (!finite(player.position) || !finite(player.velocity)) {
        throw std::runtime_error("non-finite authoritative physics state");
      }
    }
    if (std::all_of(state.players.begin(), state.players.end(), [&](const PlayerState& player) {
          return player.position.y < config_.fail_height;
        })) {
      reset();
      return;
    }
    update_progress(state);
  }

  Snapshot snapshot() const {
    Snapshot result;
    result.tick = tick_;
    result.reset_count = reset_count_;
    result.tether_tension = tether_tension_;
    result.elapsed_ticks = elapsed_ticks_;
    result.checkpoint = checkpoint_;
    result.match_state = match_state_;
    result.obstacles = obstacle_states();
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
          player_ids_[player], to_jolt_position(spawn_positions()[player]),
          JPH::Quat::sIdentity(), JPH::Vec3::sZero(), JPH::Vec3::sZero());
      inputs_[player] = {};
      jump_consumed_[player] = false;
    }
    tick_ = 0;
    tether_tension_ = 0.0f;
    std::fill(falling_started_ticks_.begin(), falling_started_ticks_.end(), std::nullopt);
    ++reset_count_;
  }

 private:
  const std::array<Vec3, 4>& spawn_positions() const {
    return checkpoint_ == 0 ? config_.spawn_positions : config_.checkpoints[checkpoint_ - 1].spawn_positions;
  }

  void update_progress(const Snapshot& state) {
    for (std::size_t index = checkpoint_; index < config_.checkpoints.size(); ++index) {
      const auto& checkpoint = config_.checkpoints[index];
      if (std::any_of(state.players.begin(), state.players.end(), [&](const PlayerState& player) {
            return contains(checkpoint.volume, player.position);
          })) {
        checkpoint_ = index + 1;
      } else {
        break;
      }
    }
    if (std::all_of(state.players.begin(), state.players.end(), [&](const PlayerState& player) {
          return contains(config_.summit, player.position);
        })) {
      match_state_ = MatchState::Finished;
    }
  }

  std::vector<DynamicObstacleState> obstacle_states() const {
    std::vector<DynamicObstacleState> states;
    states.reserve(config_.obstacles.size());
    for (const auto& obstacle : config_.obstacles) {
      const float cycle = std::fmod(static_cast<float>(elapsed_ticks_) / obstacle.period_ticks, 1.0f);
      DynamicObstacleState state{.id = obstacle.id,
                                 .kind = obstacle.kind,
                                 .position = obstacle.origin,
                                 .half_extent = obstacle.half_extent,
                                 .zone = obstacle.zone};
      switch (obstacle.kind) {
        case ObstacleKind::StaticPlatform:
          break;
        case ObstacleKind::MovingPlatform: {
          const float leg = std::fmod(static_cast<float>(elapsed_ticks_) / obstacle.period_ticks, 2.0f);
          const float progress = leg <= 1.0f ? leg : 2.0f - leg;
          state.position = {obstacle.origin.x + obstacle.travel.x * progress,
                            obstacle.origin.y + obstacle.travel.y * progress,
                            obstacle.origin.z + obstacle.travel.z * progress};
          break;
        }
        case ObstacleKind::RotatingBeam:
          state.rotation.y = 2.0f * kPi * cycle;
          break;
        case ObstacleKind::SwingingBeam:
          state.position.x += std::sin(2.0f * kPi * cycle) * obstacle.amplitude;
          state.rotation.z = std::sin(2.0f * kPi * cycle) * obstacle.amplitude;
          break;
        case ObstacleKind::Fan:
        case ObstacleKind::Conveyor:
          break;
        case ObstacleKind::FallingPlatform:
          if (falling_started_ticks_[states.size()]) {
            const auto started = *falling_started_ticks_[states.size()];
            const auto elapsed = elapsed_ticks_ - started;
            state.phase = elapsed < static_cast<std::uint64_t>(obstacle.period_ticks)
                ? ObstaclePhase::Warning
                : ObstaclePhase::Falling;
            if (state.phase == ObstaclePhase::Falling) {
              state.position.y -= obstacle.amplitude *
                  static_cast<float>(elapsed - static_cast<std::uint64_t>(obstacle.period_ticks)) /
                  config_.tick_rate;
            }
          }
          break;
      }
      states.push_back(std::move(state));
    }
    return states;
  }

  void update_falling_platforms() {
    const auto& bodies = physics_.GetBodyInterface();
    for (std::size_t index = 0; index < config_.obstacles.size(); ++index) {
      const auto& obstacle = config_.obstacles[index];
      if (obstacle.kind != ObstacleKind::FallingPlatform || falling_started_ticks_[index]) continue;
      if (std::any_of(player_ids_.begin(), player_ids_.end(), [&](const JPH::BodyID& body) {
            const Vec3 position = from_jolt(bodies.GetPosition(body));
            return std::abs(position.y - (obstacle.origin.y + obstacle.half_extent.y +
                                           kPlayerStandingHeight)) <= 0.08f &&
                   std::abs(position.x - obstacle.origin.x) <= obstacle.half_extent.x + kPlayerRadius &&
                   std::abs(position.z - obstacle.origin.z) <= obstacle.half_extent.z + kPlayerRadius;
          })) {
        falling_started_ticks_[index] = elapsed_ticks_;
      }
    }
  }

  void update_kinematic_obstacles(float delta_time) {
    const auto states = obstacle_states();
    auto& bodies = physics_.GetBodyInterface();
    for (std::size_t index = 0; index < states.size(); ++index) {
      if (!obstacle_ids_[index] || config_.obstacles[index].kind == ObstacleKind::StaticPlatform) continue;
      const auto& state = states[index];
      const auto rotation = JPH::Quat::sRotation(JPH::Vec3::sAxisY(), state.rotation.y);
      bodies.MoveKinematic(*obstacle_ids_[index], to_jolt_position(state.position), rotation, delta_time);
    }
  }

  void apply_environment_forces() {
    auto& bodies = physics_.GetBodyInterface();
    for (const auto& obstacle : config_.obstacles) {
      if (obstacle.kind != ObstacleKind::Fan && obstacle.kind != ObstacleKind::Conveyor) continue;
      const float direction_length = std::hypot(obstacle.travel.x, obstacle.travel.z);
      if (direction_length < 0.0001f || obstacle.amplitude == 0.0f) continue;
      const Vec3 direction{obstacle.travel.x / direction_length, 0.0f,
                           obstacle.travel.z / direction_length};
      const BoxVolume volume{obstacle.origin, obstacle.half_extent};
      for (std::size_t player = 0; player < player_ids_.size(); ++player) {
        if (!contains(volume, from_jolt(bodies.GetPosition(player_ids_[player])))) continue;
        if (obstacle.kind == ObstacleKind::Fan) {
          bodies.AddForce(player_ids_[player], {direction.x * obstacle.amplitude, 0.0f,
                                                direction.z * obstacle.amplitude});
        } else if (is_grounded(player)) {
          const auto velocity = bodies.GetLinearVelocity(player_ids_[player]);
          bodies.SetLinearVelocity(player_ids_[player],
                                   {velocity.GetX() + direction.x * obstacle.amplitude /
                                                          config_.tick_rate,
                                    velocity.GetY(), velocity.GetZ() + direction.z * obstacle.amplitude /
                                                          config_.tick_rate});
        }
      }
    }
  }

  std::size_t player_index(RobotColor player) const {
    const auto found = std::find(roster_.begin(), roster_.end(), player);
    if (found == roster_.end()) throw std::invalid_argument("player is not in the roster");
    return static_cast<std::size_t>(found - roster_.begin());
  }

  bool is_grounded(std::size_t player) const {
    const auto& bodies = physics_.GetBodyInterface();
    const auto position = bodies.GetPosition(player_ids_[player]);
    const auto velocity = bodies.GetLinearVelocity(player_ids_[player]);
    if (velocity.GetY() > 0.2f) return false;
    if (position.GetY() <= kPlayerStandingHeight + 0.08f &&
        std::abs(position.GetX()) <= config_.platform_half_extent + kPlayerRadius &&
        std::abs(position.GetZ()) <= config_.platform_half_extent + kPlayerRadius) {
      return true;
    }
    for (std::size_t index = 0; index < obstacle_ids_.size(); ++index) {
      const auto& obstacle = config_.obstacles[index];
      if (!obstacle_ids_[index] || (obstacle.kind != ObstacleKind::StaticPlatform &&
                                   obstacle.kind != ObstacleKind::MovingPlatform &&
                                   obstacle.kind != ObstacleKind::FallingPlatform)) continue;
      const auto platform = bodies.GetPosition(*obstacle_ids_[index]);
      if (std::abs(position.GetY() - (platform.GetY() + obstacle.half_extent.y + kPlayerStandingHeight)) <= 0.08f &&
          std::abs(position.GetX() - platform.GetX()) <= obstacle.half_extent.x + kPlayerRadius &&
          std::abs(position.GetZ() - platform.GetZ()) <= obstacle.half_extent.z + kPlayerRadius) return true;
    }
    return false;
  }

  std::optional<JPH::RVec3> ledge_reel_target(
      JPH::RVec3 player, JPH::RVec3 anchor) const {
    const auto target_for_platform = [&](JPH::RVec3 center, Vec3 half_extent)
        -> std::optional<JPH::RVec3> {
      const float top = static_cast<float>(center.GetY()) + half_extent.y;
      if (std::abs(anchor.GetY() - (top + kPlayerStandingHeight)) > 0.12f ||
          std::abs(anchor.GetX() - center.GetX()) > half_extent.x + kPlayerRadius ||
          std::abs(anchor.GetZ() - center.GetZ()) > half_extent.z + kPlayerRadius) {
        return std::nullopt;
      }

      const float clearance = kPlayerRadius + 0.12f;
      const std::array<float, 4> edges{
          static_cast<float>(center.GetX()) - half_extent.x - clearance,
          static_cast<float>(center.GetX()) + half_extent.x + clearance,
          static_cast<float>(center.GetZ()) - half_extent.z - clearance,
          static_cast<float>(center.GetZ()) + half_extent.z + clearance,
      };
      const std::array<float, 4> distances{
          std::abs(static_cast<float>(player.GetX()) - edges[0]),
          std::abs(static_cast<float>(player.GetX()) - edges[1]),
          std::abs(static_cast<float>(player.GetZ()) - edges[2]),
          std::abs(static_cast<float>(player.GetZ()) - edges[3]),
      };
      const std::size_t side = static_cast<std::size_t>(
          std::min_element(distances.begin(), distances.end()) - distances.begin());
      JPH::RVec3 lip = player;
      if (side < 2) lip.SetX(edges[side]);
      else lip.SetZ(edges[side]);

      const bool outside = side == 0 ? player.GetX() <= edges[0] + 0.02f
          : side == 1 ? player.GetX() >= edges[1] - 0.02f
          : side == 2 ? player.GetZ() <= edges[2] + 0.02f
                      : player.GetZ() >= edges[3] - 0.02f;
      const float clear_height = top + kPlayerStandingHeight + 0.08f;
      if (player.GetY() < clear_height) {
        if (outside) lip.SetY(clear_height);
        return lip;
      }
      const bool over_platform =
          std::abs(player.GetX() - center.GetX()) <= half_extent.x + kPlayerRadius &&
          std::abs(player.GetZ() - center.GetZ()) <= half_extent.z + kPlayerRadius;
      return over_platform ? std::nullopt : std::optional<JPH::RVec3>{anchor};
    };

    if (auto target = target_for_platform({0.0f, -0.5f, 0.0f},
                                          {config_.platform_half_extent, 0.5f,
                                           config_.platform_half_extent})) {
      return target;
    }
    const auto& bodies = physics_.GetBodyInterface();
    for (std::size_t index = 0; index < obstacle_ids_.size(); ++index) {
      const auto& obstacle = config_.obstacles[index];
      if (!obstacle_ids_[index] || (obstacle.kind != ObstacleKind::StaticPlatform &&
                                   obstacle.kind != ObstacleKind::MovingPlatform &&
                                   obstacle.kind != ObstacleKind::FallingPlatform)) continue;
      if (auto target = target_for_platform(bodies.GetPosition(*obstacle_ids_[index]),
                                            obstacle.half_extent)) {
        return target;
      }
    }
    return std::nullopt;
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
  std::vector<std::optional<JPH::BodyID>> obstacle_ids_;
  std::vector<std::optional<std::uint64_t>> falling_started_ticks_;
  std::vector<PlayerInput> inputs_;
  std::vector<bool> jump_consumed_;
  std::uint64_t tick_{};
  std::uint64_t reset_count_{};
  std::uint64_t elapsed_ticks_{};
  std::size_t checkpoint_{};
  MatchState match_state_{MatchState::Running};
  float tether_tension_{};
};

PrototypeSimulation::PrototypeSimulation()
    : PrototypeSimulation({RobotColor::Blue, RobotColor::Orange}, default_route_config()) {}

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
