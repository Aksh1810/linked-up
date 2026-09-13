import assert from "node:assert/strict";
import test from "node:test";

import { parseSignalEnvelope } from "./signaling-contract.ts";

const senderId = "10000000-0000-4000-8000-000000000001";
const recipientId = "10000000-0000-4000-8000-000000000003";

test("parses exact WebRTC offer, answer, candidate, ready, and failed envelopes", () => {
  const envelopes = [
    { type: "offer", senderId, recipientId, sdp: "v=0\r\n" },
    { type: "answer", senderId: recipientId, recipientId: senderId, sdp: "v=0\r\n" },
    {
      type: "candidate", senderId, recipientId,
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null },
    },
    { type: "ready", senderId, recipientId },
    { type: "failed", senderId, recipientId, reason: "network-timeout" },
  ];
  for (const envelope of envelopes) assert.deepEqual(parseSignalEnvelope(envelope), envelope);
});

test("rejects unknown keys, invalid SDP shapes, and self-targeting", () => {
  assert.throws(() => parseSignalEnvelope({ type: "offer", senderId, recipientId, sdp: "v=0", token: "leak" }));
  assert.throws(() => parseSignalEnvelope({ type: "offer", senderId, recipientId, sdp: 123 }));
  assert.throws(() => parseSignalEnvelope({ type: "pranswer", senderId, recipientId, sdp: "v=0" }));
  assert.throws(() => parseSignalEnvelope({ type: "ready", senderId, recipientId: senderId }));
});

test("rejects envelopes over 16 KiB and ICE candidates over 4 KiB", () => {
  assert.throws(() => parseSignalEnvelope({ type: "offer", senderId, recipientId, sdp: "s".repeat(17_000) }));
  assert.throws(() => parseSignalEnvelope({
    type: "candidate", senderId, recipientId,
    candidate: { candidate: "c".repeat(4_097), sdpMid: null, sdpMLineIndex: null, usernameFragment: null },
  }));
});
