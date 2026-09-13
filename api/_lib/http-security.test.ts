import assert from "node:assert/strict";
import test from "node:test";

import { jsonResponse } from "./http.ts";

test("API responses apply production browser security headers", () => {
  const response = jsonResponse({ ok: true });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
});
