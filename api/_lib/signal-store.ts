import type { SignalEnvelope } from "../../shared/signaling-contract.ts";

export interface StoredSignal { cursor: string; envelope: SignalEnvelope; }

export interface SignalReadResult {
  signals: StoredSignal[];
  cursor: string;
}

export interface SignalStore {
  append(code: string, recipientId: string, envelope: SignalEnvelope): Promise<string>;
  read(code: string, recipientId: string, after: string, limit: number): Promise<SignalReadResult>;
}
