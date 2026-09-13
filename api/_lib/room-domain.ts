import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  isMapId,
  type MapId,
  type RobotColor,
  type RoomSession,
  type RoomState,
  type RoomStatus,
} from "../../shared/lobby-contract.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PLAYER_SLOTS: ReadonlyArray<{ color: RobotColor; name: string }> = [
  { color: "blue", name: "Blue Robot" },
  { color: "orange", name: "Orange Robot" },
  { color: "green", name: "Green Robot" },
  { color: "purple", name: "Purple Robot" },
];
const PRESENCE_MAX_AGE_MS = 30_000;

export type RoomErrorCode =
  | "invalid_capacity"
  | "invalid_code"
  | "invalid_map"
  | "room_not_found"
  | "room_full"
  | "already_starting"
  | "already_in_game"
  | "not_enough_players"
  | "invalid_session"
  | "not_host"
  | "players_not_present"
  | "contention";

export class RoomDomainError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomDomainError";
    this.code = code;
  }
}

export interface StoredPlayer {
  id: string;
  name: string;
  color: RobotColor;
  tokenDigest: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface RoomRecord {
  id: string;
  code: string;
  capacity: 2 | 3 | 4;
  status: RoomStatus;
  createdAt: string;
  version: number;
  mapId: MapId;
  matchId: string | null;
  hostPlayerId: string;
  players: StoredPlayer[];
}

export interface RoomGenerators {
  code(): string;
  uuid(): string;
  token(): string;
}

export interface RoomCreation {
  room: RoomRecord;
  session: RoomSession;
}

const defaults: RoomGenerators = {
  code: () => {
    const bytes = randomBytes(4);
    return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  },
  uuid: () => randomUUID(),
  token: () => randomBytes(32).toString("base64url"),
};

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(storedDigest: string, rawToken: string): boolean {
  const supplied = digestToken(rawToken);
  if (storedDigest.length !== 64 || supplied.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index++) {
    difference |= supplied.charCodeAt(index) ^ storedDigest.charCodeAt(index);
  }
  return difference === 0;
}

function sessionPlayer(room: RoomRecord, rawToken: string): StoredPlayer {
  const player = room.players.find((candidate) => tokenMatches(candidate.tokenDigest, rawToken));
  if (!player) throw new RoomDomainError("invalid_session", "The room session is invalid.");
  return player;
}

function copy(room: RoomRecord): RoomRecord {
  return { ...room, players: room.players.map((player) => ({ ...player })) };
}

function ensureWaiting(room: RoomRecord): void {
  if (room.status === "starting") {
    throw new RoomDomainError("already_starting", "The room is already starting.");
  }
  if (room.status === "inGame") {
    throw new RoomDomainError("already_in_game", "The room is already in a match.");
  }
}

export function createRoom(
  capacity: 2 | 3 | 4,
  now: Date,
  generators: RoomGenerators = defaults,
): RoomCreation {
  if (![2, 3, 4].includes(capacity)) {
    throw new RoomDomainError("invalid_capacity", "Room capacity must be between two and four.");
  }
  const code = generators.code().toUpperCase();
  if (!new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(code)) {
    throw new RoomDomainError("invalid_code", "Room code must contain four unambiguous characters.");
  }
  const rawToken = generators.token();
  const playerId = generators.uuid();
  const timestamp = now.toISOString();
  return {
    room: {
      id: generators.uuid(),
      code,
      capacity,
      status: "waiting",
      createdAt: timestamp,
      version: 1,
      mapId: "classic-ascent",
      matchId: null,
      hostPlayerId: playerId,
      players: [{
        id: playerId,
        ...PLAYER_SLOTS[0]!,
        tokenDigest: digestToken(rawToken),
        joinedAt: timestamp,
        lastSeenAt: timestamp,
      }],
    },
    session: { playerId, token: rawToken },
  };
}

export function joinRoom(
  source: RoomRecord,
  now: Date,
  generators: RoomGenerators = defaults,
): RoomCreation {
  ensureWaiting(source);
  if (source.players.length >= source.capacity) {
    throw new RoomDomainError("room_full", "The room is full.");
  }
  const room = copy(source);
  const slot = PLAYER_SLOTS.find((candidate) =>
    room.players.every((player) => player.color !== candidate.color))!;
  const token = generators.token();
  const playerId = generators.uuid();
  const timestamp = now.toISOString();
  room.players.push({
    id: playerId,
    ...slot,
    tokenDigest: digestToken(token),
    joinedAt: timestamp,
    lastSeenAt: timestamp,
  });
  room.version++;
  return { room, session: { playerId, token } };
}

export function leaveRoom(source: RoomRecord, rawToken: string): RoomRecord | undefined {
  if (source.status === "inGame") {
    throw new RoomDomainError("already_in_game", "The room is already in a match.");
  }
  const leaving = sessionPlayer(source, rawToken);
  const room = copy(source);
  room.players = room.players.filter((player) => player.id !== leaving.id);
  if (room.players.length === 0) return undefined;
  if (room.hostPlayerId === leaving.id) room.hostPlayerId = room.players[0]!.id;
  if (room.status === "starting") {
    room.status = "waiting";
    room.matchId = null;
  }
  room.version++;
  return room;
}

export function setRoomMap(source: RoomRecord, rawToken: string, mapId: MapId): RoomRecord {
  const actor = sessionPlayer(source, rawToken);
  if (actor.id !== source.hostPlayerId) {
    throw new RoomDomainError("not_host", "Only the host can select the map.");
  }
  ensureWaiting(source);
  if (!isMapId(mapId)) {
    throw new RoomDomainError("invalid_map", "The selected map is not available.");
  }
  const room = copy(source);
  room.mapId = mapId;
  room.version++;
  return room;
}

export function touchPresence(source: RoomRecord, rawToken: string, now: Date): RoomRecord {
  const actor = sessionPlayer(source, rawToken);
  const room = copy(source);
  room.players.find((player) => player.id === actor.id)!.lastSeenAt = now.toISOString();
  room.version++;
  return room;
}

export function startRoom(
  source: RoomRecord,
  rawToken: string,
  now: Date,
  generators: RoomGenerators = defaults,
  presenceMaxAgeMs = PRESENCE_MAX_AGE_MS,
): RoomRecord {
  const actor = sessionPlayer(source, rawToken);
  if (actor.id !== source.hostPlayerId) {
    throw new RoomDomainError("not_host", "Only the host can start the room.");
  }
  ensureWaiting(source);
  if (source.players.length !== source.capacity) {
    throw new RoomDomainError("not_enough_players", "The room needs more players to start.");
  }
  if (source.players.some((player) => now.getTime() - new Date(player.lastSeenAt).getTime() > presenceMaxAgeMs)) {
    throw new RoomDomainError("players_not_present", "Every player must be present before starting.");
  }
  const room = copy(source);
  room.status = "starting";
  room.matchId = generators.uuid();
  room.version++;
  return room;
}

export function publicRoom(room: RoomRecord): RoomState {
  return {
    id: room.id,
    code: room.code,
    capacity: room.capacity,
    status: room.status,
    createdAt: room.createdAt,
    version: room.version,
    mapId: room.mapId,
    matchId: room.matchId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      isHost: player.id === room.hostPlayerId,
    })),
  };
}
