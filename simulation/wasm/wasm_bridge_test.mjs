import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import createLinkedUpSimulation from "../../client/src/wasm/linked-up-simulation.js";

const module = await createLinkedUpSimulation();
const nativeExecutable = new URL("../../build-native-parity/prototype_simulation_test", import.meta.url).pathname;
const expected = JSON.parse(execFileSync(nativeExecutable, ["--parity-fixture"], { encoding: "utf8" }));
const colors = ["blue", "orange", "green", "purple"];
const actual = [];

for (const mapId of ["classic-ascent", "relay-ridge", "crane-shift", "windworks"]) {
  for (let rosterSize = 2; rosterSize <= 4; rosterSize++) {
    assert.equal(module.ccall("lu_create", "number", ["string", "string"], [mapId, colors.slice(0, rosterSize).join(",")]), 1);
    for (let tick = 0; tick < 240; tick++) {
      for (let player = 0; player < rosterSize; player++) {
        const moveX = (Math.floor(tick / 60) + player) % 3 - 1;
        const moveZ = (Math.floor(tick / 45) + player * 2) % 3 - 1;
        assert.equal(module.ccall("lu_set_input", "number", ["number", "number", "number", "number", "number"],
          [player, tick + 1, moveX, moveZ, tick % 90 === player ? 1 : 0]), 1);
      }
      try {
        module.ccall("lu_step", null, [], []);
      } catch (error) {
        throw new Error(`Wasm step failed for ${mapId}/${rosterSize} at tick ${tick}`, { cause: error });
      }
    }
    const pointer = module.ccall("lu_snapshot", "number", [], []);
    const snapshot = JSON.parse(module.UTF8ToString(pointer));
    actual.push({
      mapId,
      rosterSize,
      tick: snapshot.tick,
      players: snapshot.players.map((player) => ({
        id: player.id,
        position: [player.position.x, player.position.y, player.position.z],
        velocity: [player.velocity.x, player.velocity.y, player.velocity.z],
      })),
    });
    module.ccall("lu_destroy", null, [], []);
  }
}

assert.equal(actual.length, expected.length);
for (let caseIndex = 0; caseIndex < expected.length; caseIndex++) {
  const expectedCase = expected[caseIndex];
  const actualCase = actual[caseIndex];
  assert.equal(actualCase.mapId, expectedCase.mapId);
  assert.equal(actualCase.rosterSize, expectedCase.rosterSize);
  assert.equal(actualCase.tick, expectedCase.tick);
  assert.equal(actualCase.players.length, expectedCase.players.length);
  for (let playerIndex = 0; playerIndex < expectedCase.players.length; playerIndex++) {
    const expectedPlayer = expectedCase.players[playerIndex];
    const actualPlayer = actualCase.players[playerIndex];
    assert.equal(actualPlayer.id, expectedPlayer.id);
    for (const field of ["position", "velocity"]) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(actualPlayer[field][axis] - expectedPlayer[field][axis]) <= 0.00001,
          `${actualCase.mapId}/${actualCase.rosterSize} ${actualPlayer.id} ${field}[${axis}] diverged: ` +
          `${actualPlayer[field][axis]} vs ${expectedPlayer[field][axis]}`);
      }
    }
  }
}
