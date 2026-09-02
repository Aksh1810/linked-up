import { HubConnectionBuilder } from "@microsoft/signalr";

import { lobbyApiUrl } from "./lobby-api.ts";
import { parseMatchLaunch, type MatchLaunch } from "./match-launch.ts";
import { normalizeRoomCode, parseRoom, type RoomState } from "./lobby-state.ts";

export interface LobbyConnectionHandlers {
  onRoom(room: RoomState): void;
  onMatch?(launch: MatchLaunch): void;
  onStatus?(status: "connecting" | "connected" | "reconnecting" | "disconnected"): void;
  onError?(message: string): void;
}

export interface LobbyTransport {
  on(methodName: string, handler: (...args: unknown[]) => unknown): void;
  onreconnecting(handler: (error?: Error) => void): void;
  onreconnected(handler: (connectionId?: string) => void): void;
  onclose(handler: (error?: Error) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T>(methodName: string, ...args: unknown[]): Promise<T>;
}

export type LobbyTransportFactory = (
  hubUrl: string,
  reconnectDelays: readonly number[],
) => LobbyTransport;

const reconnectDelays = [0, 1_000, 3_000, 5_000];

const createLobbyTransport: LobbyTransportFactory = (hubUrl, delays) =>
  new HubConnectionBuilder().withUrl(hubUrl).withAutomaticReconnect([...delays]).build();

export function lobbyHubUrl(apiUrl = lobbyApiUrl): string {
  return new URL("hubs/lobby", `${apiUrl.replace(/\/$/, "")}/`).toString();
}

export class LobbyConnection {
  readonly #code: string;
  readonly #token: string;
  readonly #playerId: string;
  readonly #handlers: LobbyConnectionHandlers;
  readonly #connection: LobbyTransport;

  constructor(
    code: string,
    token: string,
    playerId: string,
    handlers: LobbyConnectionHandlers,
    hubUrl = lobbyHubUrl(),
    transportFactory: LobbyTransportFactory = createLobbyTransport,
  ) {
    this.#code = normalizeRoomCode(code);
    this.#token = token;
    this.#playerId = playerId;
    this.#handlers = handlers;
    this.#connection = transportFactory(hubUrl, reconnectDelays);

    this.#connection.on("RoomUpdated", (room: unknown) => this.#receive(room));
    this.#connection.on("MatchReady", (launch: unknown) => this.#receiveMatch(launch));
    this.#connection.onreconnecting(() => this.#handlers.onStatus?.("reconnecting"));
    this.#connection.onreconnected(async () => {
      let room: RoomState;
      try {
        room = await this.#subscribe();
      } catch {
        this.#reportError("Could not reconnect to the room.");
        return;
      }
      try {
        this.#handlers.onRoom(room);
        this.#handlers.onStatus?.("connected");
      } catch {
      }
    });
    this.#connection.onclose(() => this.#handlers.onStatus?.("disconnected"));
  }

  async connect(): Promise<RoomState> {
    this.#handlers.onStatus?.("connecting");
    let room: RoomState;
    try {
      await this.#connection.start();
      room = await this.#subscribe();
    } catch (error) {
      this.#handlers.onStatus?.("disconnected");
      this.#reportError("Could not connect to the room.");
      throw error;
    }
    this.#handlers.onRoom(room);
    this.#handlers.onStatus?.("connected");
    return room;
  }

  stop(): Promise<void> {
    return this.#connection.stop();
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  async #subscribe(): Promise<RoomState> {
    return parseRoom(await this.#connection.invoke<unknown>("Subscribe", this.#code, this.#token));
  }

  #receive(value: unknown): void {
    let room: RoomState;
    try {
      room = parseRoom(value);
    } catch {
      this.#reportError("The room server sent an invalid update.");
      return;
    }
    this.#handlers.onRoom(room);
  }

  #receiveMatch(value: unknown): void {
    let launch: MatchLaunch;
    try {
      launch = parseMatchLaunch(value, this.#playerId);
    } catch {
      this.#reportError("The room server sent an invalid match launch.");
      return;
    }
    this.#handlers.onMatch?.(launch);
  }

  #reportError(message: string): void {
    try {
      this.#handlers.onError?.(message);
    } catch {}
  }
}
