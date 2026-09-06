import assert from "node:assert/strict";
import test from "node:test";

import { describeGameplayStatus, tetherLabel } from "./gameplay-status.ts";
import type { ServerSnapshot } from "./gameplay-protocol.ts";

const snapshot: ServerSnapshot = {
  tick: 10, resetCount: 0, elapsedTicks: 10, checkpoint: 0,
  matchState: "running", tetherTension: 0, obstacles: [],
  players: [
    { id: "blue", position: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true },
    { id: "orange", position: { x: 0, y: -2, z: 0 }, velocity: { x: 0, y: -1, z: 0 }, grounded: false },
  ],
};

test("status explains rescue when a teammate is hanging", () => {
  assert.equal(describeGameplayStatus(snapshot, "blue"), "Orange is hanging — hold Space to climb");
  assert.equal(tetherLabel(0.2), "Linked");
  assert.equal(tetherLabel(0.8), "Stretched");
});

test("checkpoint reset is announced only when the count advances", () => {
  const reset = { ...snapshot, resetCount: 2, players: snapshot.players.map((player) => ({ ...player, grounded: true })) };
  assert.equal(describeGameplayStatus(reset, "blue", 1), "Checkpoint 0 restored");
  assert.equal(describeGameplayStatus(reset, "blue", 2), "Climb together");
});
