import {
  normalizeRoomCode,
  type RoomSession,
  type RoomState,
} from "../../shared/lobby-contract.ts";

export {
  isMapId,
  mapName,
  mapNames,
  normalizeRoomCode,
  parseRoom,
  type MapId,
  type RobotColor,
  type RoomPlayer,
  type RoomSession,
  type RoomState,
  type RoomStatus,
} from "../../shared/lobby-contract.ts";

function record(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSession(value: unknown): RoomSession {
  if (!record(value) || !ownKeys(value, ["playerId", "token"])
    || !nonEmptyString(value.playerId) || !uuid.test(value.playerId) || !nonEmptyString(value.token)) {
    throw new TypeError("Invalid room session.");
  }
  return { playerId: value.playerId, token: value.token };
}

function sessionKey(code: string): string {
  return `linked-up:room:${normalizeRoomCode(code)}`;
}

export function saveRoomSession(storage: Storage, code: string, session: RoomSession): void {
  storage.setItem(sessionKey(code), JSON.stringify(parseSession(session)));
}

export function loadRoomSession(storage: Storage, code: string): RoomSession | undefined {
  const key = sessionKey(code);
  const encoded = storage.getItem(key);
  if (encoded === null) return undefined;
  try {
    return parseSession(JSON.parse(encoded));
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function clearRoomSession(storage: Storage, code: string): void {
  storage.removeItem(sessionKey(code));
}

export function canStart(room: RoomState, playerId: string): boolean {
  return room.status === "waiting" && room.players.length === room.capacity
    && room.players.some((player) => player.id === playerId && player.isHost);
}

export function canSelectMap(room: RoomState, playerId: string): boolean {
  return room.status === "waiting"
    && room.players.some((player) => player.id === playerId && player.isHost);
}
