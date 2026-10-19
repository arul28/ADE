import fs from "node:fs";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import path from "node:path";
import type {
  KeepAwakeFixResult,
  KeepAwakeLevel,
  KeepAwakePreferences,
  KeepAwakeSnapshot,
} from "../../../../desktop/src/shared/types/keepAwake";
import {
  DEFAULT_KEEP_AWAKE_PREFERENCES,
  isKeepAwakeLevel,
  normalizeKeepAwakePreferences,
} from "../../../../desktop/src/shared/types/keepAwake";
import type { ProductAnalyticsService } from "../../../../desktop/src/main/services/analytics/productAnalyticsService";
import { disableSystemSleepOnAc, execSystemText, readSystemSleepConfig } from "../../../../desktop/src/main/services/power/systemSleepConfig";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { offThreadSpawnEnabled, spawnOffThread } from "../../../../desktop/src/main/services/shared/offThreadSpawn";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";

const DEFAULT_POLL_MS = 5_000;
const KEEP_AWAKE_PREFERENCE_ANALYTICS_DEDUPE_MS = 24 * 60 * 60_000;

const KEEP_AWAKE_ANALYTICS_OUTCOME: Record<KeepAwakeLevel, string> = {
  never: "keep_awake_never",
  "while-away": "keep_awake_while_away",
  "lid-closed": "keep_awake_lid_closed",
};

type StoredKeepAwakeState = {
  version: 1;
  preferences: KeepAwakePreferences;
  legacyMigrationComplete: boolean;
};

type KeepAwakeChild = EventEmitter & {
  kill(): boolean;
  unref?(): void;
};

export type BrainKeepAwakeService = {
  start(): void;
  dispose(): void;
  getSnapshot(): Promise<KeepAwakeSnapshot>;
  setLevel(level: unknown): Promise<KeepAwakeSnapshot>;
  migrateLegacyPreference(level: unknown): Promise<{
    snapshot: KeepAwakeSnapshot;
    handled: boolean;
  }>;
  fixSystemSleep(): Promise<KeepAwakeFixResult>;
  /** Runs one activity reconciliation pass. */
  refreshBlocker(): Promise<void>;
};

export type BrainKeepAwakeServiceOptions = {
  statePath: string;
  platform?: NodeJS.Platform;
  pollMs?: number;
  /** Chat turns and tracked agent CLIs currently working on this machine. */
  readActiveAgentWork: () => Promise<boolean | number>;
  logger?: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
  };
  productAnalyticsService?: Pick<ProductAnalyticsService, "captureInternal">;
};

function defaultStoredState(): StoredKeepAwakeState {
  return {
    version: 1,
    preferences: { ...DEFAULT_KEEP_AWAKE_PREFERENCES },
    legacyMigrationComplete: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredState(filePath: string): {
  state: StoredKeepAwakeState;
  hasStoredPreference: boolean;
  migrationBlocked: boolean;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: defaultStoredState(), hasStoredPreference: false, migrationBlocked: false };
    }
    throw error;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) {
      // Do not import a desktop value over a future schema this brain does not
      // understand. Degrading to Never keeps the machine safe until it updates.
      return {
        state: { ...defaultStoredState(), legacyMigrationComplete: true },
        hasStoredPreference: true,
        migrationBlocked: true,
      };
    }
    const preferences = normalizeKeepAwakePreferences(value.preferences);
    return {
      state: {
        version: 1,
        preferences,
        legacyMigrationComplete: value.legacyMigrationComplete === true,
      },
      hasStoredPreference: isRecord(value.preferences) && isKeepAwakeLevel(value.preferences.level),
      migrationBlocked: false,
    };
  } catch {
    // A truncated file is not permission to hold a lock. Allow the one-time
    // desktop migration to recover it, but keep the default off until then.
    return { state: defaultStoredState(), hasStoredPreference: false, migrationBlocked: false };
  }
}

function parseSleepDisabled(raw: string): boolean | null {
  const match = /SleepDisabled\s+(\d)/i.exec(raw);
  return match ? match[1] === "1" : null;
}

async function readLidClosedActive(platform: NodeJS.Platform): Promise<boolean | null> {
  if (platform !== "darwin") return false;
  const result = await execSystemText("/usr/bin/pmset", ["-g"], 3_000);
  return result.ok ? parseSleepDisabled(result.stdout) : null;
}

/**
 * The Windows child owns the thread that called SetThreadExecutionState. It
 * opens a process handle (not just a PID) to this brain, keeps that thread
 * system-awake, and exits as soon as the exact brain process exits. The wait
 * uses the same thread so ES_CONTINUOUS remains effective between refreshes.
 */
