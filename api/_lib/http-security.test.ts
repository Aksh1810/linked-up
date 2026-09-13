import assert from "node:assert/strict";
import test from "node:test";

import { jsonResponse, roomActionRequest } from "./http.ts";

test("API responses apply production browser security headers", () => {
  const response = jsonResponse({ ok: true });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("room action rewrites restore the public nested API path", () => {
  const rewritten = new Request("https://example.com/api/room?__roomId=ABCD&__roomAction=map&roomId=ABCD&action=map&keep=value", {
    method: "POST",
    body: "{}",
  });
  const restored = roomActionRequest(rewritten);

  assert.equal(restored.url, "https://example.com/api/rooms/ABCD/map?keep=value");
  assert.equal(restored.method, "POST");
});

test("room action rewrites reject unrecognized actions", () => {
  const rewritten = new Request("https://example.com/api/room?__roomId=ABCD&__roomAction=admin");
  assert.equal(roomActionRequest(rewritten).url, rewritten.url);
});
