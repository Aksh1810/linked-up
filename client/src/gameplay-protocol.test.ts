import assert from "node:assert/strict";
import test from "node:test";

import { encodeInput, parseServerMessage } from "./gameplay-protocol.ts";

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

test("input encoding preserves the wire contract", () => {
  assert.equal(
    encodeInput({ sequence: 4, clientTick: 9, moveX: 0.5, moveZ: -1, jump: true }),
    '{"type":"input","sequence":4,"clientTick":9,"moveX":0.5,"moveZ":-1,"jump":true}',
  );
});

test("welcome, snapshot, and error messages are validated", () => {
  const welcome = parseServerMessage(
    '{"type":"welcome","player":"orange","players":["blue","orange"],"tickRate":60,"snapshotRate":20}',
  );
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.player, "orange");

  const snapshot = parseServerMessage(JSON.stringify({
    type: "snapshot",
    tick: 8,
    resetCount: 0,
    tetherTension: 0,
    players: [blue, orange],
  }));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.players[0].acknowledgedInput, 12);
  assert.equal(snapshot.players[1].id, "orange");

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
  }));
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.players.length, 4);
  assert.equal(snapshot.players[2].id, "green");
});

test("malformed authoritative messages are rejected", () => {
  assert.throws(() => parseServerMessage("not json"));
  assert.throws(() => parseServerMessage('{"type":"snapshot","tick":"bad"}'));
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
});
