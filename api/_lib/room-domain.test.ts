import assert from "node:assert/strict";
import test from "node:test";

import {
  RoomDomainError,
  createRoom,
  joinRoom,
  leaveRoom,
  publicRoom,
  setRoomMap,
  startRoom,
  touchPresence,
  type RoomGenerators,
} from "./room-domain.ts";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const UUIDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
];

function generators(): RoomGenerators {
  let uuidIndex = 0;
  let tokenIndex = 0;
  return {
    code: () => "XK72",
    uuid: () => UUIDS[uuidIndex++]!,
    token: () => `private-token-${++tokenIndex}`,
  };
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof RoomDomainError && error.code === code);
}

test("creates two-to-four player rooms with digest-only credentials", () => {
  for (const capacity of [2, 3, 4] as const) {
    const created = createRoom(capacity, NOW, generators());
    assert.equal(created.room.capacity, capacity);
    assert.equal(created.room.players[0]?.color, "blue");
    assert.equal(created.session.token, "private-token-1");
    assert.match(created.room.players[0]!.tokenDigest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(created.room).includes(created.session.token), false);
  }
  expectCode("invalid_capacity", () => createRoom(5 as 2, NOW, generators()));
});

test("joins in ordered color slots and rejects a full room", () => {
  const generated = generators();
  let { room } = createRoom(3, NOW, generated);
  const orange = joinRoom(room, NOW, generated);
  room = orange.room;
  const green = joinRoom(room, NOW, generated);
  room = green.room;

  assert.deepEqual(room.players.map((player) => player.color), ["blue", "orange", "green"]);
  expectCode("room_full", () => joinRoom(room, NOW, generated));
});

test("leaving migrates host authority to the first remaining player", () => {
  const generated = generators();
  const created = createRoom(2, NOW, generated);
  const joined = joinRoom(created.room, NOW, generated);
  const remaining = leaveRoom(joined.room, created.session.token);

  assert.ok(remaining);
  assert.equal(remaining.hostPlayerId, joined.session.playerId);
  assert.equal(publicRoom(remaining).players[0]?.isHost, true);
  assert.equal(leaveRoom(remaining, joined.session.token), undefined);
});

test("only the waiting-room host can change to a known map", () => {
  const generated = generators();
  const created = createRoom(2, NOW, generated);
  const joined = joinRoom(created.room, NOW, generated);

  assert.equal(setRoomMap(joined.room, created.session.token, "windworks").mapId, "windworks");
  expectCode("not_host", () => setRoomMap(joined.room, joined.session.token, "relay-ridge"));
  expectCode("invalid_map", () => setRoomMap(joined.room, created.session.token, "moon-base" as never));
});

test("presence is authenticated and start requires every current player", () => {
  const generated = generators();
  const created = createRoom(2, NOW, generated);
  const joinedAt = new Date(NOW.getTime() - 60_000);
  let joined = joinRoom(created.room, joinedAt, generated).room;

  expectCode("players_not_present", () => startRoom(joined, created.session.token, NOW, generated));
  joined = touchPresence(joined, created.session.token, NOW);
  const guestToken = "private-token-2";
  joined = touchPresence(joined, guestToken, NOW);
  const started = startRoom(joined, created.session.token, NOW, generated);

  assert.equal(started.status, "starting");
  assert.match(started.matchId!, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(publicRoom(started)).includes("tokenDigest"), false);
  expectCode("not_host", () => startRoom(joined, guestToken, NOW, generated));
});

test("public rooms are exact immutable projections", () => {
  const created = createRoom(2, NOW, generators());
  const projected = publicRoom(created.room);
  assert.deepEqual(Object.keys(projected), [
    "id", "code", "capacity", "status", "createdAt", "version", "mapId", "matchId", "players",
  ]);
  assert.equal(JSON.stringify(projected).includes("token"), false);
  projected.players[0]!.name = "tampered";
  assert.equal(created.room.players[0]!.name, "Blue Robot");
});
