export type PlayerId = "blue" | "orange";

export interface Vector3State {
  x: number;
  y: number;
  z: number;
}

export interface NetworkPlayerState {
  id: PlayerId;
  acknowledgedInput: number;
  position: Vector3State;
  velocity: Vector3State;
  grounded: boolean;
}

export interface WelcomeMessage {
  type: "welcome";
  player: PlayerId;
  tickRate: number;
  snapshotRate: number;
}

export interface ServerSnapshot {
  type: "snapshot";
  tick: number;
  resetCount: number;
  separation: number;
  tetherTension: number;
  players: [NetworkPlayerState, NetworkPlayerState];
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface ClientInput {
  sequence: number;
  clientTick: number;
  moveX: number;
  moveZ: number;
  jump: boolean;
}

export type ServerMessage = WelcomeMessage | ServerSnapshot | ErrorMessage;

export class ProtocolError extends Error {}

export function encodeInput(input: ClientInput): string {
  return JSON.stringify({
    type: "input",
    sequence: input.sequence,
    clientTick: input.clientTick,
    moveX: input.moveX,
    moveZ: input.moveZ,
    jump: input.jump,
  });
}

export function parseServerMessage(message: string): ServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new ProtocolError("Server sent invalid JSON.");
  }
  if (!record(value) || typeof value.type !== "string") invalid();

  if (value.type === "welcome") {
    if (!playerId(value.player) || !count(value.tickRate) || !count(value.snapshotRate)) invalid();
    return {
      type: "welcome",
      player: value.player,
      tickRate: value.tickRate,
      snapshotRate: value.snapshotRate,
    };
  }

  if (value.type === "error") {
    if (typeof value.code !== "string" || typeof value.message !== "string") invalid();
    return { type: "error", code: value.code, message: value.message };
  }

  if (value.type !== "snapshot" || !count(value.tick) || !count(value.resetCount) ||
      !finite(value.separation) || !finite(value.tetherTension) ||
      !Array.isArray(value.players) || value.players.length !== 2) {
    invalid();
  }
  const blue = parsePlayer(value.players[0], "blue");
  const orange = parsePlayer(value.players[1], "orange");
  return {
    type: "snapshot",
    tick: value.tick,
    resetCount: value.resetCount,
    separation: value.separation,
    tetherTension: value.tetherTension,
    players: [blue, orange],
  };
}

function parsePlayer(value: unknown, expected: PlayerId): NetworkPlayerState {
  if (!record(value) || value.id !== expected || !record(value.position) ||
      !record(value.velocity) || !count(value.acknowledgedInput) ||
      typeof value.grounded !== "boolean") {
    invalid();
  }
  return {
    id: expected,
    acknowledgedInput: value.acknowledgedInput,
    position: vector(value.position),
    velocity: vector(value.velocity),
    grounded: value.grounded,
  };
}

function vector(value: Record<string, unknown>): Vector3State {
  if (!finite(value.x) || !finite(value.y) || !finite(value.z)) invalid();
  return { x: value.x, y: value.y, z: value.z };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

function playerId(value: unknown): value is PlayerId {
  return value === "blue" || value === "orange";
}

function invalid(): never {
  throw new ProtocolError("Server message does not match the gameplay protocol.");
}
