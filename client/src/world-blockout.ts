import type { NetworkObstacleState, Vector3State } from "./gameplay-protocol.ts";

export function obstacleDimensions(halfExtent: Vector3State): { width: number; height: number; depth: number } {
  return { width: halfExtent.x * 2, height: halfExtent.y * 2, depth: halfExtent.z * 2 };
}

export function obstacleAppearance(
  zone: NetworkObstacleState["zone"],
  kind: NetworkObstacleState["kind"],
): { base: string; top: string } {
  const zones: Record<NetworkObstacleState["zone"], { base: string; top: string }> = {
    grass: { base: "#456852", top: "#527f5a" },
    construction: { base: "#7b5835", top: "#e7b85f" },
    industrial: { base: "#39495b", top: "#75889a" },
    sky: { base: "#647d8e", top: "#c3dce3" },
    summit: { base: "#846b3b", top: "#e6c45f" },
  };
  const hazards: Partial<Record<NetworkObstacleState["kind"], string>> = {
    rotatingBeam: "#ef7d57",
    swingingBeam: "#d97896",
    fan: "#63cbd0",
    conveyor: "#667080",
    fallingPlatform: "#a57c52",
  };
  return { base: zones[zone].base, top: hazards[kind] ?? zones[zone].top };
}

export interface ObstaclePresentation {
  opacity: number;
  wireframe: boolean;
  directional: boolean;
  hub: boolean;
  warning: boolean;
  shake: boolean;
}

export function obstaclePresentation(
  kind: NetworkObstacleState["kind"],
  phase: NetworkObstacleState["phase"],
  reducedMotion: boolean,
): ObstaclePresentation {
  const warning = kind === "fallingPlatform" && phase === "warning";
  return {
    opacity: kind === "fan" ? 0.2 : kind === "conveyor" ? 0.32 : 1,
    wireframe: kind === "fan",
    directional: kind === "fan" || kind === "conveyor" || kind === "movingPlatform",
    hub: kind === "rotatingBeam",
    warning,
    shake: warning && !reducedMotion,
  };
}
