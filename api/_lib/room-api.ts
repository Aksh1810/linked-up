import {
  RoomDomainError,
  createRoom,
  joinRoom,
  leaveRoom,
  publicRoom,
  setRoomMap,
  startRoom,
  touchPresence,
  type RoomGenerators,
  type RoomRecord,
} from "./room-domain.ts";
import { RedisRoomStore } from "./redis-room-store.ts";
import type { RoomStore } from "./room-store.ts";
import { HttpError, emptyResponse, exactObject, jsonResponse, problemResponse, readJson } from "./http.ts";
import { RedisRateLimiter, type RateLimiter } from "./rate-limit.ts";
import { isMapId } from "../../shared/lobby-contract.ts";

export interface RoomApiDependencies {
  store: RoomStore;
  limiter: RateLimiter;
  now(): Date;
  generators?: RoomGenerators;
  clientIdentity(request: Request): string;
}

const limits: Record<string, readonly [number, number]> = {
  create: [10, 60],
  lookup: [120, 60],
  join: [20, 60],
  mutate: [60, 60],
};

function token(request: Request): string {
  const value = request.headers.get("X-Player-Token");
  if (!value) throw new HttpError(401, "Invalid room session");
  return value;
}

async function limited(
  request: Request,
  dependencies: RoomApiDependencies,
  scope: keyof typeof limits,
  code = "",
): Promise<Response | undefined> {
  const [limit, seconds] = limits[scope]!;
  const identity = `${dependencies.clientIdentity(request)}:${code}`;
  const result = await dependencies.limiter.consume(scope, identity, limit, seconds);
  if (result.allowed) return undefined;
  const response = problemResponse(429, "Too many requests");
  response.headers.set("Retry-After", String(result.retryAfter));
  return response;
}

function sessionResponse(created: { room: RoomRecord; session: { playerId: string; token: string } }): object {
  return { room: publicRoom(created.room), session: created.session };
}

async function create(request: Request, dependencies: RoomApiDependencies): Promise<Response> {
  const body = await readJson(request);
  if (!exactObject(body, ["capacity"]) || typeof body.capacity !== "number" || ![2, 3, 4].includes(body.capacity)) {
    throw new HttpError(400, "Invalid request");
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const created = createRoom(body.capacity as 2 | 3 | 4, dependencies.now(), dependencies.generators);
    try {
      await dependencies.store.create(created.room);
      return jsonResponse(sessionResponse(created), 201);
    } catch (error) {
      if (!(error instanceof RoomDomainError) || error.code !== "contention" || attempt === 9) throw error;
    }
  }
  throw new RoomDomainError("contention", "Could not allocate a room code.");
}

async function getRoom(request: Request, dependencies: RoomApiDependencies, code: string): Promise<Response> {
  const room = await dependencies.store.get(code);
  if (!room) throw new RoomDomainError("room_not_found", "The room does not exist.");
  const etag = `"room-${room.version}"`;
  if (request.headers.get("If-None-Match") === etag) return emptyResponse(304, { ETag: etag });
  return jsonResponse(publicRoom(room), 200, { ETag: etag });
}

async function join(dependencies: RoomApiDependencies, code: string): Promise<Response> {
  const created = await dependencies.store.mutate(code, (room) => {
    const joined = joinRoom(room, dependencies.now(), dependencies.generators);
    return { room: joined.room, result: joined };
  });
  return jsonResponse(sessionResponse(created), 201);
}

async function mutateRoom<T>(
  dependencies: RoomApiDependencies,
  code: string,
  apply: (room: RoomRecord) => { room: RoomRecord | undefined; result: T },
): Promise<T> {
  return await dependencies.store.mutate(code, apply);
}

function domainProblem(error: RoomDomainError): Response {
  const mapping: Record<string, readonly [number, string]> = {
    invalid_capacity: [400, "Invalid capacity"],
    invalid_code: [400, "Invalid room code"],
    invalid_map: [400, "Invalid map"],
    room_not_found: [404, "Room not found"],
    room_full: [409, "Room full"],
    already_starting: [409, "Room already starting"],
    already_in_game: [409, "Room already in game"],
    not_enough_players: [409, "Room not full"],
    players_not_present: [409, "Players not present"],
    invalid_session: [401, "Invalid room session"],
    not_host: [403, "Host required"],
    contention: [503, "Room service unavailable"],
  };
  const [status, title] = mapping[error.code] ?? [500, "Room request failed"];
  return problemResponse(status, title);
}

export async function handleRoomRequest(request: Request, dependencies: RoomApiDependencies): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/rooms") {
      if (request.method !== "POST") return problemResponse(405, "Method not allowed");
      return await limited(request, dependencies, "create") ?? await create(request, dependencies);
    }

    const match = /^\/api\/rooms\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4})(?:\/(join|leave|map|start|presence))?$/.exec(path);
    if (!match) throw new RoomDomainError("room_not_found", "The room does not exist.");
    const code = match[1]!;
    const action = match[2];
    const scope = action === "join" ? "join" : action ? "mutate" : "lookup";
    const rateResponse = await limited(request, dependencies, scope, code);
    if (rateResponse) return rateResponse;

    if (!action) {
      if (request.method !== "GET") return problemResponse(405, "Method not allowed");
      return await getRoom(request, dependencies, code);
    }
    if (request.method !== "POST") return problemResponse(405, "Method not allowed");
    if (action === "join") return await join(dependencies, code);

    const rawToken = token(request);
    if (action === "leave") {
      await mutateRoom(dependencies, code, (room) => ({ room: leaveRoom(room, rawToken), result: undefined }));
      return emptyResponse();
    }
    if (action === "presence") {
      await mutateRoom(dependencies, code, (room) => {
        const touched = touchPresence(room, rawToken, dependencies.now());
        return { room: touched, result: undefined };
      });
      return emptyResponse();
    }
    if (action === "map") {
      const body = await readJson(request);
      if (!exactObject(body, ["mapId"]) || !isMapId(body.mapId)) throw new HttpError(400, "Invalid request");
      const room = await mutateRoom(dependencies, code, (current) => {
        const changed = setRoomMap(current, rawToken, body.mapId as never);
        return { room: changed, result: changed };
      });
      return jsonResponse(publicRoom(room));
    }
    const room = await mutateRoom(dependencies, code, (current) => {
      const started = startRoom(current, rawToken, dependencies.now(), dependencies.generators);
      return { room: started, result: started };
    });
    return jsonResponse(publicRoom(room));
  } catch (error) {
    if (error instanceof HttpError) return problemResponse(error.status, error.title);
    if (error instanceof RoomDomainError) return domainProblem(error);
    return problemResponse(503, "Room service unavailable");
  }
}

let productionStore: RedisRoomStore | undefined;
let productionLimiter: RedisRateLimiter | undefined;

export function productionDependencies(): RoomApiDependencies {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required.");
  productionStore ??= RedisRoomStore.fromEnvironment();
  productionLimiter ??= RedisRateLimiter.fromUrl(url);
  return {
    store: productionStore,
    limiter: productionLimiter,
    now: () => new Date(),
    clientIdentity: (request) => request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown",
  };
}
