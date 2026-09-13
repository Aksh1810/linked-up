const restrictiveReasons = new Set([
  "negotiation-timeout", "ice-failed", "Peer connection failed: negotiation-timeout",
]);

export function peerFailureMessage(reason: unknown): string {
  if (reason === "host-lost" || reason === "The host connection was lost.") {
    return "The host left or lost connection, so this match has ended.";
  }
  if (reason === "unsupported-webrtc") {
    return "This browser cannot create a direct multiplayer connection.";
  }
  if (reason === "unsupported-wasm") {
    return "This browser cannot run the match simulation.";
  }
  if (typeof reason === "string" && restrictiveReasons.has(reason)) {
    return "Your networks could not make a direct connection. Try another network or turn off a strict VPN or firewall.";
  }
  return "The multiplayer connection stopped unexpectedly. Return to the lobby and try again.";
}
