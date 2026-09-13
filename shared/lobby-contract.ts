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

export interface RoomSession {
  playerId: string;
  token: string;
}

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
    || (status === "waiting" ? matchId !== null : typeof matchId !== "string" || !uuid.test(matchId))) {
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
