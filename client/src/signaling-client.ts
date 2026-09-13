import { normalizeRoomCode } from "./lobby-state.ts";
import { parseSignalEnvelope, type SignalEnvelope } from "../../shared/signaling-contract.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export class SignalingClient {
  readonly #code: string;
  readonly #token: string;
  readonly #playerId: string;
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;
  #cursor = "0";

  constructor(code: string, token: string, playerId: string, baseUrl = location.origin, fetcher: typeof fetch = fetch) {
    this.#code = normalizeRoomCode(code);
    this.#token = token;
    this.#playerId = playerId;
    this.#baseUrl = baseUrl;
    this.#fetcher = fetcher;
  }

  get cursor(): string { return this.#cursor; }

  async send(envelope: SignalEnvelope): Promise<void> {
    const parsed = parseSignalEnvelope(envelope);
    if (parsed.senderId !== this.#playerId) throw new TypeError("Signal sender does not match this session.");
    const response = await this.#request("", { method: "POST", body: JSON.stringify(parsed) });
    const body = await response.json() as unknown;
    if (!record(body) || !exact(body, ["cursor"]) || typeof body.cursor !== "string" || !/^\d+(?:-\d+)?$/.test(body.cursor)) {
      throw new TypeError("Invalid signaling response.");
    }
  }

  async poll(): Promise<SignalEnvelope[]> {
    const response = await this.#request(`?after=${encodeURIComponent(this.#cursor)}&limit=64`, { method: "GET" });
    const body = await response.json() as unknown;
    if (!record(body) || !exact(body, ["signals", "cursor"]) || !Array.isArray(body.signals)
      || typeof body.cursor !== "string" || !/^\d+(?:-\d+)?$/.test(body.cursor)) {
      throw new TypeError("Invalid signaling response.");
    }
    const envelopes = body.signals.map((item) => {
      if (!record(item) || !exact(item, ["cursor", "envelope"]) || typeof item.cursor !== "string"
        || !/^\d+(?:-\d+)?$/.test(item.cursor)) throw new TypeError("Invalid signaling response.");
      return parseSignalEnvelope(item.envelope);
    });
    this.#cursor = body.cursor;
    return envelopes;
  }

  async #request(query: string, init: RequestInit): Promise<Response> {
    const response = await this.#fetcher.call(globalThis,
      new URL(`/api/rooms/${encodeURIComponent(this.#code)}/signals${query}`, this.#baseUrl), {
        ...init,
        headers: {
          "X-Player-Token": this.#token,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    if (!response.ok) throw new Error("Signaling request failed.");
    return response;
  }
}
