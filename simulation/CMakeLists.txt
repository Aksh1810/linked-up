include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CROSS_PLATFORM_DETERMINISTIC ON CACHE BOOL "" FORCE)
set(DEBUG_RENDERER_IN_DEBUG_AND_RELEASE OFF CACHE BOOL "" FORCE)
set(ENABLE_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
set(ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(ENABLE_OBJECT_STREAM OFF CACHE BOOL "" FORCE)
set(GENERATE_DEBUG_SYMBOLS OFF CACHE BOOL "" FORCE)
set(INTERPROCEDURAL_OPTIMIZATION OFF CACHE BOOL "" FORCE)
set(JPH_USE_CPU_COMPUTE OFF CACHE BOOL "" FORCE)
set(JPH_USE_DX12 OFF CACHE BOOL "" FORCE)
set(JPH_USE_MTL OFF CACHE BOOL "" FORCE)
set(JPH_USE_VK OFF CACHE BOOL "" FORCE)
set(OVERRIDE_CXX_FLAGS OFF CACHE BOOL "" FORCE)
set(PROFILER_IN_DEBUG_AND_RELEASE OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  JoltPhysics
  GIT_REPOSITORY https://github.com/jrouwe/JoltPhysics.git
  GIT_TAG v5.6.0
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR Build
)
FetchContent_MakeAvailable(JoltPhysics)

FetchContent_Declare(
  asio
  URL https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-30-2.tar.gz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(asio)
set(ASIO_INCLUDE_DIR "${asio_SOURCE_DIR}/asio/include" CACHE PATH "" FORCE)

set(CROW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CROW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CROW_INSTALL OFF CACHE BOOL "" FORCE)
set(CROW_ENABLE_SSL OFF CACHE BOOL "" FORCE)
set(CROW_ENABLE_COMPRESSION OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  Crow
  GIT_REPOSITORY https://github.com/CrowCpp/Crow.git
  GIT_TAG v1.3.3
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(Crow)

add_library(linked_up_simulation src/prototype_simulation.cpp)
target_compile_features(linked_up_simulation PUBLIC cxx_std_20)
target_include_directories(linked_up_simulation PUBLIC include)
target_link_libraries(linked_up_simulation PUBLIC Jolt)

add_library(linked_up_gameplay_protocol src/gameplay_protocol.cpp)
target_compile_features(linked_up_gameplay_protocol PUBLIC cxx_std_20)
target_include_directories(linked_up_gameplay_protocol PUBLIC include)
target_link_libraries(linked_up_gameplay_protocol PUBLIC linked_up_simulation Crow::Crow)

if(MSVC)
  target_compile_options(linked_up_simulation PRIVATE /W4 /permissive-)
  target_compile_options(linked_up_gameplay_protocol PRIVATE /W4 /permissive-)
else()
  target_compile_options(linked_up_simulation PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(linked_up_gameplay_protocol PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(linked-up-sim src/main.cpp)
target_link_libraries(linked-up-sim PRIVATE linked_up_simulation)

add_executable(linked-up-server src/server_main.cpp src/gameplay_server.cpp)
target_compile_features(linked-up-server PRIVATE cxx_std_20)
target_link_libraries(linked-up-server PRIVATE linked_up_gameplay_protocol Crow::Crow)
if(MSVC)
  target_compile_options(linked-up-server PRIVATE /W4 /permissive-)
else()
  target_compile_options(linked-up-server PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(prototype_simulation_test tests/prototype_simulation_test.cpp)
target_link_libraries(prototype_simulation_test PRIVATE linked_up_simulation)
add_test(NAME authoritative-tether COMMAND prototype_simulation_test)

add_executable(gameplay_protocol_test tests/gameplay_protocol_test.cpp)
target_compile_features(gameplay_protocol_test PRIVATE cxx_std_20)
target_link_libraries(gameplay_protocol_test PRIVATE linked_up_gameplay_protocol)
add_test(NAME gameplay-protocol COMMAND gameplay_protocol_test)
