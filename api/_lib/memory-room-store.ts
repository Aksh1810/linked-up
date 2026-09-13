import { RoomDomainError, type RoomRecord } from "./room-domain.ts";
import type { Mutation, RoomStore } from "./room-store.ts";

function clone(room: RoomRecord): RoomRecord {
  return structuredClone(room);
}

export class MemoryRoomStore implements RoomStore {
  readonly #rooms = new Map<string, RoomRecord>();

  async create(room: RoomRecord): Promise<void> {
    if (this.#rooms.has(room.code)) throw new RoomDomainError("contention", "The room code is already in use.");
    this.#rooms.set(room.code, clone(room));
  }

  async get(code: string): Promise<RoomRecord | undefined> {
    const room = this.#rooms.get(code);
    return room ? clone(room) : undefined;
  }

  async mutate<T>(code: string, apply: (room: RoomRecord) => Mutation<T>): Promise<T> {
    const current = this.#rooms.get(code);
    if (!current) throw new RoomDomainError("room_not_found", "The room does not exist.");
    const mutation = apply(clone(current));
    if (mutation.room) this.#rooms.set(code, clone(mutation.room));
    else this.#rooms.delete(code);
    return mutation.result;
  }
}
