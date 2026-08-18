/**
 * Holds this machine awake while an agent turn is running — and only then, and
 * only when the user has asked for it.
 *
 * The default is `never`. A wake lock drains a battery, so ADE takes one only
 * on an explicit choice, and drops it the moment the machine goes idle again.
 *
 * Two mechanisms, and they are not interchangeable:
 *
 * - `prevent-app-suspension` (Electron, macOS + Windows) stops IDLE sleep. It
 *   does NOT survive a closed lid. This was checked, not assumed: an assertion
 *   held continuously for 35 days sat through two clamshell sleeps. Nothing in
 *   this file or its copy may imply otherwise.
 * - `pmset -a disablesleep` (macOS only) is the one that survives the lid, and
 *   it is root-only, so it goes through the system authorization dialog. It is
 *   a machine-wide switch that OUTLIVES this process: engaged when the level is
 *   selected, released when it is deselected, and deliberately left alone at
 *   quit — flipping it back on quit would either prompt for a password on the
 *   way out or, worse, re-prompt on every launch to put it back.
 *
 * Windows has no `disablesleep` equivalent, so `lid-closed` is unsupported
 * there and the settings section omits the level entirely.
 */

import type {
  KeepAwakeLevel,
  KeepAwakePreferences,
  KeepAwakeSnapshot,
  SystemSleepConfig,
} from "../../../shared/types/keepAwake";
import { normalizeKeepAwakePreferences } from "../../../shared/types/keepAwake";
import { readGlobalState, writeGlobalState } from "../state/globalState";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";
import {
  disableSystemSleepOnAc,
  execSystemText,
  readSystemSleepConfig,
  type SystemSleepDeps,
} from "./systemSleepConfig";

/**
 * How often the turn poll runs.
 *
 * Agent turns live in the brain, not in this process, so the desktop learns
 * about them by asking. Five seconds is short enough that a machine cannot idle
 * out in the gap (the shortest system sleep timer any platform offers is a
 * minute) and long enough to cost nothing.
 */
const DEFAULT_POLL_MS = 5_000;

