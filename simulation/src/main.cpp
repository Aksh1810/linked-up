#include <iomanip>
#include <iostream>

#include "linked_up/prototype_simulation.hpp"

int main() {
  linked_up::Config config;
  config.platform_half_extent = 3.0f;
  linked_up::PrototypeSimulation simulation(config);
  std::cout << "Linked-Up authoritative tether prototype (60 Hz)\n";

  for (int tick = 0; tick < 600; ++tick) {
    if (tick < 180) {
      simulation.set_input(linked_up::PlayerId::Blue, {-1.0f, 0.0f, false});
      simulation.set_input(linked_up::PlayerId::Orange, {1.0f, 0.0f, false});
    } else {
      simulation.set_input(linked_up::PlayerId::Blue, {});
      simulation.set_input(linked_up::PlayerId::Orange, {1.0f, 0.0f, false});
    }
    simulation.step();

    if (tick % 30 == 0) {
      const auto state = simulation.snapshot();
      const auto& blue = state.players[0].position;
      const auto& orange = state.players[1].position;
      std::cout << "tick=" << std::setw(3) << state.tick << std::fixed << std::setprecision(2)
                << " distance=" << state.separation << " tension=" << state.tether_tension
                << " blue=(" << blue.x << ',' << blue.y << ',' << blue.z << ") orange=(" << orange.x
                << ',' << orange.y << ',' << orange.z << ") resets=" << state.reset_count << '\n';
    }
  }
}
