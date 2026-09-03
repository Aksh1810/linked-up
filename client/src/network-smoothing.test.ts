import assert from "node:assert/strict";
import test from "node:test";

import type { NetworkPlayerState, ServerSnapshot } from "./gameplay-protocol.ts";
import {
  defaultSmoothingConfig,
  PredictionReconciler,
  SnapshotBuffer,
} from "./network-smoothing.ts";

function snapshotAt(tick: number, orangeX: number, resetCount = 0): ServerSnapshot {
  return {
    type: "snapshot",
    tick,
    resetCount,
    tetherTension: orangeX / 10,
    matchState: "running",
    elapsedTicks: tick,
    checkpoint: 0,
    obstacles: [],
    players: [
      {
        id: "blue",
        acknowledgedInput: 0,
        position: { x: 0, y: 1, z: 0 },
        velocity: { x: 1, y: 0, z: 0 },
        grounded: true,
      },
      {
        id: "orange",
        acknowledgedInput: tick,
        position: { x: orangeX, y: 1 + orangeX, z: -orangeX },
        velocity: { x: 0, y: orangeX, z: orangeX * 2 },
        grounded: tick >= 106,
      },
    ],
  };
}

function localSnapshot(
  tick: number,
  x = 0,
  acknowledgedInput = 0,
  resetCount = 0,
): ServerSnapshot {
  const snapshot = snapshotAt(tick, 0, resetCount);
  snapshot.players[0] = {
    ...snapshot.players[0],
    acknowledgedInput,
    position: { ...snapshot.players[0].position, x },
  };
  return snapshot;
}

test("snapshot buffer interpolates numeric state and selects newer discrete state at midpoint", () => {
  const buffer = new SnapshotBuffer({
    ...defaultSmoothingConfig,
    interpolationDelayTicks: 6,
  });
  assert(buffer.push(snapshotAt(100, 0), 1_000));
  assert(buffer.push(snapshotAt(106, 6), 1_100));

  const midpoint = buffer.sample(1_150, 60);
  assert(midpoint);
  assert.equal(midpoint.tick, 103);
  assert.equal(midpoint.players[1].position.x, 3);
  assert.equal(midpoint.players[1].position.y, 4);
  assert.equal(midpoint.players[1].velocity.z, 6);
  assert.equal(midpoint.players[1].grounded, true);
  assert.equal(midpoint.players[1].acknowledgedInput, 106);
  assert.equal(midpoint.tetherTension, 0.3);
});

test("snapshot interpolation keeps each dynamic player matched by ID", () => {
  const buffer = new SnapshotBuffer({ ...defaultSmoothingConfig, interpolationDelayTicks: 6 });
  const dynamic = (tick: number, greenX: number): ServerSnapshot => ({
    type: "snapshot", tick, resetCount: 0, tetherTension: 0,
    matchState: "running", elapsedTicks: tick, checkpoint: 0, obstacles: [],
    players: [
      ...snapshotAt(tick, 0).players,
      {
        id: "green",
        acknowledgedInput: tick,
        position: { x: greenX, y: 1, z: 0 },
        velocity: { x: greenX, y: 0, z: 0 },
        grounded: true,
      } as NetworkPlayerState,
    ],
  });
  assert(buffer.push(dynamic(100, 0), 1_000));
  assert(buffer.push(dynamic(106, 6), 1_100));

  const midpoint = buffer.sample(1_150, 60)!;
  assert.equal(midpoint.players.find((player) => player.id === "green")!.position.x, 3);
});

test("snapshot buffer holds endpoints instead of extrapolating", () => {
  const buffer = new SnapshotBuffer();
  const oldest = snapshotAt(100, 0);
  const newest = snapshotAt(106, 6);
  buffer.push(oldest, 1_000);
  buffer.push(newest, 1_100);

  assert.equal(buffer.sample(1_000, 60), oldest);
  assert.equal(buffer.sample(1_400, 60), newest);
});

test("snapshot buffer rejects stale delivery and clears on a newer reset", () => {
  const buffer = new SnapshotBuffer();
  assert(buffer.push(snapshotAt(100, 0), 1_000));
  assert.equal(buffer.push(snapshotAt(100, 1), 1_010), false);
  assert.equal(buffer.push(snapshotAt(99, 1), 1_020), false);
  assert(buffer.push(snapshotAt(0, 0, 1), 1_030));
  assert.equal(buffer.push(snapshotAt(200, 2, 0), 1_040), false);
  assert.equal(buffer.latest?.tick, 0);
  assert.equal(buffer.latest?.resetCount, 1);
});

