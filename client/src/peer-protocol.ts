import { parseServerMessage, type ClientInput, type ServerSnapshot } from "./gameplay-protocol.ts";
import { isMapId, type MapId, type RobotColor } from "./lobby-state.ts";

const CONTROL = 1;
const INPUT = 2;
const SNAPSHOT = 3;
const INPUT_LIMIT = 512;
const SNAPSHOT_LIMIT = 256 * 1_024;
const CONTROL_LIMIT = 16 * 1_024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PeerControlMessage =
  | { kind: "hello"; protocol: 1; playerId: RobotColor; mapId: MapId }
  | { kind: "ready"; protocol: 1 }
  | { kind: "finished"; protocol: 1; elapsedTicks: number }
  | { kind: "failed"; protocol: 1; reason: string };
export type PeerInputMessage = { kind: "input" } & ClientInput;
export interface PeerSnapshotMessage { kind: "snapshot"; snapshot: ServerSnapshot; }
export type PeerMessage = PeerControlMessage | PeerInputMessage | PeerSnapshotMessage;

export class PeerProtocolError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function finiteAxis(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseControl(value: unknown): PeerControlMessage {
  if (!record(value) || value.protocol !== 1 || typeof value.kind !== "string") throw new PeerProtocolError("Invalid control message.");
  if (value.kind === "hello" && exact(value, ["kind", "protocol", "playerId", "mapId"])
    && (value.playerId === "blue" || value.playerId === "orange" || value.playerId === "green" || value.playerId === "purple")
    && isMapId(value.mapId)) return value as unknown as PeerControlMessage;
  if (value.kind === "ready" && exact(value, ["kind", "protocol"])) return { kind: "ready", protocol: 1 };
  if (value.kind === "finished" && exact(value, ["kind", "protocol", "elapsedTicks"]) && count(value.elapsedTicks)) {
    return { kind: "finished", protocol: 1, elapsedTicks: value.elapsedTicks };
  }
  if (value.kind === "failed" && exact(value, ["kind", "protocol", "reason"])
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 256) {
    return { kind: "failed", protocol: 1, reason: value.reason };
  }
  throw new PeerProtocolError("Invalid control message.");
}

function parseInput(value: unknown, lastInputSequence: number): PeerInputMessage {
  if (!record(value) || !exact(value, ["kind", "sequence", "clientTick", "moveX", "moveZ", "jump"])
    || value.kind !== "input" || !count(value.sequence) || value.sequence <= lastInputSequence
    || !count(value.clientTick) || !finiteAxis(value.moveX) || !finiteAxis(value.moveZ)
    || typeof value.jump !== "boolean") throw new PeerProtocolError("Invalid input message.");
  return value as unknown as PeerInputMessage;
}

function frame(prefix: number, value: unknown, limit: number): ArrayBuffer {
  const body = encoder.encode(JSON.stringify(value));
  if (body.byteLength + 1 > limit) throw new PeerProtocolError("Peer message is too large.");
  const result = new Uint8Array(body.byteLength + 1);
  result[0] = prefix;
  result.set(body, 1);
  return result.buffer;
}

export function encodePeerMessage(message: PeerMessage): ArrayBuffer {
  if (message.kind === "snapshot") {
    const parsed = parseServerMessage(JSON.stringify(message.snapshot));
    if (parsed.type !== "snapshot") throw new PeerProtocolError("Invalid snapshot message.");
    return frame(SNAPSHOT, parsed, SNAPSHOT_LIMIT);
  }
  if (message.kind === "input") return frame(INPUT, parseInput(message, -1), INPUT_LIMIT);
  return frame(CONTROL, parseControl(message), CONTROL_LIMIT);
}

export function parsePeerMessage(
  bytes: ArrayBuffer | ArrayBufferView,
  state: { lastInputSequence?: number } = {},
): PeerMessage {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 2) throw new PeerProtocolError("Invalid peer message.");
  const prefix = view[0];
  const limit = prefix === CONTROL ? CONTROL_LIMIT : prefix === INPUT ? INPUT_LIMIT : prefix === SNAPSHOT ? SNAPSHOT_LIMIT : 0;
  if (limit === 0 || view.byteLength > limit) throw new PeerProtocolError("Invalid peer message.");
  let value: unknown;
  try { value = JSON.parse(decoder.decode(view.subarray(1))); }
  catch { throw new PeerProtocolError("Invalid peer message encoding."); }
  if (prefix === CONTROL) return parseControl(value);
  if (prefix === INPUT) return parseInput(value, state.lastInputSequence ?? -1);
  const snapshot = parseServerMessage(JSON.stringify(value));
  if (snapshot.type !== "snapshot") throw new PeerProtocolError("Invalid snapshot message.");
  return { kind: "snapshot", snapshot };
}
