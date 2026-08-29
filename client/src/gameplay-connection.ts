import {
  encodeInput,
  parseServerMessage,
  type ClientInput,
  type PlayerId,
  type ServerSnapshot,
  type WelcomeMessage,
} from "./gameplay-protocol";

export interface GameplayConnectionHandlers {
  onWelcome(message: WelcomeMessage): void;
  onSnapshot(message: ServerSnapshot): void;
  onError(message: string): void;
  onStatus(status: "connecting" | "connected" | "disconnected"): void;
}

export class GameplayConnection {
  readonly #url: URL;
  readonly #handlers: GameplayConnectionHandlers;
  #socket?: WebSocket;

  constructor(url: string, player: PlayerId, handlers: GameplayConnectionHandlers) {
    this.#url = new URL(url, window.location.href);
    this.#url.searchParams.set("player", player);
    this.#handlers = handlers;
  }

  connect(): void {
    if (this.#socket) return;
    this.#handlers.onStatus("connecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.onopen = () => this.#handlers.onStatus("connected");
    socket.onmessage = ({ data }) => {
      if (typeof data !== "string") {
        this.#handlers.onError("Gameplay server sent a binary message.");
        socket.close(4002, "invalid server message");
        return;
      }
      try {
        const message = parseServerMessage(data);
        if (message.type === "welcome") this.#handlers.onWelcome(message);
        if (message.type === "snapshot") this.#handlers.onSnapshot(message);
        if (message.type === "error") this.#handlers.onError(message.message);
      } catch {
        this.#handlers.onError("Gameplay server sent an invalid message.");
        socket.close(4002, "invalid server message");
      }
    };
    socket.onerror = () => this.#handlers.onError("Could not connect to the gameplay server.");
    socket.onclose = () => {
      this.#socket = undefined;
      this.#handlers.onStatus("disconnected");
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