function windowsExecutionStateScript(parentPid: number): string {
  return `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AdeKeepAwake { [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds); [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'; $parent = [AdeKeepAwake]::OpenProcess(0x00100000, $false, ${parentPid}); if ($parent -eq [IntPtr]::Zero) { exit 1 }; try { if ([AdeKeepAwake]::SetThreadExecutionState(0x80000001) -eq 0) { exit 2 }; while ([AdeKeepAwake]::WaitForSingleObject($parent, 30000) -eq 258) { if ([AdeKeepAwake]::SetThreadExecutionState(0x80000001) -eq 0) { exit 3 } } } finally { [void][AdeKeepAwake]::SetThreadExecutionState(0x80000000); [void][AdeKeepAwake]::CloseHandle($parent) }`;
}

export function createBrainKeepAwakeService(
  options: BrainKeepAwakeServiceOptions,
): BrainKeepAwakeService {
  const platform = options.platform ?? process.platform;
  const pollMs = Math.max(500, options.pollMs ?? DEFAULT_POLL_MS);
  let stored: ReturnType<typeof readStoredState>;
  let stateReadError: string | null = null;
  try {
    stored = readStoredState(options.statePath);
  } catch (error) {
    stored = {
      state: { ...defaultStoredState(), legacyMigrationComplete: true },
      hasStoredPreference: true,
      migrationBlocked: true,
    };
    stateReadError = "ADE can't read the saved keep-awake setting.";
    options.logger?.warn("keepAwake.state_read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let state = stored.state;
  let hasStoredPreference = stored.hasStoredPreference;
  let migrationBlocked = stored.migrationBlocked;
  let timer: ReturnType<typeof setInterval> | null = null;
  let child: KeepAwakeChild | null = null;
  let polling = false;
  let disposed = false;
  let attemptedThisActivePeriod = false;
  let blockerError: string | null = stateReadError;
  const supportsWakeLock = platform === "darwin" || platform === "win32";

  const persist = (next: StoredKeepAwakeState): void => {
    fs.mkdirSync(path.dirname(options.statePath), { recursive: true });
    writeFileAtomic(options.statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    state = next;
    hasStoredPreference = true;
    migrationBlocked = false;
  };

  const releaseBlocker = (): void => {
    attemptedThisActivePeriod = false;
    const current = child;
    child = null;
    if (!current) return;
    try {
      current.kill();
    } catch {
      // `caffeinate -w` and the Windows parent-handle waiter also release on
      // brain exit; a failed explicit stop is not grounds to keep polling.
    }
    options.logger?.info("keepAwake.lock_released");
  };

  const isNeverSelected = (): boolean => state.preferences.level === "never";

  const stopPolling = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const startPolling = (): void => {
    if (disposed || timer || state.preferences.level === "never" || !supportsWakeLock) return;
    timer = setInterval(() => void refreshBlocker(), pollMs);
    timer.unref?.();
    void refreshBlocker();
  };

  const spawnBlocker = (): void => {
    if (disposed || child || attemptedThisActivePeriod) return;
    attemptedThisActivePeriod = true;
    let spawned: KeepAwakeChild;
    try {
      if (platform === "darwin") {
        const processChild = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
        spawned = processChild;
      } else if (platform === "win32") {
        const powershell = resolveTrustedWindowsTool("powershell");
        const args = [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          windowsExecutionStateScript(process.pid),
        ];
        spawned = offThreadSpawnEnabled()
          ? spawnOffThread(powershell, args)
          : spawn(powershell, args, { stdio: "ignore", windowsHide: true });
      } else {
        attemptedThisActivePeriod = false;
        return;
      }
    } catch (error) {
      blockerError = "This machine wouldn't let ADE stay awake.";
      options.logger?.warn("keepAwake.lock_start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child = spawned;
    spawned.unref?.();
    blockerError = null;
    options.logger?.info("keepAwake.lock_started", { platform });
    spawned.once("error", (error) => {
      if (child !== spawned) return;
      child = null;
      blockerError = "This machine wouldn't let ADE stay awake.";
      options.logger?.warn("keepAwake.lock_start_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    spawned.once("exit", (code, signal) => {
      if (child !== spawned) return;
      child = null;
      if (!disposed && state.preferences.level !== "never") {
        blockerError = "This machine wouldn't let ADE stay awake.";
        options.logger?.warn("keepAwake.lock_exited_while_active", { code, signal });
      }
    });
  };

  const refreshBlocker = async (): Promise<void> => {
    if (disposed || polling) return;
    polling = true;
    try {
      if (!supportsWakeLock) {
        releaseBlocker();
        stopPolling();
        return;
      }
      if (state.preferences.level === "never") {
        releaseBlocker();
        stopPolling();
        return;
      }
      let active = false;
      try {
        const value = await options.readActiveAgentWork();
        active = typeof value === "number" ? value > 0 : value;
      } catch {
        // If activity is unreadable, release the lock; a failed read must not
        // pin the machine awake indefinitely.
      }
      if (disposed) return;
      if (isNeverSelected() || !active) releaseBlocker();
      else spawnBlocker();
    } finally {
      polling = false;
    }
  };

  const snapshot = async (): Promise<KeepAwakeSnapshot> => {
    const [lidClosedActive, systemSleep] = await Promise.all([
      readLidClosedActive(platform).catch(() => null),
      readSystemSleepConfig({ platform }).catch(() => null),
    ]);
    return {
      preferences: { ...state.preferences },
      platform: platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "other",
      lidClosedSupported: platform === "darwin",
      lidClosedActive: lidClosedActive === true,
      levelError: blockerError
        ?? (state.preferences.level === "never"
          ? null
          : state.preferences.level === "lid-closed" && platform !== "darwin"
            ? "This machine can't stay awake with the lid closed."
            : supportsWakeLock
              ? null
              : "This machine doesn't support a keep-awake lock."),
      systemSleep,
    };
  };

  const commitLevel = (level: KeepAwakeLevel, captureAnalytics: boolean): void => {
    const previous = state.preferences.level;
    persist({
      version: 1,
      preferences: { level },
      legacyMigrationComplete: true,
    });
    options.logger?.info("keepAwake.level_changed", { level });
    if (captureAnalytics && previous !== level) {
      options.productAnalyticsService?.captureInternal({
        event: "ade_feature_used",
        surface: "desktop",
        properties: {
          feature: "connections",
          action: "preferences_changed",
          outcome: KEEP_AWAKE_ANALYTICS_OUTCOME[level],
        },
        dedupeKey: `keep_awake_level:${level}`,
        minimumIntervalMs: KEEP_AWAKE_PREFERENCE_ANALYTICS_DEDUPE_MS,
      });
    }
  };

  const reconcileAfterPreferenceWrite = async (): Promise<void> => {
    if (state.preferences.level === "never") {
      releaseBlocker();
      stopPolling();
      return;
    }
    startPolling();
    await refreshBlocker();
  };

  return {
    start(): void {
      if (disposed) return;
      startPolling();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopPolling();
      releaseBlocker();
    },

    getSnapshot: snapshot,

    async setLevel(level: unknown): Promise<KeepAwakeSnapshot> {
      if (migrationBlocked) {
        blockerError = stateReadError ?? "ADE can't read the saved keep-awake setting.";
        return snapshot();
      }
      if (!isKeepAwakeLevel(level)) level = "never";
      const nextLevel = level as KeepAwakeLevel;
      const currentLevel = state.preferences.level;
      if (nextLevel !== "never" && platform !== "darwin" && platform !== "win32") {
        blockerError = "This machine doesn't support a keep-awake lock.";
        return snapshot();
      }
      if (nextLevel === "lid-closed" && platform !== "darwin") {
        blockerError = "This machine can't stay awake with the lid closed.";
        return snapshot();
      }
      if (platform === "darwin" && nextLevel !== currentLevel) {
        const lidClosedActive = await readLidClosedActive(platform);
        if (nextLevel === "lid-closed" && lidClosedActive !== true) {
          blockerError = "Open Settings on this Mac to approve lid-closed mode.";
          return snapshot();
        }
        if (currentLevel === "lid-closed" && nextLevel !== "lid-closed" && lidClosedActive === true) {
          blockerError = "Open Settings on this Mac to turn off lid-closed mode.";
          return snapshot();
        }
      }

      blockerError = null;
      commitLevel(nextLevel, true);
      await reconcileAfterPreferenceWrite();
      return snapshot();
    },

    async migrateLegacyPreference(level: unknown): Promise<{
      snapshot: KeepAwakeSnapshot;
      handled: boolean;
    }> {
      if (migrationBlocked) return { snapshot: await snapshot(), handled: false };
      if (!state.legacyMigrationComplete) {
        if (!hasStoredPreference && isKeepAwakeLevel(level)) {
          commitLevel(level, false);
          options.logger?.info("keepAwake.legacy_preference_migrated", { level });
        } else {
          persist({ ...state, legacyMigrationComplete: true });
        }
        await reconcileAfterPreferenceWrite();
      }
      return { snapshot: await snapshot(), handled: true };
    },

    async fixSystemSleep(): Promise<KeepAwakeFixResult> {
      const result = platform === "darwin"
        ? { ok: false, error: "Open Settings on this Mac to change its sleep timer." }
        : await disableSystemSleepOnAc({ platform });
      if (!result.ok) options.logger?.warn("keepAwake.system_sleep_fix_failed", result);
      return { ...result, snapshot: await snapshot() };
    },

    refreshBlocker,
  };
}
