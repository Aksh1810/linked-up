import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRateLimiter } from "../_lib/rate-limit.ts";
import { createRoom, joinRoom } from "../_lib/room-domain.ts";
import { MemoryRoomStore } from "../_lib/memory-room-store.ts";
import { MemorySignalStore } from "../_lib/memory-signal-store.ts";
import { handleSignalingRequest } from "../_lib/signaling-api.ts";

const now = new Date("2026-09-12T12:00:00.000Z");

async function setup() {
  const roomStore = new MemoryRoomStore();
  let token = 0;
  const generators = { code: () => "XK72", uuid: () => crypto.randomUUID(), token: () => `token-${++token}` };
  const created = createRoom(2, now, generators);
  const joined = joinRoom(created.room, now, generators);
  await roomStore.create(joined.room);
  return {
    created,
    joined,
    dependencies: {
      roomStore,
      signalStore: new MemorySignalStore(),
      limiter: new MemoryRateLimiter(),
      clientIdentity: () => "trusted-ip",
    },
  };
}

function request(method: string, body: unknown, token: string, query = ""): Request {
  return new Request(`https://game.test/api/rooms/${"XK72"}/signals${query}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "X-Player-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  });
}

test("authenticated members exchange recipient-only signaling envelopes", async () => {
  const { created, joined, dependencies } = await setup();
  const envelope = {
    type: "offer", senderId: created.session.playerId, recipientId: joined.session.playerId, sdp: "v=0\r\n",
  };
  const posted = await handleSignalingRequest(request("POST", envelope, created.session.token), dependencies);
  assert.equal(posted.status, 201);
  assert.deepEqual(await posted.json(), { cursor: "1" });

  const guestRead = await handleSignalingRequest(request("GET", undefined, joined.session.token, "?after=0"), dependencies);
  assert.equal(guestRead.status, 200);
  const payload = await guestRead.json() as Record<string, any>;
  assert.deepEqual(payload, { signals: [{ cursor: "1", envelope }], cursor: "1" });
  assert.equal(JSON.stringify(payload).includes("tokenDigest"), false);

  const hostRead = await handleSignalingRequest(request("GET", undefined, created.session.token, "?after=0"), dependencies);
  assert.deepEqual(await hostRead.json(), { signals: [], cursor: "0" });
});

test("signaling rejects spoofed senders, self-targeting, and non-members", async () => {
  const { created, joined, dependencies } = await setup();
  const base = { type: "ready", senderId: created.session.playerId, recipientId: joined.session.playerId };
  assert.equal((await handleSignalingRequest(request("POST", { ...base, senderId: crypto.randomUUID() }, created.session.token), dependencies)).status, 403);
  assert.equal((await handleSignalingRequest(request("POST", { ...base, recipientId: created.session.playerId }, created.session.token), dependencies)).status, 400);
  assert.equal((await handleSignalingRequest(request("POST", { ...base, recipientId: crypto.randomUUID() }, created.session.token), dependencies)).status, 403);
  assert.equal((await handleSignalingRequest(request("POST", base, "wrong-token"), dependencies)).status, 401);
});

test("signaling validates methods, cursors, and bounded poll limits", async () => {
  const { joined, dependencies } = await setup();
  assert.equal((await handleSignalingRequest(request("DELETE", undefined, joined.session.token), dependencies)).status, 405);
  assert.equal((await handleSignalingRequest(request("GET", undefined, joined.session.token, "?after=../../secret"), dependencies)).status, 400);
  assert.equal((await handleSignalingRequest(request("GET", undefined, joined.session.token, "?after=0&limit=65"), dependencies)).status, 400);
  assert.equal((await handleSignalingRequest(request("GET", undefined, joined.session.token, "?after=0&extra=1"), dependencies)).status, 400);
});
