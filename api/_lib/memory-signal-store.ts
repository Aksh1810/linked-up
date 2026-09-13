import type { SignalEnvelope } from "../../shared/signaling-contract.ts";
import type { SignalReadResult, SignalStore, StoredSignal } from "./signal-store.ts";

export class MemorySignalStore implements SignalStore {
  readonly #mailboxes = new Map<string, StoredSignal[]>();

  async append(code: string, recipientId: string, envelope: SignalEnvelope): Promise<string> {
    const key = `${code}:${recipientId}`;
    const mailbox = this.#mailboxes.get(key) ?? [];
    const cursor = String(mailbox.length + 1);
    mailbox.push({ cursor, envelope: structuredClone(envelope) });
    this.#mailboxes.set(key, mailbox);
    return cursor;
  }

  async read(code: string, recipientId: string, after: string, limit: number): Promise<SignalReadResult> {
    const mailbox = this.#mailboxes.get(`${code}:${recipientId}`) ?? [];
    const signals = mailbox.filter((signal) => Number(signal.cursor) > Number(after)).slice(0, limit)
      .map((signal) => structuredClone(signal));
    return { signals, cursor: signals.at(-1)?.cursor ?? after };
  }
}
