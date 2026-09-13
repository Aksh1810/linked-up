import assert from "node:assert/strict";
import test from "node:test";

import { encodePeerMessage, parsePeerMessage } from "./peer-protocol.ts";

const input = { kind: "input" as const, sequence: 4, clientTick: 8, moveX: 0.5, moveZ: -1, jump: true };
const snapshot = {
  kind: "snapshot" as const,
  snapshot: {
    type: "snapshot" as const, tick: 8, resetCount: 0, tetherTension: 0,
    players: [
      { id: "blue" as const, acknowledgedInput: 4, position: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true },
      { id: "orange" as const, acknowledgedInput: 2, position: { x: 1, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true },
    ],
    matchState: "running" as const, elapsedTicks: 8, checkpoint: 0, obstacles: [],
  },
};

test("binary control, input, and snapshot messages round trip", () => {
  const control = { kind: "hello" as const, protocol: 1 as const, playerId: "blue" as const, mapId: "windworks" as const };
  assert.deepEqual(parsePeerMessage(encodePeerMessage(control)), control);
  assert.deepEqual(parsePeerMessage(encodePeerMessage(input)), input);
  assert.deepEqual(parsePeerMessage(encodePeerMessage(snapshot)), snapshot);
});

test("codec rejects unknown keys, stale input, and protocol mismatch", () => {
  assert.throws(() => encodePeerMessage({ ...input, playerId: "blue" } as never));
  assert.throws(() => parsePeerMessage(encodePeerMessage(input), { lastInputSequence: 4 }));
  assert.throws(() => encodePeerMessage({ kind: "hello", protocol: 2, playerId: "blue", mapId: "windworks" } as never));
});

test("codec enforces input and snapshot caps and fatal UTF-8", () => {
  const oversizedInput = new Uint8Array(513);
  oversizedInput[0] = 2;
  assert.throws(() => parsePeerMessage(oversizedInput));
  const oversizedSnapshot = new Uint8Array(256 * 1_024 + 1);
  oversizedSnapshot[0] = 3;
  assert.throws(() => parsePeerMessage(oversizedSnapshot));
  assert.throws(() => parsePeerMessage(Uint8Array.from([1, 0xff, 0xfe])));
});
