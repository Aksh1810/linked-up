import type { PlayerId, ServerSnapshot } from "./gameplay-protocol.ts";

const displayName = (id: PlayerId): string => id[0].toUpperCase() + id.slice(1);

export function tetherLabel(tension: number): "Linked" | "Stretched" | "Taut" {
  if (tension >= 0.85) return "Taut";
  if (tension >= 0.5) return "Stretched";
  return "Linked";
}

export function describeGameplayStatus(
  snapshot: ServerSnapshot,
  localId: PlayerId,
  previousResetCount = snapshot.resetCount,
): string {
  if (snapshot.matchState === "finished") return "Summit reached";
  const hanging = snapshot.players.find((player) => player.id !== localId && !player.grounded);
  if (hanging) return `${displayName(hanging.id)} is hanging — hold Space to climb`;
  if (snapshot.resetCount > previousResetCount) return `Checkpoint ${snapshot.checkpoint} restored`;
  return "Climb together";
}
