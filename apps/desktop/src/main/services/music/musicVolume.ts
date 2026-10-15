/**
 * Where one provider's volume slider was left, shared by both music services.
 *
 * The value is a 0–1 fraction on the slider's own percent steps. It lives in
 * the settings file while ADE runs (`musicProviderRouter` owns that write), and
 * each service keeps a session copy so the position can be applied the moment
 * its player starts.
 */

export type MusicVolumeMemory = {
  /** The stored volume, or null when the slider was never set on this computer. */
  get: () => number | null;
  /** Keeps a slider position; a write that fails is the store's business, not the caller's. */
  set: (value: number) => void;
};

/** 0–1, on the slider's percent steps, or null when it is not a number. */
export function clampVolume(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(1, value)) * 100) / 100
    : null;
}

export type VolumeMemory = {
  /** Where a player starts: the stored volume, or null when there was none. */
  saved: number | null;
  /** Remember a slider position; a value already remembered costs nothing. */
  remember: (value: number) => void;
};

/** A provider's remembered volume, with or without a settings file behind it. */
export function createVolumeMemory(memory?: MusicVolumeMemory): VolumeMemory {
  let saved = clampVolume(memory?.get());
  return {
    saved,
    remember: (value: number) => {
      const clamped = clampVolume(value);
      if (clamped == null || clamped === saved) return;
      saved = clamped;
      memory?.set(clamped);
    },
  };
}
