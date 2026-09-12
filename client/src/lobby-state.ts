export type RobotColor = "blue" | "orange" | "green" | "purple";
export type RoomStatus = "waiting" | "starting" | "inGame";
export const mapNames = {
  "classic-ascent": "Classic Ascent",
  "relay-ridge": "Relay Ridge",
  "crane-shift": "Crane Shift",
  windworks: "Windworks",
} as const;
export type MapId = keyof typeof mapNames;

export interface RoomPlayer {
  id: string;
  name: string;
  color: RobotColor;
  isHost: boolean;
}

export interface RoomState {
  id: string;
  code: string;
  capacity: 2 | 3 | 4;
  status: RoomStatus;
  createdAt: string;
  version: number;
  mapId: MapId;
  matchId: string | null;
  players: RoomPlayer[];
}

export interface RoomSession { playerId: string; token: string; }

const colors = new Set<RobotColor>(["blue", "orange", "green", "purple"]);
const statuses = new Set<RoomStatus>(["waiting", "starting", "inGame"]);
const roomCode = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]00:00)$/;
const playerNames: Record<RobotColor, string> = {
  blue: "Blue Robot",
  orange: "Orange Robot",
  green: "Green Robot",
  purple: "Purple Robot",
};

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

function validUtcTimestamp(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const match = utcTimestamp.exec(value);
  if (!match) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 19) === match[1];
}

function parsePlayer(value: unknown): RoomPlayer {
  if (!record(value) || !ownKeys(value, ["id", "name", "color", "isHost"])
    || !nonEmptyString(value.id) || !uuid.test(value.id) || !nonEmptyString(value.name)
    || !colors.has(value.color as RobotColor) || value.name !== playerNames[value.color as RobotColor]
    || typeof value.isHost !== "boolean") {
    throw new TypeError("Invalid room player.");
  }
  return { id: value.id, name: value.name, color: value.color as RobotColor, isHost: value.isHost };
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isMapId(value: unknown): value is MapId {
  return typeof value === "string" && Object.hasOwn(mapNames, value);
}

export function mapName(mapId: MapId): string {
  return mapNames[mapId];
}

export function parseRoom(value: unknown): RoomState {
  const capacity = record(value) ? value.capacity : undefined;
  const status = record(value) ? value.status : undefined;
  const version = record(value) ? value.version : undefined;
  const matchId = record(value) ? value.matchId : undefined;
  if (!record(value) || !ownKeys(value, [
    "id", "code", "capacity", "status", "createdAt", "version", "mapId", "matchId", "players",
  ]) || !nonEmptyString(value.id) || !nonEmptyString(value.code)
    || !uuid.test(value.id) || !roomCode.test(value.code) || typeof capacity !== "number"
    || ![2, 3, 4].includes(capacity) || !statuses.has(status as RoomStatus) || !isMapId(value.mapId)
    || !validUtcTimestamp(value.createdAt) || !Number.isSafeInteger(version)
    || (version as number) <= 0 || !Array.isArray(value.players)) {
    throw new TypeError("Invalid room.");
  }

  const players = value.players.map(parsePlayer);
  if (players.length > capacity
    || new Set(players.map((player) => player.id)).size !== players.length
    || new Set(players.map((player) => player.color)).size !== players.length
    || (players.length > 0 && players.filter((player) => player.isHost).length !== 1)
    || ((status === "starting" || status === "inGame") && players.length !== capacity)
    || (status === "inGame" ? typeof matchId !== "string" || !uuid.test(matchId) : matchId !== null)) {
    throw new TypeError("Invalid room players.");
  }

  return {
    id: value.id,
    code: value.code,
    capacity: capacity as 2 | 3 | 4,
    status: status as RoomStatus,
    createdAt: value.createdAt,
    version: version as number,
    mapId: value.mapId,
    matchId: matchId as string | null,
    players,
  };
}

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
