#include "linked_up/gameplay_server.hpp"

#include <charconv>
#include <cstdlib>
#include <iostream>
#include <string_view>

int main() {
  linked_up::GameplayServerConfig config;
  if (const char* value = std::getenv("LINKED_UP_GAMEPLAY_PORT")) {
    unsigned port = 0;
    const std::string_view text{value};
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), port);
    if (error != std::errc{} || end != text.data() + text.size() || port == 0 || port > 65535) {
      std::cerr << "LINKED_UP_GAMEPLAY_PORT must be an integer from 1 to 65535\n";
      return EXIT_FAILURE;
    }
    config.port = static_cast<std::uint16_t>(port);
  }

  std::cout << "Gameplay server listening at ws://127.0.0.1:" << config.port << "/game\n";
  linked_up::GameplayServer server(config);
  server.run();
}
