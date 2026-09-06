export interface ReadOnlyStorage { getItem(key: string): string | null; }

export const controlsHintVisible = (storage: ReadOnlyStorage): boolean =>
  storage.getItem("linked-up.controls-seen") !== "1";
