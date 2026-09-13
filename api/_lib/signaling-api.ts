import { parseSignalEnvelope } from "../../shared/signaling-contract.ts";
import { HttpError, jsonResponse, problemResponse, readJson } from "./http.ts";
import { RedisSignalStore } from "./redis-signal-store.ts";
import type { SignalStore } from "./signal-store.ts";
import { RedisRateLimiter, type RateLimiter } from "./rate-limit.ts";
import { RedisRoomStore } from "./redis-room-store.ts";
import type { RoomStore } from "./room-store.ts";
import { RoomDomainError, authenticateRoomSession } from "./room-domain.ts";

export interface SignalingApiDependencies {
  roomStore: RoomStore;
  signalStore: SignalStore;
  limiter: RateLimiter;
  clientIdentity(request: Request): string;
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return problemResponse(error.status, error.title);
  if (error instanceof RoomDomainError) {
    if (error.code === "invalid_session") return problemResponse(401, "Invalid room session");
    if (error.code === "room_not_found") return problemResponse(404, "Room not found");
  }
  return problemResponse(503, "Signaling service unavailable");
}

async function rateLimit(
  request: Request,
  dependencies: SignalingApiDependencies,
  scope: "signal-write" | "signal-poll",
  code: string,
): Promise<Response | undefined> {
  const result = await dependencies.limiter.consume(
    scope,
    `${dependencies.clientIdentity(request)}:${code}`,
    scope === "signal-write" ? 120 : 180,
    60,
  );
  if (result.allowed) return undefined;
  const response = problemResponse(429, "Too many requests");
  response.headers.set("Retry-After", String(result.retryAfter));
  return response;
}

export async function handleSignalingRequest(
  request: Request,
  dependencies: SignalingApiDependencies,
): Promise<Response> {
  try {
    const match = /^\/api\/rooms\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4})\/signals$/.exec(new URL(request.url).pathname);
    if (!match) return problemResponse(404, "Room not found");
    if (request.method !== "GET" && request.method !== "POST") return problemResponse(405, "Method not allowed");
    const code = match[1]!;
    const limited = await rateLimit(request, dependencies, request.method === "POST" ? "signal-write" : "signal-poll", code);
    if (limited) return limited;

    const rawToken = request.headers.get("X-Player-Token");
    if (!rawToken) return problemResponse(401, "Invalid room session");
    const room = await dependencies.roomStore.get(code);
    if (!room) throw new RoomDomainError("room_not_found", "The room does not exist.");
    const player = authenticateRoomSession(room, rawToken);

    if (request.method === "POST") {
      const envelope = parseSignalEnvelope(await readJson(request));
      if (envelope.senderId !== player.id) return problemResponse(403, "Signal sender rejected");
      if (!room.players.some((candidate) => candidate.id === envelope.recipientId)) {
        return problemResponse(403, "Signal recipient rejected");
      }
      const cursor = await dependencies.signalStore.append(code, envelope.recipientId, envelope);
      return jsonResponse({ cursor }, 201);
    }

    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "after" && key !== "limit")
      || url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) {
      throw new HttpError(400, "Invalid request");
    }
    const after = url.searchParams.get("after") ?? "0";
    const limitText = url.searchParams.get("limit") ?? "64";
    if (!/^\d+(?:-\d+)?$/.test(after) || !/^\d+$/.test(limitText)) throw new HttpError(400, "Invalid request");
    const limit = Number(limitText);
    if (limit < 1 || limit > 64) throw new HttpError(400, "Invalid request");
    return jsonResponse(await dependencies.signalStore.read(code, player.id, after, limit));
  } catch (error) {
    if (error instanceof TypeError) return problemResponse(400, "Invalid signal");
    return errorResponse(error);
  }
}

let productionSignalStore: RedisSignalStore | undefined;
let productionRoomStore: RedisRoomStore | undefined;
let productionLimiter: RedisRateLimiter | undefined;

export function productionSignalingDependencies(): SignalingApiDependencies {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required.");
  productionSignalStore ??= RedisSignalStore.fromEnvironment();
  productionRoomStore ??= RedisRoomStore.fromEnvironment();
  productionLimiter ??= RedisRateLimiter.fromUrl(url);
  return {
    roomStore: productionRoomStore,
    signalStore: productionSignalStore,
    limiter: productionLimiter,
    clientIdentity: (request) => request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown",
  };
}
