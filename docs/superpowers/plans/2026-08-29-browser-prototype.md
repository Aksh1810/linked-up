# Browser Prototype Implementation Plan

> **For agentic workers:** Execute inline. Do not create commits; the user will commit the working tree.

**Goal:** Deliver a locally playable Babylon.js base-camp scene with one robot, WASD/jump, and a third-person mouse camera.

**Architecture:** Keep deterministic motion independent from Babylon rendering. One game module owns the small scene and consumes motion/input state; HTML/CSS provides a minimal accessible overlay.

**Tech Stack:** TypeScript 7.0.2, Vite 8.2.2, Babylon.js 9.23.0, Node built-in test runner

**Spec:** `docs/superpowers/specs/2026-08-29-browser-prototype-design.md`

## Global constraints

- Use primitive geometry and installed/browser-native capabilities.
- Keep WebGPU with WebGL fallback.
- Do not add networking, backend, physics, UI, font, or test-framework dependencies.
- Do not create commits.

### Task 1: Deterministic motion RED/GREEN

**Files:**
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/src/motion.ts`
- Create: `client/src/motion.test.ts`

- [x] Write Node tests for acceleration, normalized diagonal movement, grounded jump, landing, and clamped frame delta.
- [x] Run tests and verify RED because `stepMotion` is missing.
- [x] Implement the smallest pure `stepMotion` function that makes all checks GREEN.

### Task 2: Playable Babylon scene

**Files:**
- Create: `client/index.html`
- Create: `client/src/main.ts`
- Create: `client/src/game.ts`
- Create: `client/src/input.ts`
- Create: `client/src/styles.css`

- [x] Install the three pinned packages and generate the lockfile.
- [x] Build WebGPU-first engine creation with WebGL fallback.
- [x] Create the base-camp world, primitive robot, lighting, follow camera, keyboard controls, and animation derived from motion.
- [x] Add the title, controls, prototype status, and climb rail with responsive/reduced-motion CSS.

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`

- [x] Document client install, test, build, and dev commands.
- [x] Run motion tests, TypeScript checking, and the production build.
- [x] Start Vite with the provided webapp-testing helper, inspect the rendered DOM, run keyboard interaction, capture desktop/mobile screenshots, and check browser logs.
- [x] Inspect all retained files and confirm no unrelated subsystem scaffolding was added.
