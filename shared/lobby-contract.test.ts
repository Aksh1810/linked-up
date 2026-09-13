import assert from "node:assert/strict";
import test from "node:test";

import {
  isMapId,
  mapName,
  normalizeRoomCode,
  parseRoom,
  type RoomState,
} from "./lobby-contract.ts";

const waiting: RoomState = {
  id: "8f0b648f-90b2-44d9-a6a7-aac07430c4e4",
  code: "XK72",
  capacity: 2,
  status: "waiting",
  createdAt: "2026-08-30T12:00:00.000Z",
  version: 1,
  mapId: "classic-ascent",
  matchId: null,
  players: [
    { id: "c7a17aa1-5131-4652-8f9e-e1d5dcb1f66b", name: "Blue Robot", color: "blue", isHost: true },
    { id: "6b19b4a6-aab4-4c14-9dbd-7b1aefccec08", name: "Orange Robot", color: "orange", isHost: false },
  ],
};

const matchId = "4a342322-1f6d-4662-b6c1-9f48dd6015e9";

test("parses each public room status and requires match IDs after waiting", () => {
  assert.deepEqual(parseRoom(waiting), waiting);

  const starting = parseRoom({ ...waiting, status: "starting", matchId });
  assert.equal(starting.matchId, matchId);
  assert.throws(() => parseRoom({ ...waiting, status: "starting", matchId: null }));

  const inGame = parseRoom({ ...waiting, status: "inGame", matchId });
  assert.equal(inGame.status, "inGame");
  assert.throws(() => parseRoom({ ...waiting, status: "inGame", matchId: null }));
  assert.throws(() => parseRoom({ ...waiting, matchId }));
});

test("rejects duplicate robot colors and unknown maps", () => {
  assert.throws(() => parseRoom({
    ...waiting,
    players: [waiting.players[0], { ...waiting.players[1], color: "blue", name: "Blue Robot" }],
  }));
  assert.throws(() => parseRoom({ ...waiting, mapId: "moon-base" }));
  assert.equal(isMapId("windworks"), true);
  assert.equal(isMapId("moon-base"), false);
  assert.equal(mapName("crane-shift"), "Crane Shift");
});

test("rejects private token data at both room and player boundaries", () => {
  assert.throws(() => parseRoom({ ...waiting, token: "secret" }));
  assert.throws(() => parseRoom({ ...waiting, tokenDigest: "digest" }));
  assert.throws(() => parseRoom({
    ...waiting,
    players: [{ ...waiting.players[0], tokenDigest: "digest" }, waiting.players[1]],
  }));
});

test("normalizes human-entered room codes", () => {
  assert.equal(normalizeRoomCode("  xk72\n"), "XK72");
});
