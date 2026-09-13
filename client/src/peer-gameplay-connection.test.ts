import assert from "node:assert/strict";
import test from "node:test";

import { PeerGameplayConnection, type GuestGameplayMesh, type HostGameplayMesh, type HostSimulationLike } from "./peer-gameplay-connection.ts";
import type { PeerMatchLaunch } from "./lobby-polling.ts";
import type { ServerSnapshot, WelcomeMessage } from "./gameplay-protocol.ts";

const players = [
  { id: "10000000-0000-4000-8000-000000000001", name: "Blue Robot", color: "blue", isHost: true },
  { id: "10000000-0000-4000-8000-000000000002", name: "Orange Robot", color: "orange", isHost: false },
] as const;
const launch: PeerMatchLaunch = {
  protocol: 1, roomCode: "AB12", matchId: "20000000-0000-4000-8000-000000000001",
  mapId: "windworks", players: [...players], localPlayer: players[0], role: "host", countdownSeconds: 3,
};
const snapshot: ServerSnapshot = {
  type: "snapshot", tick: 3, resetCount: 0, tetherTension: 0, matchState: "running",
  elapsedTicks: 3, checkpoint: 0, obstacles: [],
  players: players.map((player) => ({
    id: player.color, acknowledgedInput: 0, position: { x: 0, y: 1, z: 0 },
    velocity: { x: 0, y: 0, z: 0 }, grounded: true,
  })),
};

class FakeHostMesh implements HostGameplayMesh {
  readonly snapshots: ServerSnapshot[] = [];
  readonly controls: unknown[] = [];
  broadcastSnapshot(value: ServerSnapshot): void { this.snapshots.push(value); }
  broadcastControl(value: any): void { this.controls.push(value); }
  dispose(): void {}
}

class FakeGuestMesh implements GuestGameplayMesh {
  readonly inputs: unknown[] = [];
  sendInput(input: any): void { this.inputs.push(input); }
  dispose(): void {}
}

test("host creates the selected simulation, routes inputs, and fans out state", async () => {
  const mesh = new FakeHostMesh();
  let simulationHandlers: any;
  const simulation: HostSimulationLike = {
    inputs: [],
    setInput(player, input) { this.inputs.push({ player, input }); },
    dispose() {},
  } as HostSimulationLike & { inputs: unknown[] };
  const connection = PeerGameplayConnection.host(launch, mesh, async (mapId, roster, handlers) => {
    assert.equal(mapId, "windworks");
    assert.deepEqual(roster, ["blue", "orange"]);
    simulationHandlers = handlers;
    return simulation;
  });
  const welcomes: WelcomeMessage[] = [];
  const snapshots: ServerSnapshot[] = [];
  await connection.connect({
    onWelcome: (message) => welcomes.push(message), onSnapshot: (message) => snapshots.push(message),
    onError: () => undefined, onStatus: () => undefined,
  });
  assert.equal(welcomes[0]?.mapId, "windworks");
  assert.equal(connection.sendInput({ sequence: 1, clientTick: 1, moveX: 1, moveZ: 0, jump: false }), true);
  connection.acceptGuestInput(players[1].id, { sequence: 2, clientTick: 2, moveX: 0, moveZ: 1, jump: false });
  assert.deepEqual((simulation as any).inputs.map((entry: any) => entry.player), ["blue", "orange"]);

  simulationHandlers.onSnapshot(snapshot);
  assert.deepEqual(snapshots, [snapshot]);
  assert.deepEqual(mesh.snapshots, [snapshot]);
  simulationHandlers.onFinished(180);
  assert.deepEqual(mesh.controls, [{ kind: "finished", protocol: 1, elapsedTicks: 180 }]);
});

test("guest sends only inputs and terminates when the host is lost", async () => {
  const mesh = new FakeGuestMesh();
  const guestLaunch: PeerMatchLaunch = {
    ...launch, localPlayer: players[1], role: "guest",
  };
  const statuses: string[] = [];
  const errors: string[] = [];
  const received: ServerSnapshot[] = [];
  const connection = PeerGameplayConnection.guest(guestLaunch, mesh);
  await connection.connect({
    onWelcome: () => undefined, onSnapshot: (value) => received.push(value),
    onError: (message) => errors.push(message), onStatus: (status) => statuses.push(status),
  });
  assert.equal(connection.sendInput({ sequence: 1, clientTick: 1, moveX: 0, moveZ: -1, jump: true }), true);
  assert.equal(mesh.inputs.length, 1);
  connection.acceptHostSnapshot(snapshot);
  assert.deepEqual(received, [snapshot]);
  connection.hostLost();
  assert.deepEqual(errors, ["The host connection was lost."]);
  assert.equal(statuses.at(-1), "disconnected");
  assert.equal(connection.sendInput({ sequence: 2, clientTick: 2, moveX: 0, moveZ: 0, jump: false }), false);
});
