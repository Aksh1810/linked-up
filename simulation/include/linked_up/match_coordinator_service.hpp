#pragma once

#include <grpcpp/grpcpp.h>

#include "linked_up/match/v1/match_service.grpc.pb.h"
#include "linked_up/match_manager.hpp"

namespace linked_up {

class MatchCoordinatorService final : public linkedup::match::v1::MatchCoordinator::Service {
 public:
  explicit MatchCoordinatorService(MatchManager& matches);

  grpc::Status CreateMatch(
      grpc::ServerContext*, const linkedup::match::v1::CreateMatchRequest*,
      linkedup::match::v1::CreateMatchResponse*) override;
  grpc::Status DestroyMatch(
      grpc::ServerContext*, const linkedup::match::v1::DestroyMatchRequest*,
      linkedup::match::v1::DestroyMatchResponse*) override;

 private:
  MatchManager& matches_;
};

}  // namespace linked_up