/** Electron's `powerSaveBlocker`, narrowed to what this service uses. */
export type PowerSaveBlockerApi = {
  start(type: "prevent-app-suspension" | "prevent-display-sleep"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
};

/**
 * One accepted event per level per day. Three levels means a worst case of
 * three events per installation per day even if someone sits there toggling —
 * the dedupe key carries the level so a flip-flop cannot mint a new one.
 */
const KEEP_AWAKE_PREFERENCE_ANALYTICS_DEDUPE_MS = 24 * 60 * 60_000;

/** Closed mapping to the allowlisted `outcome` values. */
const KEEP_AWAKE_ANALYTICS_OUTCOME: Record<KeepAwakeLevel, string> = {
  never: "keep_awake_never",
  "while-away": "keep_awake_while_away",
  "lid-closed": "keep_awake_lid_closed",
};

export type KeepAwakeServiceOptions = {
  globalStatePath: string;
  platform?: NodeJS.Platform;
  powerSaveBlocker?: PowerSaveBlockerApi | null;
  /** Live count of running agent turns, asked of the brain. */
  readActiveTurns?: () => Promise<number>;
  pollMs?: number;
  systemSleepDeps?: SystemSleepDeps;
  /**
   * Runs `pmset -a disablesleep <0|1>` with administrator privileges, and reads
   * back whether sleep is currently disabled. Injectable so the state machine
   * is testable without a password dialog.
   */
  lidSleep?: LidSleepController;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  productAnalyticsService?: Pick<ProductAnalyticsService, "captureInternal">;
};

export type LidSleepController = {
  /** Whether the machine currently has sleep disabled. Null when unreadable. */
  read(): Promise<boolean | null>;
  /** Ask the OS to change it; prompts for an administrator password. */
  set(disabled: boolean): Promise<{ ok: boolean; error: string | null }>;
};

export type KeepAwakeService = {
  start(): void;
  dispose(): void;
  getSnapshot(): Promise<KeepAwakeSnapshot>;
  setLevel(level: unknown): Promise<KeepAwakeSnapshot>;
  fixSystemSleep(): Promise<{ ok: boolean; error: string | null; snapshot: KeepAwakeSnapshot }>;
  /** Test seam: run one poll cycle synchronously. */
  refreshBlocker(): Promise<void>;
};

// ---------------------------------------------------------------------------
// macOS lid controller
// ---------------------------------------------------------------------------

/**
 * `pmset -g` prints `SleepDisabled 1` when the switch is on. Reading it needs
 * no privileges; only writing does.
 */
export function parseSleepDisabled(raw: string | null | undefined): boolean | null {
  const text = typeof raw === "string" ? raw : "";
  const match = /SleepDisabled\s+(\d)/i.exec(text);
  if (!match) return null;
  return match[1] === "1";
}

export function createDarwinLidSleepController(
  deps: SystemSleepDeps = {},
): LidSleepController {
  const exec = deps.execFileText ?? execSystemText;
  return {
    async read(): Promise<boolean | null> {
      const result = await exec("/usr/bin/pmset", ["-g"], 3_000);
      return result.ok ? parseSleepDisabled(result.stdout) : null;
    },
    async set(disabled: boolean): Promise<{ ok: boolean; error: string | null }> {
      const result = await exec(
        "/usr/bin/osascript",
        [
          "-e",
          `do shell script "/usr/bin/pmset -a disablesleep ${disabled ? 1 : 0}" with administrator privileges`,
        ],
        // The dialog waits on a human.
        120_000,
      );
      if (result.ok) return { ok: true, error: null };
      return {
        ok: false,
        error: /User canceled|-128/i.test(result.stderr)
          ? "You cancelled the password prompt."
          : disabled
            ? "macOS wouldn't turn this on."
            : "macOS wouldn't turn this off.",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createKeepAwakeService(
  options: KeepAwakeServiceOptions,
): KeepAwakeService {
  const platform = options.platform ?? process.platform;
  const blockerApi = options.powerSaveBlocker ?? null;
  const pollMs = Math.max(500, options.pollMs ?? DEFAULT_POLL_MS);
  const readActiveTurns = options.readActiveTurns ?? (async () => 0);
  const systemSleepDeps: SystemSleepDeps = {
    platform,
    ...(options.systemSleepDeps ?? {}),
  };
  const lidSleep = options.lidSleep
    ?? (platform === "darwin" ? createDarwinLidSleepController(systemSleepDeps) : null);
  const lidClosedSupported = platform === "darwin" && lidSleep != null;

  let preferences: KeepAwakePreferences = normalizeKeepAwakePreferences(
    readGlobalState(options.globalStatePath).keepAwakePreferences,
  );
  let blockerId: number | null = null;
  let lidClosedActive = false;
  let levelError: string | null = null;
  /**
   * Kept apart from `levelError` on purpose.
   *
   * They have different lifetimes: a lid-level error is about a choice the user
   * just made and stands until they make another, while this one is about a
   * single `powerSaveBlocker.start()` that threw and stops being true the
   * moment a later acquire succeeds. Folded into one field, one transient throw
   * left the settings pane claiming the level was inert for the rest of the
   * session.
   */
  let blockerError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let polling = false;

  const releaseBlocker = (): void => {
    if (blockerId == null || !blockerApi) {
      blockerId = null;
      return;
    }
    try {
      if (blockerApi.isStarted(blockerId)) blockerApi.stop(blockerId);
    } catch {
      // A blocker Electron has already torn down is not a failure worth
      // surfacing — the lock is gone either way.
    }
    blockerId = null;
  };

  const acquireBlocker = (): void => {
    if (blockerId != null || !blockerApi) return;
    try {
      blockerId = blockerApi.start("prevent-app-suspension");
      // The lock is held, so whatever a previous attempt failed at is no longer
      // true of this machine. Leaving it set would keep telling the user their
      // level does nothing while it is demonstrably working.
      blockerError = null;
    } catch {
      blockerId = null;
      blockerError = "This machine wouldn't let ADE stay awake.";
    }
  };

  /**
   * One pass of "should the lock be held right now".
   *
   * The lock follows the TURN, not the setting: picking a level arms ADE, it
   * does not pin the machine awake while nothing is running.
   */
  /** Read through a call, so the level after an `await` is never a stale narrowing. */
  const currentLevel = (): KeepAwakePreferences["level"] => preferences.level;

  const refreshBlocker = async (): Promise<void> => {
    if (disposed || polling) return;
    polling = true;
    try {
      if (currentLevel() === "never") {
        releaseBlocker();
        return;
      }
      let activeTurns = 0;
      try {
        activeTurns = await readActiveTurns();
      } catch {
        // A brain that cannot be asked is not a reason to pin the machine
        // awake. Fail toward releasing the lock.
        activeTurns = 0;
      }
      if (disposed) return;
      // Re-read the level, not just `disposed`: the poll above is an RPC to the
      // brain, and a user who switched to "Never" while it was in flight must
      // not have the lock taken back out from under them for another interval.
      if (currentLevel() === "never" || activeTurns <= 0) releaseBlocker();
      else acquireBlocker();
    } finally {
      polling = false;
    }
  };

  const persist = (next: KeepAwakePreferences): void => {
    preferences = next;
    const current = readGlobalState(options.globalStatePath);
    writeGlobalState(options.globalStatePath, {
      ...current,
      keepAwakePreferences: next,
    });
    options.logger?.info("keepAwake.level_changed", { level: next.level });
    // Emitted here rather than at the radio button: this is the durable owner
    // boundary, so the fact is recorded once, after the choice actually stuck,
    // no matter which surface asked for it. The level is the whole payload —
    // never the machine, its battery, or what it was running.
    options.productAnalyticsService?.captureInternal({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "connections",
        action: "preferences_changed",
        outcome: KEEP_AWAKE_ANALYTICS_OUTCOME[next.level],
      },
      dedupeKey: `keep_awake_level:${next.level}`,
      minimumIntervalMs: KEEP_AWAKE_PREFERENCE_ANALYTICS_DEDUPE_MS,
    });
  };

  const readSystemSleep = async (): Promise<SystemSleepConfig | null> => {
    try {
      return await readSystemSleepConfig(systemSleepDeps);
    } catch {
      return null;
    }
  };

  /**
   * Reports what the MACHINE says, not what the setting says.
   *
   * These can disagree in exactly one direction that matters: a release that
   * failed leaves the machine pinned awake under a quieter-looking level. That
   * is the state a user most needs told, so it must not be masked by checking
   * the stored level here.
   */
  const syncLidClosed = async (): Promise<void> => {
    if (!lidClosedSupported || !lidSleep) {
      lidClosedActive = false;
      return;
    }
    lidClosedActive = (await lidSleep.read().catch(() => null)) === true;
  };

  const snapshot = async (): Promise<KeepAwakeSnapshot> => {
    await syncLidClosed();
    return {
      preferences: { ...preferences },
      lidClosedSupported,
      lidClosedActive,
      // The chosen level's own failure is the more specific of the two, so it
      // wins when both are set.
      levelError: levelError ?? blockerError,
      systemSleep: await readSystemSleep(),
    };
  };

  return {
    start(): void {
      if (timer || disposed) return;
      timer = setInterval(() => void refreshBlocker(), pollMs);
      timer.unref?.();
      void refreshBlocker();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      releaseBlocker();
      // `disablesleep` is deliberately NOT reverted here. See the file header:
      // reverting at quit means prompting for a password on the way out, and
      // re-prompting on every launch to put it back.
    },

    getSnapshot: snapshot,

    async setLevel(level: unknown): Promise<KeepAwakeSnapshot> {
      const next = normalizeKeepAwakePreferences({ level });
      const wantsLid = next.level === "lid-closed";
      if (wantsLid && !lidClosedSupported) {
        // Windows has no equivalent. Refuse rather than storing a level that
        // would silently do nothing.
        levelError = "This machine can't stay awake with the lid closed.";
        return snapshot();
      }

      levelError = null;
      const hadLid = preferences.level === "lid-closed";

      if (lidSleep && (wantsLid || hadLid) && wantsLid !== hadLid) {
        const result = await lidSleep.set(wantsLid);
        if (!result.ok) {
          if (wantsLid) {
            // The privileged step is the whole level. Do not store a choice
            // that is not in force.
            levelError = result.error;
            return snapshot();
          }
          // Turning it OFF failed: the machine is still pinned awake, so say
          // so rather than reporting a clean switch to a quieter level.
          levelError = "This Mac is still set to stay awake. Try again.";
        }
      }

      persist(next);
      // "Never" releases HERE, not through the poll. `refreshBlocker` no-ops
      // while a pass is already in flight, and that pass is an RPC to the
      // brain — so a user who picks Never while one is outstanding would keep
      // the machine pinned awake until it returned. The lock must drop the
      // moment the choice is made, not when the network agrees.
      if (next.level === "never") releaseBlocker();
      await refreshBlocker();
      return snapshot();
    },

    async fixSystemSleep(): Promise<{
      ok: boolean;
      error: string | null;
      snapshot: KeepAwakeSnapshot;
    }> {
      const result = await disableSystemSleepOnAc(systemSleepDeps);
      if (!result.ok) options.logger?.warn("keepAwake.system_sleep_fix_failed", result);
      return { ...result, snapshot: await snapshot() };
    },

    refreshBlocker,
  };
}
