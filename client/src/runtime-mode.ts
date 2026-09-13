import type { PlayerId } from "./gameplay-protocol.ts";

export function isNativeDevelopmentMode(environment: Record<string, unknown>): boolean {
  return environment.DEV === true;
}

export function nativeDevelopmentPlayer(
  search: string,
  environment: Record<string, unknown>,
): Extract<PlayerId, "blue" | "orange"> | undefined {
  if (!isNativeDevelopmentMode(environment)) return undefined;
  const player = new URLSearchParams(search).get("player");
  return player === "blue" || player === "orange" ? player : undefined;
}

export function peerRuntimeSupport(runtime: Record<string, unknown>): string | undefined {
  if (!("WebAssembly" in runtime) || !("Worker" in runtime)) {
    return "This browser cannot run the match simulation.";
  }
  if (!("RTCPeerConnection" in runtime)) {
    return "This browser cannot create a direct multiplayer connection.";
  }
  return undefined;
}
