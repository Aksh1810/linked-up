import { LobbyApi, type NotModified } from "./lobby-api.ts";
import { normalizeRoomCode, type MapId, type RoomPlayer, type RoomState } from "./lobby-state.ts";

export interface PeerMatchLaunch {
  protocol: 1;
  roomCode: string;
  matchId: string;
  mapId: MapId;
  players: RoomPlayer[];
  localPlayer: RoomPlayer;
  role: "host" | "guest";
  countdownSeconds: 3;
}

export interface LobbyPollingHandlers {
  onRoom(room: RoomState): void;
  onMatch?(launch: PeerMatchLaunch): void;
  onStatus?(status: "connecting" | "connected" | "reconnecting" | "disconnected"): void;
  onError?(message: string): void;
}

export interface LobbyPollingApi {
  getRoom(code: string): Promise<RoomState>;
  getRoom(code: string, etag: string): Promise<RoomState | NotModified>;
  presence(code: string, token: string): Promise<void>;
}

export interface PollingScheduler {
  setTimeout(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface VisibilityState { readonly hidden: boolean; }

const browserScheduler: PollingScheduler = {
  setTimeout(callback, milliseconds) {
    return window.setTimeout(() => { void callback(); }, milliseconds);
  },
  clearTimeout(id) { window.clearTimeout(id as number); },
};

const failureDelays = [1_000, 2_000, 5_000, 10_000] as const;

function isNotModified(value: RoomState | NotModified): value is NotModified {
  return "notModified" in value && value.notModified;
}

export class LobbyPollingConnection {
  readonly #code: string;
  readonly #token: string;
  readonly #playerId: string;
  readonly #handlers: LobbyPollingHandlers;
  readonly #api: LobbyPollingApi;
  readonly #scheduler: PollingScheduler;
  readonly #visibility: VisibilityState;
  #active = false;
  #timer: unknown;
  #etag: string | undefined;
  #failureCount = 0;
  #reconnecting = false;
  #launchedMatchId: string | undefined;

  constructor(
    code: string,
    token: string,
    playerId: string,
    handlers: LobbyPollingHandlers,
    api: LobbyPollingApi = new LobbyApi(),
    scheduler: PollingScheduler = browserScheduler,
    visibility: VisibilityState = document,
  ) {
    this.#code = normalizeRoomCode(code);
    this.#token = token;
    this.#playerId = playerId;
    this.#handlers = handlers;
    this.#api = api;
    this.#scheduler = scheduler;
    this.#visibility = visibility;
  }

  async connect(): Promise<RoomState> {
    this.#active = true;
    this.#handlers.onStatus?.("connecting");
    try {
      const room = await this.#api.getRoom(this.#code);
      if (!this.#active) throw new Error("Lobby connection stopped.");
      this.#acceptRoom(room);
      await this.#api.presence(this.#code, this.#token);
      if (!this.#active) throw new Error("Lobby connection stopped.");
      this.#handlers.onStatus?.("connected");
      this.#schedule(this.#visibility.hidden ? 10_000 : 1_000);
      return room;
    } catch (error) {
      if (this.#active) {
        this.#active = false;
        this.#handlers.onStatus?.("disconnected");
        this.#reportError("Could not connect to the room.");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#active = false;
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): Promise<void> { return this.stop(); }

  #schedule(milliseconds: number): void {
    if (!this.#active) return;
    this.#timer = this.#scheduler.setTimeout(async () => {
      this.#timer = undefined;
      await this.#poll();
    }, milliseconds);
  }

  async #poll(): Promise<void> {
    if (!this.#active) return;
    try {
      const response = this.#etag
        ? await this.#api.getRoom(this.#code, this.#etag)
        : await this.#api.getRoom(this.#code);
      if (!this.#active) return;
      if (!isNotModified(response)) this.#acceptRoom(response);
      else this.#etag = response.etag;
      await this.#api.presence(this.#code, this.#token);
      if (!this.#active) return;
      this.#failureCount = 0;
      if (this.#reconnecting) {
        this.#reconnecting = false;
        this.#handlers.onStatus?.("connected");
      }
      this.#schedule(this.#visibility.hidden ? 10_000 : 1_000);
    } catch {
      if (!this.#active) return;
      if (!this.#reconnecting) {
        this.#reconnecting = true;
        this.#handlers.onStatus?.("reconnecting");
      }
      const delay = failureDelays[Math.min(this.#failureCount, failureDelays.length - 1)]!;
      this.#failureCount++;
      this.#schedule(delay);
    }
  }

  #acceptRoom(room: RoomState): void {
    this.#etag = `"room-${room.version}"`;
    this.#handlers.onRoom(room);
    if (room.status !== "starting" || room.matchId === null || this.#launchedMatchId === room.matchId) return;
    const localPlayer = room.players.find((player) => player.id === this.#playerId);
    if (!localPlayer) {
      this.#reportError("Your player is no longer in this room.");
      return;
    }
    this.#launchedMatchId = room.matchId;
    this.#handlers.onMatch?.({
      protocol: 1,
      roomCode: room.code,
      matchId: room.matchId,
      mapId: room.mapId,
      players: room.players.map((player) => ({ ...player })),
      localPlayer: { ...localPlayer },
      role: localPlayer.isHost ? "host" : "guest",
      countdownSeconds: 3,
    });
  }

  #reportError(message: string): void {
    try { this.#handlers.onError?.(message); } catch {}
  }
}
