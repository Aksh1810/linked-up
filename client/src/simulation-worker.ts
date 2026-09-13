/// <reference lib="webworker" />

import createLinkedUpSimulation, { type LinkedUpSimulationModule } from "./wasm/linked-up-simulation.js";
import wasmUrl from "./wasm/linked-up-simulation.wasm?url";
import { parseServerMessage, type PlayerId } from "./gameplay-protocol.ts";
import {
  parseWorkerCommand,
  type SimulationWorkerEvent,
} from "./simulation-worker-protocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let module: LinkedUpSimulationModule | undefined;
let roster: readonly PlayerId[] = [];
let tick = 0;
let disposed = false;
let finished = false;

function post(event: SimulationWorkerEvent): void {
  if (!disposed) scope.postMessage(event);
}

function fail(initializing: boolean): void {
  post(initializing
    ? { type: "error", code: "initialization-failed", message: "Could not start the match simulation." }
    : { type: "error", code: "simulation-failed", message: "The host simulation stopped unexpectedly." });
  dispose();
}

function dispose(): void {
  if (disposed) return;
  if (module) module.ccall("lu_destroy", null, [], []);
  disposed = true;
  module = undefined;
  roster = [];
}

scope.onmessage = async (event: MessageEvent<unknown>) => {
  if (disposed) return;
  let command;
  try { command = parseWorkerCommand(event.data); }
  catch { fail(module === undefined); return; }

  if (command.type === "dispose") { dispose(); return; }
  if (command.type === "initialize") {
    if (module) { fail(false); return; }
    try {
      module = await createLinkedUpSimulation({ locateFile: () => wasmUrl });
      roster = [...command.roster];
      const created = module.ccall(
        "lu_create", "number", ["string", "string"], [command.mapId, roster.join(",")],
      );
      if (created !== 1) { fail(true); return; }
      post({ type: "ready" });
    } catch { fail(true); }
    return;
  }
  if (!module) { fail(true); return; }

  try {
    if (command.type === "input") {
      const playerIndex = roster.indexOf(command.player);
      if (playerIndex < 0 || module.ccall(
        "lu_set_input", "number", ["number", "number", "number", "number", "number"],
        [playerIndex, command.input.sequence, command.input.moveX, command.input.moveZ, command.input.jump ? 1 : 0],
      ) !== 1) throw new Error("input rejected");
      return;
    }
    for (let step = 0; step < command.steps; step++) {
      module.ccall("lu_step", null, [], []);
      tick++;
      const pointer = module.ccall("lu_snapshot", "number", [], []);
      const snapshot = parseServerMessage(module.UTF8ToString(pointer), roster);
      if (snapshot.type !== "snapshot") throw new Error("invalid snapshot");
      if (tick % 3 === 0) post({ type: "snapshot", snapshot });
      if (!finished && snapshot.matchState === "finished") {
        finished = true;
        post({ type: "finished", elapsedTicks: snapshot.elapsedTicks });
      }
    }
  } catch { fail(false); }
};
