import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRateLimiter } from "./rate-limit.ts";

test("rate limiting isolates scopes and expires fixed windows", async () => {
  let now = 1_000;
  const limiter = new MemoryRateLimiter(() => now);

  assert.deepEqual(await limiter.consume("create", "ip-a", 2, 10), { allowed: true, retryAfter: 0 });
  assert.deepEqual(await limiter.consume("create", "ip-a", 2, 10), { allowed: true, retryAfter: 0 });
  assert.deepEqual(await limiter.consume("create", "ip-a", 2, 10), { allowed: false, retryAfter: 10 });
  assert.equal((await limiter.consume("join", "ip-a", 2, 10)).allowed, true);
  assert.equal((await limiter.consume("create", "ip-b", 2, 10)).allowed, true);

  now += 10_001;
  assert.equal((await limiter.consume("create", "ip-a", 2, 10)).allowed, true);
});
