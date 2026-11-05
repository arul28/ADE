/**
 * A device pane's 3D-or-flat preference, kept per project in localStorage.
 *
 * 3D is the default (round 4's first owner decision). Keyed by project root:
 * a device in one project says nothing about how you like to see another, and
 * a preference that resets on every project switch is no preference.
 */
export type DeviceViewMode = "flat" | "3d";

export const DEVICE_DEFAULT_VIEW_MODE: DeviceViewMode = "3d";

function projectKey(projectRoot: string | null | undefined): string {
  const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
  return root.length > 0 ? root : "(no project)";
}

export function createDeviceViewModeStore(storageKey: string): {
  read: (projectRoot: string | null | undefined) => DeviceViewMode;
  write: (projectRoot: string | null | undefined, mode: DeviceViewMode) => void;
} {
  const readMap = (): Record<string, DeviceViewMode> => {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, DeviceViewMode> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === "flat" || value === "3d") out[key] = value;
      }
      return out;
    } catch {
      // Storage can be absent (tests, the browser-mock renderer) or full.
      return {};
    }
  };
  return {
    read: (projectRoot) => readMap()[projectKey(projectRoot)] ?? DEVICE_DEFAULT_VIEW_MODE,
    write: (projectRoot, mode) => {
      try {
        const map = readMap();
        map[projectKey(projectRoot)] = mode;
        globalThis.localStorage?.setItem(storageKey, JSON.stringify(map));
      } catch {
        // Best effort: a preference that cannot be stored is still honoured
        // for the life of the pane.
      }
    },
  };
}
