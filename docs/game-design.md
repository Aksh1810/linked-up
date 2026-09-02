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

## Lobby

Phase 6 supports temporary rooms for two to four players. Creating a room
assigns the host Blue Robot; invite links fill Orange, Green, and Purple in
order. Everyone sees joins and leaves live. Only the host sees Start Game, and
it becomes available when the selected room is full. If the host leaves, the
first remaining player becomes host without a reload.

Starting changes the room to `Starting` and shows `Preparing match...` to the
whole crew. Phase 6 intentionally stops there: match assignment, gameplay
tickets, and navigation into the C++ simulation require Phase 7 design
approval. The preserved direct Blue and Orange gameplay pages remain the way
to exercise the current playable slice.

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
