import assert from "node:assert/strict";
import test from "node:test";

import { peerFailureMessage } from "./peer-status.ts";

test("restrictive networks and a lost host have distinct guidance", () => {
  assert.equal(peerFailureMessage("negotiation-timeout"),
    "Your networks could not make a direct connection. Try another network or turn off a strict VPN or firewall.");
  assert.equal(peerFailureMessage("host-lost"),
    "The host left or lost connection, so this match has ended.");
  assert.equal(peerFailureMessage("unsupported-webrtc"),
    "This browser cannot create a direct multiplayer connection.");
});

test("peer failure copy never reflects credentials or connection payloads", () => {
  for (const secret of [
    "token=private-room-token", "v=0\\r\\na=candidate:1 1 UDP 1 192.0.2.1 5555 typ host", "ICE candidate private",
  ]) {
    const message = peerFailureMessage(secret);
    assert.equal(message, "The multiplayer connection stopped unexpectedly. Return to the lobby and try again.");
    assert.equal(message.includes(secret), false);
  }
});
