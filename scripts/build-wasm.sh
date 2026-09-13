#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wasm_build="$project_root/build-wasm"
native_build="$project_root/build-native-parity"
output_dir="$project_root/client/src/wasm"
export EM_CACHE="$wasm_build/emscripten-cache"
mkdir -p "$EM_CACHE"

emcmake cmake -S "$project_root/simulation/wasm" -B "$wasm_build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$wasm_build" -j 4
cmake -S "$project_root/simulation/wasm" -B "$native_build" -DCMAKE_BUILD_TYPE=Debug \
  -DFETCHCONTENT_SOURCE_DIR_JOLTPHYSICS="$wasm_build/_deps/joltphysics-src"
cmake --build "$native_build" --target prototype_simulation_test -j 4
mkdir -p "$output_dir"
cp "$wasm_build/linked-up-simulation.js" "$output_dir/linked-up-simulation.js"
cp "$wasm_build/linked-up-simulation.wasm" "$output_dir/linked-up-simulation.wasm"
chmod 644 "$output_dir/linked-up-simulation.js" "$output_dir/linked-up-simulation.wasm"

manifest_tmp="$(mktemp)"
{
  echo '{'
  echo '  "joltTag": "v5.6.0",'
  echo '  "sources": {'
  echo "    \"simulation/src/prototype_simulation.cpp\": \"$(shasum -a 256 "$project_root/simulation/src/prototype_simulation.cpp" | awk '{print $1}')\","
  echo "    \"simulation/include/linked_up/prototype_simulation.hpp\": \"$(shasum -a 256 "$project_root/simulation/include/linked_up/prototype_simulation.hpp" | awk '{print $1}')\","
  echo "    \"simulation/wasm/wasm_bridge.cpp\": \"$(shasum -a 256 "$project_root/simulation/wasm/wasm_bridge.cpp" | awk '{print $1}')\","
  echo "    \"simulation/wasm/CMakeLists.txt\": \"$(shasum -a 256 "$project_root/simulation/wasm/CMakeLists.txt" | awk '{print $1}')\""
  echo '  }'
  echo '}'
} > "$manifest_tmp"
mv "$manifest_tmp" "$output_dir/source-manifest.json"
chmod 644 "$output_dir/source-manifest.json"
