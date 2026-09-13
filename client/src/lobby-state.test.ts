import assert from "node:assert/strict";
import test from "node:test";

import {
  canSelectMap,
  canStart,
  loadRoomSession,
  parseRoom,
  saveRoomSession,
  mapName,
  type RoomSession,
  type RoomState,
} from "./lobby-state.ts";
import { LobbyApi, LobbyApiError, friendlyProblemMessage, type NotModified } from "./lobby-api.ts";
import { LobbyConnection, type LobbyTransport } from "./lobby-connection.ts";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

const validRoom: RoomState = {
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

const session: RoomSession = { playerId: validRoom.players[0].id, token: "secret" };

function roomSessionResponse(): { room: RoomState; session: RoomSession } {
  return { room: { ...validRoom, players: [...validRoom.players] }, session };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class FakeLobbyTransport implements LobbyTransport {
  readonly calls: string[] = [];
  snapshot: unknown = validRoom;
  #roomUpdated?: (...args: unknown[]) => void;
  #matchReady?: (...args: unknown[]) => void;
  #reconnecting?: () => void | Promise<void>;
  #reconnected?: () => void | Promise<void>;
  #closed?: () => void | Promise<void>;

  on(method: string, handler: (...args: unknown[]) => void): void {
    this.calls.push(`on:${method}`);
    if (method === "RoomUpdated") this.#roomUpdated = handler;
    if (method === "MatchReady") this.#matchReady = handler;
  }

  onreconnecting(handler: () => void | Promise<void>): void { this.#reconnecting = handler; }
  onreconnected(handler: () => void | Promise<void>): void { this.#reconnected = handler; }
  onclose(handler: () => void | Promise<void>): void { this.#closed = handler; }
  async start(): Promise<void> { this.calls.push("start"); }
  async stop(): Promise<void> { this.calls.push("stop"); await this.#closed?.(); }
  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    this.calls.push(`invoke:${method}:${args.join(":")}`);
    return this.snapshot as T;
  }

  emitRoomUpdated(room: unknown): void { this.#roomUpdated?.(room); }
  emitMatchReady(launch: unknown): void { this.#matchReady?.(launch); }
  reconnecting(): void | Promise<void> { return this.#reconnecting?.(); }
  reconnected(): void | Promise<void> { return this.#reconnected?.(); }
}

test("room parsing rejects private fields and malformed capacities", () => {
  assert.throws(() => parseRoom({ ...validRoom, capacity: 5 }));
  assert.throws(() => parseRoom({ ...validRoom, tokenHash: "leak" }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0], sessionTokenHash: "leak" }],
  }));
});

test("room parsing validates status, color, and player fields", () => {
  assert.throws(() => parseRoom({ ...validRoom, status: "ready" }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0], color: "red" }],
  }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0], isHost: "true" }],
  }));
});

test("room parsing accepts only known maps", () => {
  assert.equal(parseRoom({ ...validRoom, mapId: "relay-ridge" }).mapId, "relay-ridge");
  assert.throws(() => parseRoom({ ...validRoom, mapId: "unknown-map" }));
  const { mapId: _, ...missingMap } = validRoom;
  assert.throws(() => parseRoom(missingMap));
  assert.equal(mapName("windworks"), "Windworks");
});

test("room parsing admits only public match metadata for a full in-game room", () => {
  const inGame = {
    ...validRoom,
    status: "inGame" as const,
    matchId: "4a342322-1f6d-4662-b6c1-9f48dd6015e9",
  };
  assert.deepEqual(parseRoom(inGame), inGame);
  assert.throws(() => parseRoom({ ...inGame, matchId: null }));
  assert.throws(() => parseRoom({ ...validRoom, matchId: inGame.matchId }));
  assert.throws(() => parseRoom({ ...validRoom, status: "starting", players: validRoom.players.slice(0, 1) }));
});

test("starting rooms require the generated public match id", () => {
  const matchId = "4a342322-1f6d-4662-b6c1-9f48dd6015e9";
  const starting = parseRoom({ ...validRoom, status: "starting", matchId });
  assert.equal(starting.matchId, matchId);
  assert.throws(() => parseRoom({ ...validRoom, status: "starting", matchId: null }));
});

test("room parsing enforces authoritative public room invariants", () => {
  assert.throws(() => parseRoom({ ...validRoom, id: "not-a-uuid" }));
  assert.throws(() => parseRoom({ ...validRoom, createdAt: "tomorrow" }));
  assert.throws(() => parseRoom({ ...validRoom, version: 0 }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0] }, { ...validRoom.players[0], isHost: false }],
  }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0] }, { ...validRoom.players[1], color: "blue" }],
  }));
  assert.throws(() => parseRoom({
    ...validRoom,
    players: [{ ...validRoom.players[0], name: "Orange Robot" }],
  }));
});

