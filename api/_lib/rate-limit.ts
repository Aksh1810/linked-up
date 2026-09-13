import { createClient, type RedisClientType } from "redis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export interface RateLimiter {
  consume(scope: string, identity: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

interface Window { count: number; expiresAt: number }

export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  async consume(scope: string, identity: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const key = `${scope}:${identity}`;
    const currentTime = this.#now();
    let window = this.#windows.get(key);
    if (!window || currentTime >= window.expiresAt) {
      window = { count: 0, expiresAt: currentTime + windowSeconds * 1_000 };
      this.#windows.set(key, window);
    }
    window.count++;
    return window.count <= limit
      ? { allowed: true, retryAfter: 0 }
      : { allowed: false, retryAfter: Math.max(1, Math.ceil((window.expiresAt - currentTime) / 1_000)) };
  }
}

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

export class RedisRateLimiter implements RateLimiter {
  readonly #client: RedisClientType;

  private constructor(client: RedisClientType) { this.#client = client; }

  static fromUrl(url: string): RedisRateLimiter {
    if (new URL(url).protocol !== "rediss:") throw new Error("Redis TLS is required outside tests.");
    return new RedisRateLimiter(createClient({ url }) as RedisClientType);
  }

  async consume(scope: string, identity: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.#client.isOpen) await this.#client.connect();
    const safeIdentity = Buffer.from(identity).toString("base64url");
    const result = await this.#client.eval(SCRIPT, {
      keys: [`linked-up:rate:${scope}:${safeIdentity}`],
      arguments: [String(windowSeconds)],
    }) as [number, number];
    return Number(result[0]) <= limit
      ? { allowed: true, retryAfter: 0 }
      : { allowed: false, retryAfter: Math.max(1, Number(result[1])) };
  }
}