test("snapshot buffer retains only its fixed capacity", () => {
  const buffer = new SnapshotBuffer({
    ...defaultSmoothingConfig,
    interpolationDelayTicks: 100,
    maxSnapshots: 32,
  });
  for (let tick = 1; tick <= 33; ++tick) {
    assert(buffer.push(snapshotAt(tick, tick), tick));
  }

  assert.equal(buffer.sample(33, 60)?.tick, 2);
  assert.equal(buffer.latest?.tick, 33);
});

test("snapshot buffer rejects invalid configuration", () => {
  assert.throws(
    () => new SnapshotBuffer({ ...defaultSmoothingConfig, maxSnapshots: 0 }),
    RangeError,
  );
});

test("local prediction responds immediately and removes acknowledged input", () => {
  const predictor = new PredictionReconciler("blue", 60);
  const baseline = localSnapshot(100);
  predictor.reconcile(baseline);
  predictor.record({
    sequence: 1,
    clientTick: 1,
    moveX: 1,
    moveZ: 0,
    jump: false,
  });

  assert(predictor.renderState()!.position.x > baseline.players[0].position.x);
  assert.equal(predictor.pendingCount, 1);

  predictor.reconcile(localSnapshot(103, 0.02, 1));
  assert.equal(predictor.pendingCount, 0);
});

test("local prediction replays only unacknowledged input", () => {
  const predictor = new PredictionReconciler("blue", 60);
  predictor.reconcile(localSnapshot(100));
  predictor.record({ sequence: 2, clientTick: 2, moveX: 1, moveZ: 0, jump: false });
  predictor.record({ sequence: 3, clientTick: 3, moveX: 1, moveZ: 0, jump: false });

  predictor.reconcile(localSnapshot(103, 0, 2));
  predictor.advanceCorrection(1_000);
  assert.equal(predictor.pendingCount, 1);
  assert(predictor.renderState()!.position.x > 0);
});

test("local prediction applies jump immediately", () => {
  const predictor = new PredictionReconciler("blue", 60);
  predictor.reconcile(localSnapshot(100));
  predictor.record({ sequence: 1, clientTick: 1, moveX: 0, moveZ: 0, jump: true });

  assert(predictor.renderState()!.velocity.y > 0);
});

test("local prediction does not invent a floor while the server says the player is falling", () => {
  const predictor = new PredictionReconciler("blue", 60);
  const falling = localSnapshot(100);
  falling.players[0] = {
    ...falling.players[0],
    position: { x: 0, y: 0.5, z: 0 },
    velocity: { x: 0, y: -2, z: 0 },
    grounded: false,
  };
  predictor.reconcile(falling);
  predictor.record({ sequence: 1, clientTick: 1, moveX: 0, moveZ: 0, jump: false });

  assert(predictor.renderState()!.position.y < falling.players[0].position.y);
  assert.equal(predictor.renderState()!.grounded, false);
});

test("small reconciliation preserves display then halves its correction after 80 ms", () => {
  const predictor = new PredictionReconciler("blue", 60);
  predictor.reconcile(localSnapshot(100));
  predictor.record({ sequence: 1, clientTick: 1, moveX: 1, moveZ: 0, jump: false });
  const oldDisplay = predictor.renderState()!.position.x;

  predictor.reconcile(localSnapshot(103, 0.2, 1));
  assert(Math.abs(predictor.renderState()!.position.x - oldDisplay) < 1e-12);

  predictor.advanceCorrection(80);
  const remaining = Math.abs(predictor.renderState()!.position.x - 0.2);
  assert(Math.abs(remaining - Math.abs(oldDisplay - 0.2) / 2) < 1e-12);
});

test("large reconciliation snaps without a presentation offset", () => {
  const predictor = new PredictionReconciler("blue", 60);
  predictor.reconcile(localSnapshot(100));
  predictor.reconcile(localSnapshot(103, 3));

  assert.equal(predictor.renderState()!.position.x, 3);
});

test("a newer reset clears pending input and correction", () => {
  const predictor = new PredictionReconciler("blue", 60);
  predictor.reconcile(localSnapshot(100));
  predictor.record({ sequence: 1, clientTick: 1, moveX: 1, moveZ: 0, jump: false });
  predictor.reconcile(localSnapshot(0, 5, 0, 1));

  assert.equal(predictor.pendingCount, 0);
  assert.equal(predictor.renderState()!.position.x, 5);
});

test("pending input overflow waits for the next authoritative baseline", () => {
  const predictor = new PredictionReconciler("blue", 60, {
    ...defaultSmoothingConfig,
    maxPendingInputs: 2,
  });
  predictor.reconcile(localSnapshot(100));
  for (let sequence = 1; sequence <= 3; ++sequence) {
    predictor.record({ sequence, clientTick: sequence, moveX: 1, moveZ: 0, jump: false });
  }

  assert.equal(predictor.pendingCount, 0);
  predictor.reconcile(localSnapshot(103, 4));
  assert.equal(predictor.renderState()!.position.x, 4);
});
