import type { RoomRecord } from "./room-domain.ts";

export interface Mutation<T> {
  room: RoomRecord | undefined;
  result: T;
}

export interface RoomStore {
  create(room: RoomRecord): Promise<void>;
  get(code: string): Promise<RoomRecord | undefined>;
  mutate<T>(code: string, apply: (room: RoomRecord) => Mutation<T>): Promise<T>;
}
