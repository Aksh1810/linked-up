import assert from "node:assert/strict";
import test from "node:test";

import { SignalingClient } from "./signaling-client.ts";

const senderId = "10000000-0000-4000-8000-000000000001";
const recipientId = "10000000-0000-4000-8000-000000000003";

test("signaling client posts with private headers and advances its poll cursor", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    calls.push({ url: new URL(input.toString()), init });
    return calls.length === 1
      ? new Response(JSON.stringify({ cursor: "7" }), { status: 201, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({
        signals: [{ cursor: "8", envelope: { type: "ready", senderId: recipientId, recipientId: senderId } }],
        cursor: "8",
      }), { headers: { "Content-Type": "application/json" } });
  };
  const client = new SignalingClient("xk72", "private-token", senderId, "https://game.test", fetcher);
  await client.send({ type: "offer", senderId, recipientId, sdp: "v=0" });
  assert.deepEqual(await client.poll(), [{ type: "ready", senderId: recipientId, recipientId: senderId }]);
  assert.deepEqual(calls.map(({ url, init }) => ({
    method: init.method,
    path: `${url.pathname}${url.search}`,
    token: new Headers(init.headers).get("X-Player-Token"),
  })), [
    { method: "POST", path: "/api/rooms/XK72/signals", token: "private-token" },
    { method: "GET", path: "/api/rooms/XK72/signals?after=0&limit=64", token: "private-token" },
  ]);
  assert.equal(client.cursor, "8");
});

test("signaling client rejects malformed server envelopes", async () => {
  const client = new SignalingClient("XK72", "token", senderId, "https://game.test", async () =>
    new Response(JSON.stringify({ signals: [{ cursor: "1", envelope: { type: "ready" } }], cursor: "1" })));
  await assert.rejects(client.poll(), TypeError);
});
