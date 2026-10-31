/**
 * One machine's load and capabilities, as its own brain reads them
 * (`machine_stats.get`, `main/services/machineStats/machineStatsService.ts`).
 * Settings › Machines draws them, and the machine pickers' "Least loaded"
 * choice weighs them with the machine's placement preference.
 *
 * Fields a machine has not read yet are null, never zero: a missing reading is
 * not proof a machine is idle.
 */
export type MachineStats = {
  /** When the fast readings (CPU, memory, disk) were taken, epoch ms. */
  at: number;
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  /** "macOS 26.1", "Windows 11", "Ubuntu 24.04.1 LTS"; null until read. */
  osName: string | null;
  cpu: {
    /** Whole host, 0–100, over the last sample (200 ms, or since the previous read). */
    busyPercent: number | null;
    cores: number;
    model: string | null;
  };
  memory: { totalBytes: number; availableBytes: number };
  /** The volume that holds the user's home (and ADE's work copies). */
  disk: { freeBytes: number; totalBytes: number } | null;
  /** Null when the machine could not be asked; `hasBattery: false` on a desktop. */
  power: { hasBattery: boolean; onBattery: boolean; batteryPercent: number | null } | null;
  /** Whether ADE holds the machine awake, from its keep-awake setting; null when unknown. */
  sleep: { keptAwake: boolean; lidClosedAwake: boolean } | null;
  /** Build tools running now (xcodebuild, cargo, msbuild…), by tool; null until read. */
  builds: Array<{ tool: string; count: number }> | null;
  /** Developer CLIs and whether each is signed in here. Never a token. Null until read. */
  clis: Array<{ id: string; label: string; signedIn: boolean }> | null;
  /** Xcode on a Mac. Null off macOS, without Xcode, or until read (see `slowAt`). */
  xcode: { version: string; simulators: number; bootedSimulators: number } | null;
  /** Copies of other machines' work kept here (`remote_work.list`). Null until read. */
  workCopies: { count: number; sizeBytes: number | null } | null;
  /** When the slow readings (CLIs, Xcode, OS name, work copies) were taken; null while the first is running. */
  slowAt: number | null;
};

/** How often other machines should send new work here. A missing setting is "normal". */
export type MachinePlacementPreference = "prefer" | "normal" | "less-often" | "manual";

export const MACHINE_PLACEMENT_PREFERENCES: readonly MachinePlacementPreference[] = ["prefer", "normal", "less-often", "manual"];

export function isMachinePlacementPreference(value: unknown): value is MachinePlacementPreference {
  return typeof value === "string" && (MACHINE_PLACEMENT_PREFERENCES as readonly string[]).includes(value);
}

/** Account settings key (scope `all`) for one machine's preference, by account machine key. */
export const MACHINE_PLACEMENT_SETTING_PREFIX = "machine.placement.";

/**
 * Null when the key cannot be an account key (the relay takes `[A-Za-z0-9._-]`):
 * such a machine (an SSH target keyed by its local target id) keeps its
 * preference on this computer only.
 */
export function machinePlacementSettingKey(machineKey: string | null | undefined): string | null {
  const key = machineKey?.trim();
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) return null;
  return `${MACHINE_PLACEMENT_SETTING_PREFIX}${key}`;
}

export type MachinePlacementRecord = { preference: MachinePlacementPreference; updatedAt: string };

export function isMachinePlacementRecord(value: unknown): value is MachinePlacementRecord {
  return Boolean(value)
    && typeof value === "object"
    && isMachinePlacementPreference((value as { preference?: unknown }).preference)
    && typeof (value as { updatedAt?: unknown }).updatedAt === "string";
}