test("only the full-room host can start", () => {
  assert.equal(canStart(validRoom, validRoom.players[0].id), true);
  assert.equal(canStart(validRoom, validRoom.players[1].id), false);
  assert.equal(canStart({ ...validRoom, players: validRoom.players.slice(0, 1) },
    validRoom.players[0].id), false);
});

test("only the waiting-room host can select a map", () => {
  assert.equal(canSelectMap(validRoom, validRoom.players[0].id), true);
  assert.equal(canSelectMap(validRoom, validRoom.players[1].id), false);
  assert.equal(canSelectMap({ ...validRoom, status: "starting" }, validRoom.players[0].id), false);
});

test("sessions are scoped by normalized room code", () => {
  const storage = new MemoryStorage();
  saveRoomSession(storage, "xk72", session);
  assert.deepEqual(loadRoomSession(storage, "XK72"), session);
  assert.equal(loadRoomSession(storage, "ABCD"), undefined);
});

test("corrupt room sessions are removed", () => {
  const storage = new MemoryStorage();
  storage.setItem("linked-up:room:XK72", "not json");
  assert.equal(loadRoomSession(storage, "XK72"), undefined);
  assert.equal(storage.getItem("linked-up:room:XK72"), null);
  storage.setItem("linked-up:room:XK72", JSON.stringify({ playerId: "not-a-uuid", token: "secret" }));
  assert.equal(loadRoomSession(storage, "XK72"), undefined);
});

test("problem details map to stable friendly messages", () => {
  assert.equal(friendlyProblemMessage({ status: 404 }), "This room no longer exists.");
  assert.equal(friendlyProblemMessage({ status: 409, title: "Room full" }), "This room is full.");
  assert.equal(
    friendlyProblemMessage({ status: 503 }),
    "The room service is temporarily unavailable.",
  );
});

test("lobby API sends each room command with the public contract", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const api = new LobbyApi("http://rooms.test", async (input, init) => {
    calls.push({ url: new URL(input.toString()), init });
    if (calls.length === 2 || calls.length === 5 || calls.length === 6) return jsonResponse(validRoom);
    if (calls.length === 4) return new Response(null, { status: 204 });
    return jsonResponse(roomSessionResponse());
  });

  assert.deepEqual(await api.createRoom(2), roomSessionResponse());
  assert.deepEqual(await api.getRoom("xk72"), validRoom);
  assert.deepEqual(await api.joinRoom("xk72"), roomSessionResponse());
  await api.leaveRoom("xk72", "token");
  assert.deepEqual(await api.setMap("xk72", "token", "relay-ridge"), validRoom);
  assert.deepEqual(await api.startRoom("xk72", "token"), validRoom);

  assert.deepEqual(calls.map(({ url, init }) => ({
    path: url.pathname,
    method: init?.method ?? "GET",
    body: init?.body,
    token: new Headers(init?.headers).get("X-Player-Token"),
  })), [
    { path: "/api/rooms", method: "POST", body: '{"capacity":2}', token: null },
    { path: "/api/rooms/XK72", method: "GET", body: undefined, token: null },
    { path: "/api/rooms/XK72/join", method: "POST", body: undefined, token: null },
    { path: "/api/rooms/XK72/leave", method: "POST", body: undefined, token: "token" },
    { path: "/api/rooms/XK72/map", method: "POST", body: '{"mapId":"relay-ridge"}', token: "token" },
    { path: "/api/rooms/XK72/start", method: "POST", body: undefined, token: "token" },
  ]);
});

test("lobby API calls its default fetch with the global receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receivedThis: unknown;
  globalThis.fetch = function (this: unknown) {
    receivedThis = this;
    return Promise.resolve(jsonResponse(validRoom));
  } as typeof fetch;
  try {
    assert.deepEqual(await new LobbyApi("http://rooms.test").getRoom("XK72"), validRoom);
    assert.equal(receivedThis, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lobby API performs conditional room reads and presence refreshes", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const api = new LobbyApi("http://rooms.test", async (input, init) => {
    calls.push({ url: new URL(input.toString()), init });
    return calls.length === 1
      ? new Response(null, { status: 304, headers: { ETag: '"room-7"' } })
      : new Response(null, { status: 204 });
  });

  const unchanged = await api.getRoom("xk72", '"room-7"') as NotModified;
  assert.deepEqual(unchanged, { notModified: true, etag: '"room-7"' });
  await api.presence("xk72", "secret");

  assert.deepEqual(calls.map(({ url, init }) => ({
    path: url.pathname,
    method: init?.method ?? "GET",
    etag: new Headers(init?.headers).get("If-None-Match"),
    token: new Headers(init?.headers).get("X-Player-Token"),
  })), [
    { path: "/api/rooms/XK72", method: "GET", etag: '"room-7"', token: null },
    { path: "/api/rooms/XK72/presence", method: "POST", etag: null, token: "secret" },
  ]);
});

