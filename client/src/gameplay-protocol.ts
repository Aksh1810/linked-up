export type PlayerId = "blue" | "orange" | "green" | "purple";

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
  players: readonly PlayerId[];
  tickRate: number;
  snapshotRate: number;
}

export interface ServerSnapshot {
  type: "snapshot";
  tick: number;
  resetCount: number;
  tetherTension: number;
  players: readonly NetworkPlayerState[];
  matchState: "running" | "finished";
  elapsedTicks: number;
  checkpoint: number;
  obstacles: readonly NetworkObstacleState[];
}

export interface NetworkObstacleState {
  id: string;
  kind: "movingPlatform" | "rotatingBeam" | "swingingBeam" | "fan" | "conveyor" | "fallingPlatform";
  phase: "armed" | "warning" | "falling";
  position: Vector3State;
  rotation: Vector3State;
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

export function parseServerMessage(message: string, expectedRoster?: readonly PlayerId[]): ServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new ProtocolError("Server sent invalid JSON.");
  }
  if (!record(value) || typeof value.type !== "string") invalid();

  if (value.type === "welcome") {
    if (!keys(value, ["type", "player", "players", "tickRate", "snapshotRate"])
      || !playerId(value.player) || !roster(value.players) || !value.players.includes(value.player)
      || !count(value.tickRate) || !count(value.snapshotRate)) invalid();
    return { type: "welcome", player: value.player, players: value.players, tickRate: value.tickRate, snapshotRate: value.snapshotRate };
  }

  if (value.type === "error") {
    if (!keys(value, ["type", "code", "message"]) || typeof value.code !== "string" || typeof value.message !== "string") invalid();
    return { type: "error", code: value.code, message: value.message };
  }

  if (value.type !== "snapshot" || !keys(value, ["type", "tick", "resetCount", "tetherTension", "players", "matchState", "elapsedTicks", "checkpoint", "obstacles"])
      || !count(value.tick) || !count(value.resetCount) || !finite(value.tetherTension) || !playerStates(value.players)
      || !matchState(value.matchState) || !count(value.elapsedTicks) || !count(value.checkpoint) || !obstacles(value.obstacles)) invalid();
  const players = value.players.map((player) => parsePlayer(player));
  if (expectedRoster && !matchesRoster(players, expectedRoster)) invalid();
  return {
    type: "snapshot",
    tick: value.tick,
    resetCount: value.resetCount,
    tetherTension: value.tetherTension,
    players,
    matchState: value.matchState,
    elapsedTicks: value.elapsedTicks,
    checkpoint: value.checkpoint,
    obstacles: value.obstacles.map(parseObstacle),
  };
}

function matchState(value: unknown): value is "running" | "finished" {
  return value === "running" || value === "finished";
}

function obstacles(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((obstacle) => record(obstacle) && typeof obstacle.id === "string"
    && obstacle.id.length > 0) && new Set(value.map((obstacle) => (obstacle as Record<string, unknown>).id)).size === value.length;
}

function parseObstacle(value: unknown): NetworkObstacleState {
  if (!record(value) || !keys(value, ["id", "kind", "phase", "position", "rotation"])
    || typeof value.id !== "string" || value.id.length === 0 || !obstacleKind(value.kind)
    || !obstaclePhase(value.phase) || !record(value.position) || !record(value.rotation)) invalid();
  return { id: value.id, kind: value.kind, phase: value.phase, position: vector(value.position), rotation: vector(value.rotation) };
}

function obstacleKind(value: unknown): value is NetworkObstacleState["kind"] {
  return value === "movingPlatform" || value === "rotatingBeam" || value === "swingingBeam"
    || value === "fan" || value === "conveyor" || value === "fallingPlatform";
}

function obstaclePhase(value: unknown): value is NetworkObstacleState["phase"] {
  return value === "armed" || value === "warning" || value === "falling";
}

function parsePlayer(value: unknown): NetworkPlayerState {
  if (!record(value) || !keys(value, ["id", "acknowledgedInput", "position", "velocity", "grounded"])
      || !playerId(value.id) || !record(value.position) || !record(value.velocity)
      || !count(value.acknowledgedInput) || typeof value.grounded !== "boolean") invalid();
  return {
    id: value.id,
    acknowledgedInput: value.acknowledgedInput,
    position: vector(value.position),
    velocity: vector(value.velocity),
    grounded: value.grounded,
  };
}

function roster(value: unknown): value is PlayerId[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 4
    && value.every(playerId) && new Set(value).size === value.length;
}

function playerStates(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 4
    && value.every((player) => record(player) && playerId(player.id))
    && new Set(value.map((player) => (player as Record<string, unknown>).id)).size === value.length;
}

function matchesRoster(players: readonly NetworkPlayerState[], roster: readonly PlayerId[]): boolean {
  return players.length === roster.length && players.every((player, index) => player.id === roster[index]);
}

function vector(value: Record<string, unknown>): Vector3State {
  if (!keys(value, ["x", "y", "z"]) || !finite(value.x) || !finite(value.y) || !finite(value.z)) invalid();
  return { x: value.x, y: value.y, z: value.z };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

function playerId(value: unknown): value is PlayerId {
  return value === "blue" || value === "orange" || value === "green" || value === "purple";
}

function invalid(): never {
  throw new ProtocolError("Server message does not match the gameplay protocol.");
}
