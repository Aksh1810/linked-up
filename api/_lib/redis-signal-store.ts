import { createHash, createHmac } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import { parseSignalEnvelope, type SignalEnvelope } from "../../shared/signaling-contract.ts";
import type { SignalReadResult, SignalStore } from "./signal-store.ts";

const SIGNAL_TTL_SECONDS = 7_200;

export function parseStoredSignalEnvelope(value: string): SignalEnvelope {
  return parseSignalEnvelope(JSON.parse(value));
}

export class RedisSignalStore implements SignalStore {
  readonly #client: RedisClientType;
  readonly #secret: string;

  private constructor(client: RedisClientType, secret: string) {
    this.#client = client;
    this.#secret = secret;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): RedisSignalStore {
    const url = environment.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for signaling.");
    if (new URL(url).protocol !== "rediss:") throw new Error("Redis TLS is required.");
    const secret = createHash("sha256").update("linked-up/signaling/v1\0").update(url).digest("hex");
    return new RedisSignalStore(createClient({ url }) as RedisClientType, secret);
  }

  async #ready(): Promise<void> {
    if (!this.#client.isOpen) await this.#client.connect();
  }

  #key(code: string, recipientId: string): string {
    const room = createHmac("sha256", this.#secret).update(code).digest("hex");
    return `linked-up:signal:${room}:${recipientId}`;
  }

  async append(code: string, recipientId: string, envelope: SignalEnvelope): Promise<string> {
    await this.#ready();
    const key = this.#key(code, recipientId);
    const cursor = await this.#client.xAdd(key, "*", { envelope: JSON.stringify(envelope) });
    await this.#client.expire(key, SIGNAL_TTL_SECONDS);
    return cursor;
  }

  async read(code: string, recipientId: string, after: string, limit: number): Promise<SignalReadResult> {
    await this.#ready();
    const key = this.#key(code, recipientId);
    const start = after === "0" ? "-" : `(${after}`;
    const entries = await this.#client.xRange(key, start, "+", { COUNT: limit });
    await this.#client.expire(key, SIGNAL_TTL_SECONDS);
    const signals = entries.map((entry) => ({
      cursor: entry.id,
      envelope: parseStoredSignalEnvelope(entry.message.envelope),
    }));
    return { signals, cursor: signals.at(-1)?.cursor ?? after };
  }
}
