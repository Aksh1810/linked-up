import assert from "node:assert/strict";
import test from "node:test";

import {
  friendlyLobbyError,
  isCurrentLobbyRoute,
  canRunLobbyCommand,
  beginRetiredLeave,
  nextLobbyRouteVersion,
  queueLobbyStop,
  retireRoomSession,
  roomSlots,
} from "./lobby.ts";
import { LobbyApiError } from "./lobby-api.ts";
import { loadRoomSession, saveRoomSession, type RoomState } from "./lobby-state.ts";

const room: RoomState = {
  id: "8f0b648f-90b2-44d9-a6a7-aac07430c4e4",
  code: "XK72",
  capacity: 3,
  status: "waiting",
  createdAt: "2026-08-30T12:00:00.000Z",
  version: 1,
  mapId: "classic-ascent",
  matchId: null,
  players: [{
    id: "c7a17aa1-5131-4652-8f9e-e1d5dcb1f66b",
    name: "Blue Robot",
    color: "blue",
    isHost: true,
  }],
};

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

test("room slots always match room capacity", () => {
  assert.deepEqual(roomSlots(room), [room.players[0], undefined, undefined]);
});

test("lobby errors never expose transport messages", () => {
  assert.equal(friendlyLobbyError(new Error("connection refused at 10.0.0.7")),
    "The room request could not be completed.");
  assert.equal(friendlyLobbyError(new LobbyApiError(503, { status: 503 })),
    "The room service is temporarily unavailable.");
});

test("route version rejects stale command completions after later navigation", () => {
  assert.equal(isCurrentLobbyRoute(4, 4), true);
  assert.equal(isCurrentLobbyRoute(4, 5), false);
});

test("pagehide invalidates a pending room operation", () => {
  const pendingVersion = 7;
  assert.equal(isCurrentLobbyRoute(pendingVersion, nextLobbyRouteVersion(pendingVersion)), false);
});

test("a new lobby stop waits for the prior stop to resolve", async () => {
  let finishFirst: (() => void) | undefined;
  let firstFinished = false;
  let secondStarted = false;
  const first = queueLobbyStop(Promise.resolve(), () => new Promise<void>((resolve) => {
    finishFirst = () => { firstFinished = true; resolve(); };
  }));
  const second = queueLobbyStop(first, async () => {
    assert.equal(firstFinished, true);
    secondStarted = true;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  finishFirst?.();
  await second;
  assert.equal(secondStarted, true);
});

test("room commands are blocked while a route teardown is pending", () => {
  assert.equal(canRunLobbyCommand(true), false);
  assert.equal(canRunLobbyCommand(false), true);
});

test("leave retires its session before its request resolves and preserves a later rejoin", async () => {
  const storage = new MemoryStorage();
  const oldSession = { playerId: room.players[0].id, token: "old-token" };
  const newSession = { playerId: room.players[0].id, token: "new-token" };
  saveRoomSession(storage, room.code, oldSession);
  let resolveLeave: (() => void) | undefined;
  const leave = new Promise<void>((resolve) => { resolveLeave = resolve; });
  let invoked = false;
  const retiredLeave = beginRetiredLeave(storage, room.code, oldSession.token, (token) => {
    invoked = true;
    assert.equal(token, oldSession.token);
    return leave;
  });

  assert.equal(invoked, true);
  assert.deepEqual(retiredLeave.session, oldSession);
  assert.equal(loadRoomSession(storage, room.code), undefined);
  saveRoomSession(storage, room.code, newSession);
  resolveLeave?.();
  await retiredLeave.request;
  assert.deepEqual(loadRoomSession(storage, room.code), newSession);
});
