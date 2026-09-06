import type { NetworkObstacleState, Vector3State } from "./gameplay-protocol.ts";

const platformKinds = new Set<NetworkObstacleState["kind"]>([
  "staticPlatform", "movingPlatform", "fallingPlatform",
]);

export function tetherPath(
  start: Vector3State,
  end: Vector3State,
  obstacles: readonly NetworkObstacleState[],
): Vector3State[] {
  for (const obstacle of obstacles) {
    if (!platformKinds.has(obstacle.kind)) continue;
    const { position, halfExtent } = obstacle;
    const top = position.y + halfExtent.y;
    const bottom = position.y - halfExtent.y;
    const startAnchored = start.y > top && end.y < bottom;
    const endAnchored = end.y > top && start.y < bottom;
    if (!startAnchored && !endAnchored) continue;
    const anchor = startAnchored ? start : end;
    const hanging = startAnchored ? end : start;
    const inside = (point: Vector3State) =>
      Math.abs(point.x - position.x) <= halfExtent.x &&
      Math.abs(point.z - position.z) <= halfExtent.z;
    if (Math.abs(anchor.y - (top + 1.1)) > 0.2 || !inside(anchor) || !inside(hanging)) continue;

    const edges = [
      position.x - halfExtent.x - 0.04,
      position.x + halfExtent.x + 0.04,
      position.z - halfExtent.z - 0.04,
      position.z + halfExtent.z + 0.04,
    ];
    const distances = [
      Math.abs(hanging.x - edges[0]), Math.abs(hanging.x - edges[1]),
      Math.abs(hanging.z - edges[2]), Math.abs(hanging.z - edges[3]),
    ];
    const side = distances.indexOf(Math.min(...distances));
    const lower = { ...hanging, y: bottom - 0.04 };
    const upper = { ...hanging, y: top + 0.04 };
    if (side < 2) lower.x = upper.x = edges[side];
    else lower.z = upper.z = edges[side];
    const route = [hanging, lower, upper, anchor];
    return startAnchored ? route.reverse() : route;
  }

  return [
    start,
    { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3,
      z: start.z + (end.z - start.z) / 3 },
    { x: start.x + (end.x - start.x) * 2 / 3, y: start.y + (end.y - start.y) * 2 / 3,
      z: start.z + (end.z - start.z) * 2 / 3 },
    end,
  ];
}
