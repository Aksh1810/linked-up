import assert from "node:assert/strict";
import test from "node:test";

import { encodeInput, parseServerMessage } from "./gameplay-protocol.ts";
import { obstacleAppearance, obstacleDimensions, obstaclePresentation } from "./world-blockout.ts";

const blue = {
  id: "blue",
  acknowledgedInput: 12,
  position: { x: -1, y: 1, z: 0 },
  velocity: { x: 0.5, y: 0, z: 0 },
  grounded: true,
};
const orange = {
  id: "orange",
  acknowledgedInput: 9,
  position: { x: 1, y: 1, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true,
};
const green = {
  id: "green",
  acknowledgedInput: 7,
  position: { x: 2, y: 1, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true,
};
const purple = {
  id: "purple",
  acknowledgedInput: 5,
  position: { x: 3, y: 1, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true,
};

const world = {
  matchState: "running", elapsedTicks: 8, checkpoint: 0,
  obstacles: [{
    id: "grass-ledge-1", kind: "staticPlatform", zone: "grass", phase: "armed",
    halfExtent: { x: 4, y: 0.4, z: 3 },
    position: { x: 0, y: 1.8, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
  }],
};

test("input encoding preserves the wire contract", () => {
  assert.equal(
    encodeInput({ sequence: 4, clientTick: 9, moveX: 0.5, moveZ: -1, jump: true }),
    '{"type":"input","sequence":4,"clientTick":9,"moveX":0.5,"moveZ":-1,"jump":true}',
  );
});

test("obstacle meshes use authoritative half extents", () => {
  assert.deepEqual(obstacleDimensions({ x: 4, y: 0.4, z: 3 }), {
    width: 8, height: 0.8, depth: 6,
  });
});

test("obstacle appearance keeps zone depth while highlighting hazards", () => {
  assert.deepEqual(obstacleAppearance("grass", "staticPlatform"), {
    base: "#456852", top: "#527f5a",
  });
  assert.deepEqual(obstacleAppearance("industrial", "rotatingBeam"), {
    base: "#39495b", top: "#ef7d57",
  });
});

test("hazard presentation distinguishes force volumes, motion, beams, and warnings", () => {
  assert.deepEqual(obstaclePresentation("fan", "armed", false), {
    opacity: 0.2, wireframe: true, directional: true, hub: false, warning: false, shake: false,
  });
  assert.equal(obstaclePresentation("conveyor", "armed", false).directional, true);
  assert.equal(obstaclePresentation("movingPlatform", "armed", false).directional, true);
  assert.equal(obstaclePresentation("rotatingBeam", "armed", false).hub, true);
  assert.equal(obstaclePresentation("fallingPlatform", "warning", false).warning, true);
  assert.equal(obstaclePresentation("fallingPlatform", "warning", false).shake, true);
  assert.equal(obstaclePresentation("fallingPlatform", "warning", true).shake, false);
});

test("welcome, snapshot, and error messages are validated", () => {
  const welcome = parseServerMessage(
    '{"type":"welcome","player":"orange","players":["blue","orange"],"tickRate":60,"snapshotRate":20,"mapId":"windworks"}',
  );
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.player, "orange");
  assert.equal(welcome.mapId, "windworks");

  const snapshot = parseServerMessage(JSON.stringify({
    type: "snapshot",
    tick: 8,
    resetCount: 0,
    tetherTension: 0,
    players: [blue, orange],
    ...world,
  }));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.players[0].acknowledgedInput, 12);
  assert.equal(snapshot.players[1].id, "orange");
  assert.equal(snapshot.obstacles[0].zone, "grass");
  assert.equal(snapshot.obstacles[0].halfExtent.x, 4);

  const error = parseServerMessage(
    '{"type":"error","code":"slot_taken","message":"That player is already connected."}',
  );
  assert.equal(error.type, "error");
  assert.equal(error.code, "slot_taken");
});

test("authoritative snapshots accept a unique two-to-four player roster", () => {
  const snapshot = parseServerMessage(JSON.stringify({
    type: "snapshot", tick: 8, resetCount: 0, tetherTension: 0.2,
    players: [blue, orange, green, purple],
    ...world,
  }));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.players.length, 4);
  assert.equal(snapshot.players[2].id, "green");
});

test("malformed authoritative messages are rejected", () => {
  assert.throws(() => parseServerMessage("not json"));
  assert.throws(() => parseServerMessage('{"type":"snapshot","tick":"bad"}'));
  assert.throws(() => parseServerMessage(
    '{"type":"welcome","player":"orange","players":["blue","orange"],"tickRate":60,"snapshotRate":20,"mapId":"unknown"}',
  ));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot",
    tick: 8,
    resetCount: 0,
    tetherTension: 0,
    players: [blue, blue],
  })));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot",
    tick: 8,
    resetCount: 0,
    tetherTension: 0,
    players: [{ ...blue, acknowledgedInput: undefined }, orange],
  })));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot",
    tick: 8,
    resetCount: 0,
    tetherTension: 0,
    players: [{ ...blue, acknowledgedInput: -1 }, orange],
  })));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot", tick: 8, resetCount: 0, tetherTension: 0, players: [blue],
  })));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot", tick: 8, resetCount: 0, tetherTension: 0,
    players: [blue, orange, green, purple, blue],
  })));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot", tick: 8, resetCount: 0, tetherTension: 0, players: [blue, orange],
  }), ["orange", "blue"]));
  assert.throws(() => parseServerMessage(
    '{"type":"snapshot","tick":8,"resetCount":0,"tetherTension":0,"players":[{"id":"blue","acknowledgedInput":0,"position":{"x":1e999,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true},{"id":"orange","acknowledgedInput":0,"position":{"x":1,"y":1,"z":0},"velocity":{"x":0,"y":0,"z":0},"grounded":true}]}',
  ));
  assert.throws(() => parseServerMessage(JSON.stringify({
    type: "snapshot", tick: 8, resetCount: 0, tetherTension: 0, players: [blue, orange],
    ...world,
    obstacles: [{ ...world.obstacles[0], halfExtent: { x: 0, y: 0.4, z: 3 } }],
  })));
});
