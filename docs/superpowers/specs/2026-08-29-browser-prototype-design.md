# Browser Prototype Design

Date: 2026-08-29
Status: Approved for implementation by continuation of the master plan

## Goal

Prove that a player can open Linked-Up locally, immediately control one simple
robot with WASD and Space, and rotate a smooth third-person camera with the
mouse inside a small Babylon.js base-camp scene.

## Scope

- Vanilla TypeScript and Vite; no application framework
- Babylon.js WebGPU when supported, WebGL fallback
- One low-poly robot assembled from primitive meshes
- Floor, a few platform/rock/tree primitives, sky, and simple lighting
- Deterministic local movement, gravity, jump, and floor landing
- Arc-rotate third-person mouse camera following the robot
- Minimal responsive HUD with controls and prototype status
- One Node built-in test file for motion logic

No networking, second player, tether physics, lobby, assets, audio, mobile
controls, or final world content is implemented in this slice.

## Visual direction

Subject: a playful robot arriving at the safe grassy base camp beneath a huge
climb. The page's single job is to get the player moving immediately.

Palette:

- Open sky `#8fd9ff`
- Cloud white `#f4fbff`
- Grass `#65c66a`
- Utility navy `#10243a`
- Robot blue `#38bdf8`
- Teammate orange `#ff914d`

Typography uses installed rounded system faces for the playful display role,
the normal system UI stack for instructions, and the system monospace stack
for compact status labels. No font download is added.

The canvas fills the viewport. A small title plate sits top-left, controls sit
bottom-left, and a narrow five-zone climb rail sits right. The rail is the one
signature element: it makes the course's upward promise visible while the
prototype remains at Base Camp. HUD plates use clipped corners like reusable
robot equipment tags, not generic glass cards.

## Code boundaries

- `main.ts` creates the app and reports startup errors.
- `game.ts` owns Babylon engine, scene, render loop, camera, world, and robot
  presentation.
- `motion.ts` owns deterministic player movement with no Babylon dependency.
- `input.ts` converts keyboard events into movement and jump-edge input.
- `styles.css` owns the viewport and accessible HUD.

`motion.ts` accepts a state, normalized input, camera yaw, delta time, and
configuration. It returns the next state. Delta time is clamped to protect
against inactive-tab spikes. Diagonal input is normalized; jump fires only
while grounded; gravity and the floor are deterministic.

## Verification

- Node tests prove acceleration, diagonal normalization, jumping, landing,
  and delta-time clamping.
- `tsc --noEmit` and Vite production build pass.
- A browser smoke test loads the scene without page errors, confirms the HUD
  and canvas, sends movement/jump input, and captures a screenshot.
- Visual review checks desktop and narrow viewport layouts plus reduced-motion
  behavior.
