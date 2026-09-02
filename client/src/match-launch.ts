import type { RobotColor } from "./lobby-state.ts";

export interface MatchLaunch {
  matchId: string;
  gameplayUrl: string;
  countdownSeconds: 3;
  expiresAt: string;
  playerId: string;
  color: RobotColor;
  ticket: string;
}

const colors = new Set<RobotColor>(["blue", "orange", "green", "purple"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]00:00)$/;

export function parseMatchLaunch(value: unknown, expectedPlayerId: string): MatchLaunch {
  if (!record(value) || !ownKeys(value, [
    "matchId", "gameplayUrl", "countdownSeconds", "expiresAt", "playerId", "color", "ticket",
  ]) || typeof value.matchId !== "string" || typeof value.playerId !== "string"
    || !uuid.test(value.matchId) || !uuid.test(value.playerId) || value.playerId !== expectedPlayerId
    || typeof value.gameplayUrl !== "string" || !gameplayUrl(value.gameplayUrl)
    || value.countdownSeconds !== 3 || !futureUtcTimestamp(value.expiresAt)
    || !colors.has(value.color as RobotColor) || typeof value.ticket !== "string" || value.ticket.trim().length === 0) {
    throw new TypeError("Invalid match launch.");
  }

  return {
    matchId: value.matchId,
    gameplayUrl: value.gameplayUrl,
    countdownSeconds: value.countdownSeconds,
    expiresAt: value.expiresAt,
    playerId: value.playerId,
    color: value.color as RobotColor,
    ticket: value.ticket,
  };
}

export function countdownLabels(seconds: 3): readonly string[] {
  return ["3", "2", "1", "CLIMB!"];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function gameplayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:")
      && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function futureUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = utcTimestamp.exec(value);
  if (!match) return false;
  const expiresAt = new Date(value);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.toISOString().slice(0, 19) === match[1]
    && expiresAt.getTime() > Date.now();
}
