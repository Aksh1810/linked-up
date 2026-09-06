export type CameraSensitivity = "low" | "medium" | "high";

export interface UiPreferences {
  cameraSensitivity: CameraSensitivity;
  invertY: boolean;
}

interface StorageReader { getItem(key: string): string | null; }

export const defaultUiPreferences: UiPreferences = {
  cameraSensitivity: "medium",
  invertY: false,
};

export function readUiPreferences(storage: StorageReader): UiPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem("linked-up.ui-preferences") ?? "null");
    if (!parsed || typeof parsed !== "object") return defaultUiPreferences;
    const value = parsed as Record<string, unknown>;
    if (!["low", "medium", "high"].includes(String(value.cameraSensitivity)) ||
        typeof value.invertY !== "boolean") return defaultUiPreferences;
    return value as unknown as UiPreferences;
  } catch {
    return defaultUiPreferences;
  }
}

export function cameraSettings(preferences: UiPreferences, reducedMotion: boolean, delta: number) {
  const angularSensibility = { low: 1600, medium: 1000, high: 650 }[preferences.cameraSensitivity];
  return {
    angularSensibilityX: angularSensibility,
    angularSensibilityY: preferences.invertY ? -angularSensibility : angularSensibility,
    inertia: reducedMotion ? 0 : 0.82,
    targetBlend: reducedMotion ? 1 : 1 - Math.exp(-8 * delta),
  };
}
