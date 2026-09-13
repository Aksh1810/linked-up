import { createClient, type RedisClientType } from "redis";

import { RoomDomainError, type RoomRecord } from "./room-domain.ts";
import type { Mutation, RoomStore } from "./room-store.ts";

const ROOM_TTL_SECONDS = 7_200;
const MUTATION_ATTEMPTS = 3;
const MUTATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
local decoded = cjson.decode(current)
if tonumber(decoded.version) ~= tonumber(ARGV[1]) then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1
`;

interface RedisOptions {
  allowInsecure?: boolean;
  ttlSeconds?: number;
}

export class RedisRoomStore implements RoomStore {
  #namespace = "linked-up";
  readonly #ttlSeconds: number;
  readonly #client: RedisClientType;

  private constructor(client: RedisClientType, options: RedisOptions = {}) {
    this.#client = client;
    this.#ttlSeconds = options.ttlSeconds ?? ROOM_TTL_SECONDS;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): RedisRoomStore {
    const url = environment.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required.");
    return RedisRoomStore.fromUrl(url, { allowInsecure: environment.NODE_ENV === "test" });
  }

  static fromUrl(url: string, options: RedisOptions = {}): RedisRoomStore {
    const parsed = new URL(url);
    if (!options.allowInsecure && parsed.protocol !== "rediss:") {
      throw new Error("Redis TLS is required outside tests.");
    }
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("REDIS_URL must use redis: or rediss:.");
    }
    return new RedisRoomStore(createClient({ url }) as RedisClientType, options);
  }

  setNamespace(namespace: string): void {
    this.#namespace = namespace.replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  async #ready(): Promise<void> {
    if (!this.#client.isOpen) await this.#client.connect();
  }

  #key(code: string): string {
    return `${this.#namespace}:room:${code}`;
  }

  async create(room: RoomRecord): Promise<void> {
    await this.#ready();
    const result = await this.#client.set(this.#key(room.code), JSON.stringify(room), {
      EX: this.#ttlSeconds,
      NX: true,
    });
    if (result !== "OK") throw new RoomDomainError("contention", "The room code is already in use.");
  }

  async get(code: string): Promise<RoomRecord | undefined> {
    await this.#ready();
    const key = this.#key(code);
    const value = await this.#client.get(key);
    if (value === null) return undefined;
    await this.#client.expire(key, this.#ttlSeconds);
    return JSON.parse(value) as RoomRecord;
  }

  async mutate<T>(code: string, apply: (room: RoomRecord) => Mutation<T>): Promise<T> {
    await this.#ready();
    const key = this.#key(code);
    for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt++) {
      const encoded = await this.#client.get(key);
      if (encoded === null) throw new RoomDomainError("room_not_found", "The room does not exist.");
      const current = JSON.parse(encoded) as RoomRecord;
      const mutation = apply(structuredClone(current));
      const outcome = await this.#client.eval(MUTATE_SCRIPT, {
        keys: [key],
        arguments: [String(current.version), mutation.room ? JSON.stringify(mutation.room) : "", String(this.#ttlSeconds)],
      });
      if (outcome === -1) throw new RoomDomainError("room_not_found", "The room does not exist.");
      if (outcome === 1) return mutation.result;
    }
    throw new RoomDomainError("contention", "The room changed too many times. Please retry.");
  }

  async deleteNamespace(): Promise<void> {
    await this.#ready();
    for await (const keys of this.#client.scanIterator({ MATCH: `${this.#namespace}:*`, COUNT: 100 })) {
      if (keys.length > 0) await this.#client.del(keys);
    }
  }

  async close(): Promise<void> {
    if (this.#client.isOpen) await this.#client.quit();
  }
}
