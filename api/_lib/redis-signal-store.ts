import { createHmac } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import { parseSignalEnvelope, type SignalEnvelope } from "../../shared/signaling-contract.ts";
import type { SignalReadResult, SignalStore } from "./signal-store.ts";

const SIGNAL_TTL_SECONDS = 7_200;

export class RedisSignalStore implements SignalStore {
  readonly #client: RedisClientType;
  readonly #secret: string;

  private constructor(client: RedisClientType, secret: string) {
    this.#client = client;
    this.#secret = secret;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): RedisSignalStore {
    const url = environment.REDIS_URL;
    const secret = environment.SIGNAL_KEY_SECRET;
    if (!url || !secret || secret.length < 32) throw new Error("Secure signaling Redis configuration is required.");
    if (new URL(url).protocol !== "rediss:") throw new Error("Redis TLS is required.");
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
      envelope: parseSignalEnvelope(entry.message.envelope),
    }));
    return { signals, cursor: signals.at(-1)?.cursor ?? after };
  }
}
