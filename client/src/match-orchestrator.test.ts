import assert from "node:assert/strict";
import test from "node:test";

import { MatchOrchestrator, type MatchOrchestratorDependencies } from "./match-orchestrator.ts";
import type { PeerMatchLaunch } from "./lobby-polling.ts";

const players = [
  { id: "10000000-0000-4000-8000-000000000001", name: "Blue Robot", color: "blue", isHost: true },
  { id: "10000000-0000-4000-8000-000000000002", name: "Orange Robot", color: "orange", isHost: false },
  { id: "10000000-0000-4000-8000-000000000003", name: "Green Robot", color: "green", isHost: false },
] as const;
const base: PeerMatchLaunch = {
  protocol: 1, roomCode: "AB12", matchId: "20000000-0000-4000-8000-000000000001",
  mapId: "relay-ridge", players: [...players], localPlayer: players[0], role: "host", countdownSeconds: 3,
};

test("host waits for every guest before announcing the countdown", async () => {
  let handlers: any;
  const controls: unknown[] = [];
  const mesh = {
    async connect() {}, async processSignals() {},
    broadcastSnapshot() {}, broadcastControl(value: unknown) { controls.push(value); }, dispose() {},
  };
  const dependencies: MatchOrchestratorDependencies = {
    signaling: () => ({ send: async () => undefined, poll: async () => [] }),
    hostMesh: (_host, guests, mapId, _signal, nextHandlers) => {
      assert.deepEqual(guests, [
        { id: players[1].id, color: "orange" }, { id: players[2].id, color: "green" },
      ]);
      assert.equal(mapId, "relay-ridge");
      handlers = nextHandlers;
      return mesh as any;
    },
    guestMesh: () => { throw new Error("not guest"); },
    schedule: () => 1, cancel: () => undefined,
  };
  let resolved = false;
  const pending = MatchOrchestrator.start(base, { playerId: players[0].id, token: "secret" }, dependencies)
    .then((connection) => { resolved = true; return connection; });
  await Promise.resolve();
  handlers.onReady(players[1].id);
  await Promise.resolve();
  assert.equal(resolved, false);
  handlers.onReady(players[2].id);
  const connection = await pending;
  assert.equal(resolved, true);
  assert.deepEqual(controls, [{ kind: "ready", protocol: 1 }]);
  connection.dispose();
});

test("guest answers offers and waits for the host countdown signal", async () => {
  let handlers: any;
  let processed = 0;
  const guestLaunch: PeerMatchLaunch = { ...base, localPlayer: players[1], role: "guest" };
  const dependencies: MatchOrchestratorDependencies = {
    signaling: () => ({ send: async () => undefined, poll: async () => [] }),
    hostMesh: () => { throw new Error("not host"); },
    guestMesh: (_guest, host, _signal, nextHandlers) => {
      assert.equal(host, players[0].id);
      handlers = nextHandlers;
      return { async processSignals() { processed++; }, sendInput() {}, dispose() {} } as any;
    },
    schedule: () => 1, cancel: () => undefined,
  };
  let resolved = false;
  const pending = MatchOrchestrator.start(guestLaunch, { playerId: players[1].id, token: "secret" }, dependencies)
    .then((connection) => { resolved = true; return connection; });
  await Promise.resolve();
  assert.equal(processed, 1);
  assert.equal(resolved, false);
  handlers.onControl({ kind: "hello", protocol: 1, playerId: "orange", mapId: "relay-ridge" });
  handlers.onControl({ kind: "ready", protocol: 1 });
  const connection = await pending;
  assert.equal(resolved, true);
  connection.dispose();
});
