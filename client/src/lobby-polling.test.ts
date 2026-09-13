import assert from "node:assert/strict";
import test from "node:test";

import type { NotModified } from "./lobby-api.ts";
import {
  LobbyPollingConnection,
  type LobbyPollingApi,
  type PollingScheduler,
} from "./lobby-polling.ts";
import type { RoomState } from "./lobby-state.ts";

const room: RoomState = {
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

class FakeApi implements LobbyPollingApi {
  readonly calls: string[] = [];
  readonly results: Array<RoomState | NotModified | Error> = [];

  async getRoom(code: string, etag?: string): Promise<RoomState | NotModified> {
    this.calls.push(`get:${code}:${etag ?? "none"}`);
    const result = this.results.shift() ?? room;
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }

  async presence(code: string, token: string): Promise<void> {
    this.calls.push(`presence:${code}:${token}`);
  }
}

class FakeScheduler implements PollingScheduler {
  readonly delays: number[] = [];
  readonly callbacks: Array<() => void | Promise<void>> = [];
  #nextId = 0;
  readonly cancelled = new Set<number>();

  setTimeout(callback: () => void | Promise<void>, milliseconds: number): number {
    this.delays.push(milliseconds);
    this.callbacks.push(callback);
    return this.#nextId++;
  }

  clearTimeout(id: unknown): void { this.cancelled.add(id as number); }

  async runNext(): Promise<void> {
    const callback = this.callbacks.shift();
    assert.ok(callback);
    await callback();
  }
}

test("polls once per second while visible, reuses ETags, and refreshes presence", async () => {
  const api = new FakeApi();
  const scheduler = new FakeScheduler();
  api.results.push(room, { notModified: true, etag: '"room-1"' });
  const received: RoomState[] = [];
  const connection = new LobbyPollingConnection("xk72", "secret", room.players[0]!.id, {
    onRoom: (next) => received.push(next),
  }, api, scheduler, { hidden: false });

  await connection.connect();
  await scheduler.runNext();

  assert.deepEqual(api.calls, [
    "get:XK72:none", "presence:XK72:secret",
    'get:XK72:"room-1"', "presence:XK72:secret",
  ]);
  assert.deepEqual(scheduler.delays, [1_000, 1_000]);
  assert.equal(received.length, 1);
});

test("uses ten-second polling while the document is hidden", async () => {
  const api = new FakeApi();
  const scheduler = new FakeScheduler();
  const visibility = { hidden: false };
  const connection = new LobbyPollingConnection("XK72", "secret", room.players[0]!.id,
    { onRoom: () => undefined }, api, scheduler, visibility);
  await connection.connect();
  visibility.hidden = true;
  await scheduler.runNext();
  assert.deepEqual(scheduler.delays, [1_000, 10_000]);
});

test("backs off after transient failures and recovers without overlapping polls", async () => {
  const api = new FakeApi();
  const scheduler = new FakeScheduler();
  const statuses: string[] = [];
  api.results.push(room, new Error("offline"), new Error("offline"), room);
  const connection = new LobbyPollingConnection("XK72", "secret", room.players[0]!.id, {
    onRoom: () => undefined,
    onStatus: (status) => statuses.push(status),
  }, api, scheduler, { hidden: false });

  await connection.connect();
  await scheduler.runNext();
  await scheduler.runNext();
  await scheduler.runNext();

  assert.deepEqual(scheduler.delays, [1_000, 1_000, 2_000, 1_000]);
  assert.deepEqual(statuses, ["connecting", "connected", "reconnecting", "connected"]);
});

test("stop suppresses scheduled and in-flight callbacks", async () => {
  const api = new FakeApi();
  const scheduler = new FakeScheduler();
  let roomCallbacks = 0;
  const connection = new LobbyPollingConnection("XK72", "secret", room.players[0]!.id,
    { onRoom: () => roomCallbacks++ }, api, scheduler, { hidden: false });
  await connection.connect();
  await connection.stop();
  await scheduler.runNext();
  assert.equal(roomCallbacks, 1);
  assert.equal(scheduler.callbacks.length, 0);
});

test("launches the peer match exactly once on the first starting snapshot", async () => {
  const api = new FakeApi();
  const scheduler = new FakeScheduler();
  const starting: RoomState = {
    ...room,
    status: "starting",
    matchId: "4a342322-1f6d-4662-b6c1-9f48dd6015e9",
  };
  api.results.push(starting, starting);
  const launches: unknown[] = [];
  const connection = new LobbyPollingConnection("XK72", "secret", room.players[0]!.id, {
    onRoom: () => undefined,
    onMatch: (launch) => launches.push(launch),
  }, api, scheduler, { hidden: false });

  await connection.connect();
  await scheduler.runNext();
  assert.deepEqual(launches, [{
    protocol: 1,
    roomCode: "XK72",
    matchId: starting.matchId,
    mapId: "classic-ascent",
    players: starting.players,
    localPlayer: starting.players[0],
    role: "host",
    countdownSeconds: 3,
  }]);
});
