import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkerProtocolError,
  parseWorkerCommand,
  parseWorkerEvent,
  snapshotTicksAfterAdvance,
} from "./simulation-worker-protocol.ts";

test("worker commands use exact validated schemas", () => {
  assert.deepEqual(parseWorkerCommand({
    type: "initialize", mapId: "windworks", roster: ["blue", "orange"],
  }), { type: "initialize", mapId: "windworks", roster: ["blue", "orange"] });
  assert.deepEqual(parseWorkerCommand({
    type: "input", player: "orange",
    input: { sequence: 4, clientTick: 3, moveX: -1, moveZ: 0.5, jump: true },
  }), {
    type: "input", player: "orange",
    input: { sequence: 4, clientTick: 3, moveX: -1, moveZ: 0.5, jump: true },
  });
  assert.deepEqual(parseWorkerCommand({ type: "advance", steps: 8 }), { type: "advance", steps: 8 });
  assert.deepEqual(parseWorkerCommand({ type: "dispose" }), { type: "dispose" });
  assert.throws(() => parseWorkerCommand({ type: "advance", steps: 9 }), WorkerProtocolError);
  assert.throws(() => parseWorkerCommand({ type: "dispose", extra: true }), WorkerProtocolError);
  assert.throws(() => parseWorkerCommand({
    type: "initialize", mapId: "windworks", roster: ["blue", "blue"],
  }), WorkerProtocolError);
});

test("worker events use stable public errors and validated snapshots", () => {
  assert.deepEqual(parseWorkerEvent({ type: "ready" }), { type: "ready" });
  assert.deepEqual(parseWorkerEvent({ type: "finished", elapsedTicks: 120 }), {
    type: "finished", elapsedTicks: 120,
  });
  assert.deepEqual(parseWorkerEvent({
    type: "error", code: "initialization-failed", message: "Could not start the match simulation.",
  }), {
    type: "error", code: "initialization-failed", message: "Could not start the match simulation.",
  });
  assert.throws(() => parseWorkerEvent({
    type: "error", code: "initialization-failed", message: "internal stack trace",
  }), WorkerProtocolError);
});

test("snapshot cadence is every third authoritative tick", () => {
  assert.deepEqual(snapshotTicksAfterAdvance(0, 8), [3, 6]);
  assert.deepEqual(snapshotTicksAfterAdvance(8, 4), [9, 12]);
  assert.deepEqual(snapshotTicksAfterAdvance(12, 0), []);
});
