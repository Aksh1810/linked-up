import {
  encodeInput,
  parseServerMessage,
  type ClientInput,
  type PlayerId,
  type ServerSnapshot,
  type WelcomeMessage,
} from "./gameplay-protocol";

export type GameplayConnectionIdentity =
  | { matchId: string; ticket: string }
  | { player: PlayerId };

export interface GameplayTransportHandlers {
  onWelcome(message: WelcomeMessage): void;
  onSnapshot(message: ServerSnapshot): void;
  onError(message: string): void;
  onStatus(status: "connecting" | "connected" | "disconnected"): void;
}

export interface GameplayTransport {
  connect(handlers: GameplayTransportHandlers): void | Promise<void>;
  sendInput(input: ClientInput): boolean;
  dispose(): void;
}

export class GameplayConnection implements GameplayTransport {
  readonly #url: URL;
  #socket?: WebSocket;
  #roster?: readonly PlayerId[];

  constructor(url: string, identity: GameplayConnectionIdentity) {
    this.#url = new URL(url, window.location.href);
    if ("matchId" in identity) {
      this.#url.searchParams.set("match", identity.matchId);
      this.#url.searchParams.set("ticket", identity.ticket);
    } else {
      this.#url.searchParams.set("player", identity.player);
    }
  }

  connect(handlers: GameplayTransportHandlers): void {
    if (this.#socket) return;
    handlers.onStatus("connecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.onopen = () => handlers.onStatus("connected");
    socket.onmessage = ({ data }) => {
      if (typeof data !== "string") {
        handlers.onError("Gameplay server sent a binary message.");
        socket.close(4002, "invalid server message");
        return;
      }
      try {
        const message = parseServerMessage(data, this.#roster);
        if (message.type === "welcome") {
          this.#roster = message.players;
          handlers.onWelcome(message);
        }
        if (message.type === "snapshot") {
          if (!this.#roster) throw new Error("roster mismatch");
          handlers.onSnapshot(message);
        }
        if (message.type === "error") handlers.onError(message.message);
      } catch {
        handlers.onError("Gameplay server sent an invalid message.");
        socket.close(4002, "invalid server message");
      }
    };
    socket.onerror = () => handlers.onError("Could not connect to the gameplay server.");
    socket.onclose = () => {
      this.#socket = undefined;
      handlers.onStatus("disconnected");
    };
  }

  sendInput(input: ClientInput): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(encodeInput(input));
    return true;
  }

  dispose(): void {
    this.#socket?.close(1000, "leaving");
    this.#socket = undefined;
  }
}
