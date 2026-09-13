import { parseServerMessage, type ClientInput, type PlayerId, type ServerSnapshot } from "./gameplay-protocol.ts";
import { isMapId, type MapId } from "./lobby-state.ts";

export type SimulationWorkerCommand =
  | { type: "initialize"; mapId: MapId; roster: readonly PlayerId[] }
  | { type: "input"; player: PlayerId; input: ClientInput }
  | { type: "advance"; steps: number }
  | { type: "dispose" };

export type SimulationWorkerEvent =
  | { type: "ready" }
  | { type: "snapshot"; snapshot: ServerSnapshot }
  | { type: "finished"; elapsedTicks: number }
  | { type: "error"; code: "initialization-failed" | "simulation-failed"; message: string };

export class WorkerProtocolError extends Error {}

const errorMessages = {
  "initialization-failed": "Could not start the match simulation.",
  "simulation-failed": "The host simulation stopped unexpectedly.",
} as const;

export function parseWorkerCommand(value: unknown): SimulationWorkerCommand {
  if (!record(value) || typeof value.type !== "string") invalid();
  if (value.type === "initialize" && exact(value, ["type", "mapId", "roster"])
    && isMapId(value.mapId) && roster(value.roster)) {
    return { type: "initialize", mapId: value.mapId, roster: [...value.roster] };
  }
  if (value.type === "input" && exact(value, ["type", "player", "input"])
    && playerId(value.player) && clientInput(value.input)) {
    return { type: "input", player: value.player, input: { ...value.input } };
  }
  if (value.type === "advance" && exact(value, ["type", "steps"])
    && integer(value.steps) && value.steps >= 1 && value.steps <= 8) {
    return { type: "advance", steps: value.steps };
  }
  if (value.type === "dispose" && exact(value, ["type"])) return { type: "dispose" };
  invalid();
}

export function parseWorkerEvent(value: unknown, expectedRoster?: readonly PlayerId[]): SimulationWorkerEvent {
  if (!record(value) || typeof value.type !== "string") invalid();
  if (value.type === "ready" && exact(value, ["type"])) return { type: "ready" };
  if (value.type === "finished" && exact(value, ["type", "elapsedTicks"]) && count(value.elapsedTicks)) {
    return { type: "finished", elapsedTicks: value.elapsedTicks };
  }
  if (value.type === "snapshot" && exact(value, ["type", "snapshot"])) {
    const parsed = parseServerMessage(JSON.stringify(value.snapshot), expectedRoster);
    if (parsed.type === "snapshot") return { type: "snapshot", snapshot: parsed };
  }
  if (value.type === "error" && exact(value, ["type", "code", "message"])
    && (value.code === "initialization-failed" || value.code === "simulation-failed")
    && value.message === errorMessages[value.code]) {
    return { type: "error", code: value.code, message: errorMessages[value.code] };
  }
  invalid();
}

export function snapshotTicksAfterAdvance(startTick: number, steps: number): number[] {
  if (!count(startTick) || !integer(steps) || steps < 0 || steps > 8) invalid();
  const ticks: number[] = [];
  for (let tick = startTick + 1; tick <= startTick + steps; tick++) {
    if (tick % 3 === 0) ticks.push(tick);
  }
  return ticks;
}

function clientInput(value: unknown): value is ClientInput {
  return record(value) && exact(value, ["sequence", "clientTick", "moveX", "moveZ", "jump"])
    && count(value.sequence) && count(value.clientTick) && axis(value.moveX) && axis(value.moveZ)
    && typeof value.jump === "boolean";
}

function roster(value: unknown): value is PlayerId[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 4
    && value.every(playerId) && new Set(value).size === value.length;
}

function playerId(value: unknown): value is PlayerId {
  return value === "blue" || value === "orange" || value === "green" || value === "purple";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function count(value: unknown): value is number {
  return integer(value) && value >= 0;
}

function axis(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function invalid(): never {
  throw new WorkerProtocolError("Invalid simulation worker message.");
}
