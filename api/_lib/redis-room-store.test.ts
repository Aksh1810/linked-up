import assert from "node:assert/strict";
import test from "node:test";

import { createRoom, joinRoom } from "./room-domain.ts";
import { RedisRoomStore } from "./redis-room-store.ts";

test("Redis mutation gives exactly one contender the last room slot", {
  skip: process.env.TEST_REDIS_URL ? false : "TEST_REDIS_URL is not configured",
}, async () => {
  const store = RedisRoomStore.fromUrl(process.env.TEST_REDIS_URL!, { allowInsecure: true });
  const namespace = `test-${crypto.randomUUID()}`;
  store.setNamespace(namespace);
  try {
    const created = createRoom(2, new Date());
    await store.create(created.room);
    const attempts = await Promise.allSettled([
      store.mutate(created.room.code, (room) => ({ room: joinRoom(room, new Date()).room, result: true })),
      store.mutate(created.room.code, (room) => ({ room: joinRoom(room, new Date()).room, result: true })),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  } finally {
    await store.deleteNamespace();
    await store.close();
  }
});

test("production Redis configuration requires transport security", () => {
  assert.throws(
    () => RedisRoomStore.fromUrl("redis://example.test:6379", { allowInsecure: false }),
    /TLS/,
  );
});
