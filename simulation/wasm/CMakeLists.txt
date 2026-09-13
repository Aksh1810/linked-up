cmake_minimum_required(VERSION 3.20)
project(LinkedUpWasm LANGUAGES CXX)

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

if(EMSCRIPTEN)
  add_executable(linked-up-simulation
    ../src/prototype_simulation.cpp
    wasm_bridge.cpp
  )
  target_compile_features(linked-up-simulation PRIVATE cxx_std_20)
  target_include_directories(linked-up-simulation PRIVATE ../include)
  target_link_libraries(linked-up-simulation PRIVATE Jolt)
  target_compile_options(linked-up-simulation PRIVATE -Wall -Wextra -Wpedantic -fexceptions)
  target_link_options(linked-up-simulation PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createLinkedUpSimulation"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sSTACK_SIZE=1MB"
    "-sFILESYSTEM=0"
    "-sDISABLE_EXCEPTION_CATCHING=0"
    "-sENVIRONMENT=web,worker,node"
    "-sEXPORTED_FUNCTIONS=['_lu_create','_lu_set_input','_lu_step','_lu_snapshot','_lu_destroy']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','UTF8ToString']"
  )
  set_target_properties(linked-up-simulation PROPERTIES SUFFIX ".js")
else()
  add_executable(prototype_simulation_test
    ../src/prototype_simulation.cpp
    ../tests/prototype_simulation_test.cpp
  )
  target_compile_features(prototype_simulation_test PRIVATE cxx_std_20)
  target_include_directories(prototype_simulation_test PRIVATE ../include)
  target_link_libraries(prototype_simulation_test PRIVATE Jolt)
  target_compile_options(prototype_simulation_test PRIVATE -Wall -Wextra -Wpedantic)
endif()
