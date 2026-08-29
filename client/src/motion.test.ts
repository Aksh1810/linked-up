import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraRelativeMovement,
  createMotionState,
  defaultMotionConfig,
  stepMotion,
  worldMovement,
} from "./motion.ts";

test("WASD follows the ArcRotate camera heading", () => {
  const initialForward = cameraRelativeMovement({ x: 0, z: 1 }, -Math.PI / 2);
  assert(Math.abs(initialForward.x) < 0.0001);
  assert(Math.abs(initialForward.z - 1) < 0.0001);

  const quarterTurnForward = cameraRelativeMovement({ x: 0, z: 1 }, 0);
  assert(Math.abs(quarterTurnForward.x + 1) < 0.0001);
  assert(Math.abs(quarterTurnForward.z) < 0.0001);

  const quarterTurnRight = cameraRelativeMovement({ x: 1, z: 0 }, 0);
  assert(Math.abs(quarterTurnRight.x) < 0.0001);
  assert(Math.abs(quarterTurnRight.z - 1) < 0.0001);

  const oppositeForward = cameraRelativeMovement({ x: 0, z: 1 }, Math.PI / 2);
  assert(Math.abs(oppositeForward.x) < 0.0001);
  assert(Math.abs(oppositeForward.z + 1) < 0.0001);
});

test("camera-relative movement is normalized in world space", () => {
  const forward = worldMovement({ x: 0, z: 1 }, Math.PI / 2);
  assert(Math.abs(forward.x - 1) < 0.0001);
  assert(Math.abs(forward.z) < 0.0001);

  const diagonal = worldMovement({ x: 1, z: 1 }, 0);
  assert(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 0.0001);
});

test("movement accelerates in the camera-facing direction", () => {
  const next = stepMotion(
    createMotionState(),
    { x: 0, z: 1, jumpPressed: false },
    0,
    1 / 60,
  );

  assert(next.velocity.z > 0);
  assert(next.position.z > 0);
  assert.equal(next.velocity.x, 0);
});

test("diagonal input cannot exceed maximum horizontal speed", () => {
  let state = createMotionState();
  for (let frame = 0; frame < 120; frame += 1) {
    state = stepMotion(
      state,
      { x: 1, z: 1, jumpPressed: false },
      0,
      1 / 60,
    );
  }

  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  assert(speed >= defaultMotionConfig.maxSpeed - 0.0001);
  assert(speed <= defaultMotionConfig.maxSpeed + 0.0001);
});

test("jumping leaves the floor only while grounded", () => {
  const jumped = stepMotion(
    createMotionState(),
    { x: 0, z: 0, jumpPressed: true },
    0,
    1 / 60,
  );
  const repeated = stepMotion(
    jumped,
    { x: 0, z: 0, jumpPressed: true },
    0,
    1 / 60,
  );

  assert(jumped.velocity.y > 0);
  assert.equal(jumped.grounded, false);
  assert(repeated.velocity.y < jumped.velocity.y);
});

test("falling lands on the configured floor", () => {
  const state = createMotionState();
  state.position.y = defaultMotionConfig.floorHeight + 0.1;
  state.velocity.y = -10;
  state.grounded = false;

  const landed = stepMotion(
    state,
    { x: 0, z: 0, jumpPressed: false },
    0,
    0.05,
  );

  assert.equal(landed.position.y, defaultMotionConfig.floorHeight);
  assert.equal(landed.velocity.y, 0);
  assert.equal(landed.grounded, true);
});

test("large frame deltas are clamped before integration", () => {
  const config = {
    ...defaultMotionConfig,
    acceleration: 100,
    maxSpeed: 100,
  };
  const next = stepMotion(
    createMotionState(config),
    { x: 1, z: 0, jumpPressed: false },
    0,
    10,
    config,
  );

  assert.equal(next.velocity.x, 5);
  assert.equal(next.position.x, 0.25);
});
