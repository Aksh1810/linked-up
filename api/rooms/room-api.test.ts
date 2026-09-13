import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRoomStore } from "../_lib/memory-room-store.ts";
import type { RateLimiter, RateLimitResult } from "../_lib/rate-limit.ts";
import type { RoomGenerators } from "../_lib/room-domain.ts";
import { handleRoomRequest, type RoomApiDependencies } from "./room-api.ts";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
];

class AllowAll implements RateLimiter {
  async consume(): Promise<RateLimitResult> { return { allowed: true, retryAfter: 0 }; }
}

function dependencies(limiter: RateLimiter = new AllowAll()): RoomApiDependencies {
  let id = 0;
  let token = 0;
  const generators: RoomGenerators = {
    code: () => "XK72",
    uuid: () => ids[id++]!,
    token: () => `token-${++token}`,
  };
  return {
    store: new MemoryRoomStore(),
    limiter,
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    generators,
    clientIdentity: () => "trusted-platform-ip",
  };
}

function request(path: string, method = "GET", body?: unknown, token?: string, headers?: HeadersInit): Request {
  return new Request(`https://game.test${path}`, {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "X-Player-Token": token } : {}),
      ...headers,
    },
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("room handlers create, join, cache, mutate, touch presence, and start", async () => {
  const deps = dependencies();
  const createdResponse = await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2 }), deps);
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("Cache-Control"), "no-store");
  const created = await json(createdResponse);
  assert.equal(created.room.code, "XK72");
  assert.equal(JSON.stringify(created.room).includes("tokenDigest"), false);

  const joinedResponse = await handleRoomRequest(request("/api/rooms/XK72/join", "POST"), deps);
  assert.equal(joinedResponse.status, 201);
  const joined = await json(joinedResponse);

  const fetched = await handleRoomRequest(request("/api/rooms/XK72"), deps);
  assert.equal(fetched.status, 200);
  const etag = fetched.headers.get("ETag");
  assert.match(etag!, /^"room-\d+"$/);
  const unchanged = await handleRoomRequest(request("/api/rooms/XK72", "GET", undefined, undefined, {
    "If-None-Match": etag!,
  }), deps);
  assert.equal(unchanged.status, 304);

  const map = await handleRoomRequest(request(
    "/api/rooms/XK72/map", "POST", { mapId: "relay-ridge" }, created.session.token,
  ), deps);
  assert.equal((await json(map)).mapId, "relay-ridge");

  assert.equal((await handleRoomRequest(request(
    "/api/rooms/XK72/presence", "POST", undefined, joined.session.token,
  ), deps)).status, 204);
  const started = await handleRoomRequest(request(
    "/api/rooms/XK72/start", "POST", undefined, created.session.token,
  ), deps);
  const startedRoom = await json(started);
  assert.equal(startedRoom.status, "starting");
  assert.match(startedRoom.matchId, /^[0-9a-f-]{36}$/);
});

test("room handlers enforce exact methods, schemas, body limits, and authentication", async () => {
  const deps = dependencies();
  assert.equal((await handleRoomRequest(request("/api/rooms", "GET"), deps)).status, 405);
  assert.equal((await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2, admin: true }), deps)).status, 400);
  assert.equal((await handleRoomRequest(request("/api/rooms", "POST", "x".repeat(65_537)), deps)).status, 413);

  const created = await json(await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2 }), deps));
  assert.equal((await handleRoomRequest(request("/api/rooms/XK72/map", "POST", { mapId: "windworks" }), deps)).status, 401);
  assert.equal((await handleRoomRequest(request(
    "/api/rooms/XK72/map", "POST", { mapId: "windworks" }, "wrong-token",
  ), deps)).status, 401);
  assert.equal((await handleRoomRequest(request(
    "/api/rooms/XK72/map", "POST", { mapId: "windworks", token: created.session.token }, created.session.token,
  ), deps)).status, 400);
  assert.equal((await handleRoomRequest(request("/api/rooms/NOPE"), deps)).status, 404);
});

test("host-only operations and room conflicts return stable problem details", async () => {
  const deps = dependencies();
  const created = await json(await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2 }), deps));
  const joined = await json(await handleRoomRequest(request("/api/rooms/XK72/join", "POST"), deps));

  const forbidden = await handleRoomRequest(request(
    "/api/rooms/XK72/start", "POST", undefined, joined.session.token,
  ), deps);
  assert.equal(forbidden.status, 403);
  assert.equal((await json(forbidden)).title, "Host required");

  await handleRoomRequest(request("/api/rooms/XK72/start", "POST", undefined, created.session.token), deps);
  const lateJoin = await handleRoomRequest(request("/api/rooms/XK72/join", "POST"), deps);
  assert.equal(lateJoin.status, 409);
  assert.equal((await json(lateJoin)).title, "Room already starting");
});

test("leave removes the room and rate limits carry Retry-After", async () => {
  const blocked: RateLimiter = {
    async consume() { return { allowed: false, retryAfter: 42 }; },
  };
  const limited = await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2 }), dependencies(blocked));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "42");

  const deps = dependencies();
  const created = await json(await handleRoomRequest(request("/api/rooms", "POST", { capacity: 2 }), deps));
  const left = await handleRoomRequest(request("/api/rooms/XK72/leave", "POST", undefined, created.session.token), deps);
  assert.equal(left.status, 204);
  assert.equal((await handleRoomRequest(request("/api/rooms/XK72"), deps)).status, 404);
});
