export interface OfferSignal {
  type: "offer";
  senderId: string;
  recipientId: string;
  sdp: string;
}

export interface AnswerSignal {
  type: "answer";
  senderId: string;
  recipientId: string;
  sdp: string;
}

export interface CandidateSignal {
  type: "candidate";
  senderId: string;
  recipientId: string;
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
  };
}

export interface ReadySignal {
  type: "ready";
  senderId: string;
  recipientId: string;
}

export interface FailedSignal {
  type: "failed";
  senderId: string;
  recipientId: string;
  reason: string;
}

export type SignalEnvelope = OfferSignal | AnswerSignal | CandidateSignal | ReadySignal | FailedSignal;

const MAX_ENVELOPE_BYTES = 16 * 1_024;
const MAX_CANDIDATE_BYTES = 4 * 1_024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function common(value: Record<string, unknown>): boolean {
  return typeof value.senderId === "string" && uuid.test(value.senderId)
    && typeof value.recipientId === "string" && uuid.test(value.recipientId)
    && value.senderId !== value.recipientId;
}

export function parseSignalEnvelope(value: unknown): SignalEnvelope {
  if (!record(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ENVELOPE_BYTES
    || !common(value)) {
    throw new TypeError("Invalid signaling envelope.");
  }
  if (value.type === "offer" || value.type === "answer") {
    if (!exact(value, ["type", "senderId", "recipientId", "sdp"])
      || typeof value.sdp !== "string" || value.sdp.length === 0) {
      throw new TypeError("Invalid signaling envelope.");
    }
    return { type: value.type, senderId: value.senderId as string, recipientId: value.recipientId as string, sdp: value.sdp };
  }
  if (value.type === "candidate") {
    if (!exact(value, ["type", "senderId", "recipientId", "candidate"]) || !record(value.candidate)
      || !exact(value.candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
      || typeof value.candidate.candidate !== "string"
      || new TextEncoder().encode(value.candidate.candidate).byteLength > MAX_CANDIDATE_BYTES
      || !(value.candidate.sdpMid === null || typeof value.candidate.sdpMid === "string")
      || !(value.candidate.sdpMLineIndex === null || Number.isSafeInteger(value.candidate.sdpMLineIndex))
      || !(value.candidate.usernameFragment === null || typeof value.candidate.usernameFragment === "string")) {
      throw new TypeError("Invalid signaling envelope.");
    }
    return structuredClone(value) as unknown as CandidateSignal;
  }
  if (value.type === "ready" && exact(value, ["type", "senderId", "recipientId"])) {
    return { type: "ready", senderId: value.senderId as string, recipientId: value.recipientId as string };
  }
  if (value.type === "failed" && exact(value, ["type", "senderId", "recipientId", "reason"])
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 256) {
    return { type: "failed", senderId: value.senderId as string, recipientId: value.recipientId as string, reason: value.reason };
  }
  throw new TypeError("Invalid signaling envelope.");
}
