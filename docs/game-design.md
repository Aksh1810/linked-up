# Game design

Linked-Up is a playful 2–4 player cooperative climb intended to last roughly
ten minutes. Color-coded low-poly robots share a glowing tether, so movement,
jumps, and falls create consequences for the whole group.

## Controls

- WASD: move
- Space: jump
- Mouse: third-person camera

The v1 scope excludes grabbing, stamina, combat, accounts, progression,
cosmetics, chat, and persistent history.

## Tether

The authoritative simulation applies no force while the tether is slack. Past
the slack length, spring and damping forces grow up to a configurable cap. A
hard maximum distance protects simulation stability. The browser will render
slack, glow, strain, and yank reactions from authoritative tension state.

The current prototype supports two players. Three- and four-player topology is
kept as a later playtesting decision rather than buried in premature code.

## World

The final game contains one continuous vertical course with checkpoints:

1. Grass tutorial area
2. Construction
3. Industrial
4. Sky
5. Summit

Reusable obstacles include static and moving platforms, rotating and swinging
beams, elevators, fans, conveyors, and falling platforms. Full-team failure
quickly resets the current checkpoint; completion requires the linked group to
reach the summit condition.
