import {
  normalizeRoomCode,
  parseRoom,
  type MapId,
  type RoomSession,
  type RoomState,
} from "./lobby-state.ts";

export interface RoomSessionResponse { room: RoomState; session: RoomSession; }
export interface NotModified { notModified: true; etag: string; }

const browserOrigin = typeof location === "undefined" ? "http://127.0.0.1:5000" : location.origin;
export const lobbyApiUrl = import.meta.env?.VITE_LOBBY_API_URL ?? browserOrigin;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function friendlyProblemMessage(problem: unknown): string {
  const details = typeof problem === "object" && problem !== null
    ? problem as { status?: unknown; title?: unknown }
    : {};
  if (details.status === 404) return "This room no longer exists.";
  if (details.status === 503) return "The room service is temporarily unavailable.";
  if (details.status === 409 && details.title === "Room full") return "This room is full.";
  if (details.status === 409 && details.title === "Room already starting") {
    return "This room is already starting.";
  }
  if (details.status === 409 && details.title === "Room not full") {
    return "This room needs more players before starting.";
  }
  if (details.status === 401) return "Your room session is no longer valid.";
  if (details.status === 403) return "Only the host can start this room.";
  return "The room request could not be completed.";
}

export class LobbyApiError extends Error {
  readonly status: number;

  constructor(status: number, problem: unknown) {
    super(friendlyProblemMessage(problem));
    this.name = "LobbyApiError";
    this.status = status;
  }
}

function parseSessionResponse(value: unknown): RoomSessionResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "room")
    || !Object.hasOwn(value, "session")) {
    throw new TypeError("Invalid room session response.");
  }
  const response = value as Record<PropertyKey, unknown>;
  const session = response.session;
  const sessionRecord = typeof session === "object" && session !== null
    ? session as Record<PropertyKey, unknown>
    : undefined;
  if (typeof session !== "object" || session === null || Array.isArray(session)
    || Reflect.ownKeys(session).length !== 2 || !Object.hasOwn(session, "playerId")
    || !Object.hasOwn(session, "token") || typeof sessionRecord?.playerId !== "string"
    || !uuid.test(sessionRecord.playerId) || typeof sessionRecord.token !== "string" || sessionRecord.token.length === 0) {
    throw new TypeError("Invalid room session response.");
  }
  return {
    room: parseRoom(response.room),
    session: { playerId: sessionRecord!.playerId, token: sessionRecord!.token },
  };
}

export class LobbyApi {
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;

  constructor(baseUrl = lobbyApiUrl, fetcher: typeof fetch = fetch) {
    this.#baseUrl = baseUrl;
    this.#fetcher = fetcher;
  }

  createRoom(capacity: 2 | 3 | 4): Promise<RoomSessionResponse> {
    return this.request("/api/rooms", { method: "POST", body: JSON.stringify({ capacity }) }, parseSessionResponse);
  }

  getRoom(code: string): Promise<RoomState>;
  getRoom(code: string, etag: string): Promise<RoomState | NotModified>;
  async getRoom(code: string, etag?: string): Promise<RoomState | NotModified> {
    const response = await this.#fetcher.call(globalThis,
      new URL(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}`, this.#baseUrl), {
        headers: etag ? { "If-None-Match": etag } : undefined,
      });
    if (response.status === 304 && etag !== undefined) {
      return { notModified: true, etag: response.headers.get("ETag") ?? etag };
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => undefined);
      throw new LobbyApiError(response.status, problem);
    }
    return parseRoom(await response.json());
  }

  joinRoom(code: string): Promise<RoomSessionResponse> {
    return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/join`, { method: "POST" }, parseSessionResponse);
  }

  leaveRoom(code: string, token: string): Promise<void> {
    return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/leave`, {
      method: "POST", headers: { "X-Player-Token": token },
    }, () => undefined);
  }

  startRoom(code: string, token: string): Promise<RoomState> {
    return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/start`, {
      method: "POST", headers: { "X-Player-Token": token },
    }, parseRoom);
  }

  setMap(code: string, token: string, mapId: MapId): Promise<RoomState> {
    return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/map`, {
      method: "POST", headers: { "X-Player-Token": token }, body: JSON.stringify({ mapId }),
    }, parseRoom);
  }

  presence(code: string, token: string): Promise<void> {
    return this.request(`/api/rooms/${encodeURIComponent(normalizeRoomCode(code))}/presence`, {
      method: "POST", headers: { "X-Player-Token": token },
    }, () => undefined);
  }

  private async request<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    const response = await this.#fetcher.call(globalThis, new URL(path, this.#baseUrl), {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => undefined);
      throw new LobbyApiError(response.status, problem);
    }
    return parse(response.status === 204 ? undefined : await response.json());
  }
}
