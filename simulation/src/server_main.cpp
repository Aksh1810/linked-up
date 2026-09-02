#include "linked_up/gameplay_server.hpp"

#include <charconv>
#include <cstdlib>
#include <iostream>
#include <string_view>

namespace {

bool load_port(const char* variable, std::uint16_t& target) {
  if (const char* value = std::getenv(variable)) {
    unsigned port = 0;
    const std::string_view text{value};
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), port);
    if (error != std::errc{} || end != text.data() + text.size() || port == 0 || port > 65535) {
      std::cerr << variable << " must be an integer from 1 to 65535\n";
      return false;
    }
    target = static_cast<std::uint16_t>(port);
  }
  return true;
}

}  // namespace

int main() {
  linked_up::GameplayServerConfig config;
  if (!load_port("LINKED_UP_GAMEPLAY_PORT", config.port) ||
      !load_port("LINKED_UP_COORDINATION_PORT", config.coordination_port)) {
    return EXIT_FAILURE;
  }

  std::cout << "Match coordinator listening at 127.0.0.1:" << config.coordination_port << '\n';
  std::cout << "Gameplay server listening at ws://127.0.0.1:" << config.port << "/game\n";
  linked_up::GameplayServer server(config);
  server.run();
}
