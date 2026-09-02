cmake_minimum_required(VERSION 3.20)
project(LinkedUp LANGUAGES C CXX)

include(FetchContent)

find_package(OpenSSL REQUIRED)
set(gRPC_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(gRPC_INSTALL OFF CACHE BOOL "" FORCE)
set(protobuf_INSTALL OFF CACHE BOOL "" FORCE)
set(utf8_range_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  grpc
  GIT_REPOSITORY https://github.com/grpc/grpc.git
  GIT_TAG v1.75.1
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(grpc)
add_library(gRPC::grpc++ ALIAS grpc++)
add_executable(gRPC::grpc_cpp_plugin ALIAS grpc_cpp_plugin)

enable_testing()
add_subdirectory(simulation)
