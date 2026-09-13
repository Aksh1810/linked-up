import assert from "node:assert/strict";
import test from "node:test";

import { RedisSignalStore, parseStoredSignalEnvelope } from "./redis-signal-store.ts";

test("stored signaling JSON is decoded before envelope validation", () => {
  const senderId = "00000000-0000-4000-8000-000000000001";
  const recipientId = "00000000-0000-4000-8000-000000000002";
  assert.deepEqual(
    parseStoredSignalEnvelope(JSON.stringify({ type: "ready", senderId, recipientId })),
    { type: "ready", senderId, recipientId },
  );
});

test("production signaling derives its mailbox key from the TLS Redis credential", () => {
  assert.doesNotThrow(() => RedisSignalStore.fromEnvironment({
    REDIS_URL: "rediss://default:private-password@example.test:6379",
  }));
});

test("production signaling rejects missing or insecure Redis configuration", () => {
  assert.throws(() => RedisSignalStore.fromEnvironment({}), /REDIS/);
  assert.throws(() => RedisSignalStore.fromEnvironment({
    REDIS_URL: "redis://default:private-password@example.test:6379",
  }), /TLS/);
});