test("lobby API validates responses, maps Problem Details, and preserves network errors", async () => {
  const badResponse = new LobbyApi("http://rooms.test", async () => jsonResponse({
    ...roomSessionResponse(), room: { ...validRoom, tokenHash: "leak" },
  }));
  await assert.rejects(badResponse.createRoom(2), TypeError);

  const missingRoom = new LobbyApi("http://rooms.test", async () => jsonResponse({ status: 404 }, 404));
  await assert.rejects(missingRoom.getRoom("XK72"), (error: unknown) =>
    error instanceof LobbyApiError && error.message === "This room no longer exists.");

  const networkError = new Error("offline");
  const offline = new LobbyApi("http://rooms.test", async () => { throw networkError; });
  await assert.rejects(offline.getRoom("XK72"), (error: unknown) => error === networkError);
});

test("lobby connection subscribes before and after reconnect with validated snapshots", async () => {
  const transport = new FakeLobbyTransport();
  const rooms: RoomState[] = [];
  let factoryUrl = "";
  let factoryDelays: readonly number[] = [];
  const connection = new LobbyConnection("xk72", "token", session.playerId, { onRoom: (room) => rooms.push(room) }, undefined,
    (url, delays) => {
      factoryUrl = url;
      factoryDelays = delays;
      return transport;
    });

  assert.deepEqual(transport.calls.slice(0, 2), ["on:RoomUpdated", "on:MatchReady"]);
  await connection.connect();
  await transport.reconnected();
  await connection.dispose();

  assert.equal(factoryUrl, "http://127.0.0.1:5000/hubs/lobby");
  assert.deepEqual(factoryDelays, [0, 1_000, 3_000, 5_000]);
  assert.deepEqual(transport.calls, [
    "on:RoomUpdated", "on:MatchReady", "start", "invoke:Subscribe:XK72:token", "invoke:Subscribe:XK72:token", "stop",
  ]);
  assert.deepEqual(rooms, [validRoom, validRoom]);
});

test("lobby connection rejects malformed snapshots without blaming consumer callbacks", async () => {
  const transport = new FakeLobbyTransport();
  const errors: string[] = [];
  const consumerError = new Error("render failed");
  const connection = new LobbyConnection("XK72", "token", session.playerId, {
    onRoom: () => { throw consumerError; },
    onError: (message) => errors.push(message),
  }, undefined, () => transport);

  assert.throws(() => transport.emitRoomUpdated(validRoom), consumerError);
  assert.deepEqual(errors, []);

  const errorThrowingConnection = new LobbyConnection("XK72", "token", session.playerId, {
    onRoom: () => assert.fail("invalid room must not reach consumers"),
    onError: () => { throw new Error("consumer error"); },
  }, undefined, () => transport);
  assert.doesNotThrow(() => transport.emitRoomUpdated({ code: "XK72" }));
  void connection;
  void errorThrowingConnection;
});

test("lobby connection rejects malformed Subscribe snapshots", async () => {
  const transport = new FakeLobbyTransport();
  transport.snapshot = { code: "XK72" };
  const connection = new LobbyConnection("XK72", "token", session.playerId, { onRoom: () => assert.fail("must not render") },
    undefined, () => transport);
  await assert.rejects(connection.connect(), TypeError);
});

test("lobby reconnect reports only transport failures", async () => {
  const consumerTransport = new FakeLobbyTransport();
  const errors: string[] = [];
  new LobbyConnection("XK72", "token", session.playerId, {
    onRoom: () => { throw new Error("render failed"); },
    onError: (message) => errors.push(message),
  }, undefined, () => consumerTransport);
  await consumerTransport.reconnected();
  assert.deepEqual(errors, []);

  const invalidTransport = new FakeLobbyTransport();
  invalidTransport.snapshot = { code: "XK72" };
  new LobbyConnection("XK72", "token", session.playerId, {
    onRoom: () => assert.fail("invalid room must not reach consumers"),
    onError: (message) => errors.push(message),
  }, undefined, () => invalidTransport);
  await invalidTransport.reconnected();
  assert.deepEqual(errors, ["Could not reconnect to the room."]);
});

test("lobby connection accepts only the current player's private match launch", async () => {
  const transport = new FakeLobbyTransport();
  const launches: unknown[] = [];
  const errors: string[] = [];
  const connection = new LobbyConnection("XK72", "token", session.playerId, {
    onRoom: () => assert.fail("match launch must not become a room update"),
    onMatch: (launch) => launches.push(launch),
    onError: (message) => errors.push(message),
  }, undefined, () => transport);
  const launch = {
    matchId: "8f0b648f-90b2-44d9-a6a7-aac07430c4e4",
    gameplayUrl: "wss://game.test/game",
    countdownSeconds: 3,
    expiresAt: "2099-08-30T12:00:00.000Z",
    playerId: session.playerId,
    color: "blue",
    ticket: "opaque-ticket",
  };

  transport.emitMatchReady(launch);
  transport.emitMatchReady({ ...launch, playerId: validRoom.players[1].id });

  assert.deepEqual(launches, [launch]);
  assert.deepEqual(errors, ["The room server sent an invalid match launch."]);
  await connection.dispose();
});
