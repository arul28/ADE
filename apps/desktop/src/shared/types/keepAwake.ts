// ---------------------------------------------------------------------------
// Keeping this machine awake while agents work.
//
// ADE held no power assertions at all before this: an agent turn and a
// screensaver looked identical to the OS, so a machine that idled out took the
// turn down with it. The fix is explicitly opt-in — a wake lock drains a
// battery, and ADE must never do that without being asked.
//
// Three levels, and each one states its own limit, because the limits are the
// part users get wrong:
//
//   never       — ADE touches nothing. Turns pause when the machine sleeps.
//   while-away  — an app-suspension blocker held ONLY while a turn is running.
//                 It stops IDLE sleep. It does NOT survive a closed lid: a
//                 wake assertion held for 35 days did not prevent two clamshell
//                 sleeps. Copy anywhere near this level must not imply it does.
//   lid-closed  — macOS only, `pmset disablesleep`, which needs one admin
//                 authorization. Windows has no equivalent, so the level is
//                 absent there rather than shown disabled.
//
// Kept dependency-free so main, preload, and the renderer all read one shape.
// ---------------------------------------------------------------------------

export type KeepAwakeLevel = "never" | "while-away" | "lid-closed";

export const KEEP_AWAKE_LEVELS: readonly KeepAwakeLevel[] = [
  "never",
  "while-away",
  "lid-closed",
] as const;

export type KeepAwakePreferences = {
  level: KeepAwakeLevel;
};

/** Off. ADE never holds power awake until the user asks it to. */
export const DEFAULT_KEEP_AWAKE_PREFERENCES: KeepAwakePreferences = {
  level: "never",
};

export function isKeepAwakeLevel(value: unknown): value is KeepAwakeLevel {
  return typeof value === "string"
    && (KEEP_AWAKE_LEVELS as readonly string[]).includes(value);
}

/**
 * Read a stored or IPC-supplied preference, degrading anything unrecognized to
 * the default. An unreadable preference must never be read as "hold the lock".
 */
export function normalizeKeepAwakePreferences(value: unknown): KeepAwakePreferences {
  const candidate = value as Partial<KeepAwakePreferences> | null | undefined;
  return {
    level: isKeepAwakeLevel(candidate?.level)
      ? candidate.level
      : DEFAULT_KEEP_AWAKE_PREFERENCES.level,
  };
}

/**
 * What the OS's OWN power configuration will do to a running agent, read from
 * `pmset -g custom` on macOS and `powercfg /query` on Windows.
 *
 * This is the setting ADE cannot override from inside the app: a system sleep
 * timer on wall power puts the machine down whatever level the user picked, so
 * the honest thing is to say so and offer to change it.
 */
export type SystemSleepConfig = {
  /** Idle sleep timer on wall power, in minutes. `0` means never. */
  sleepMinutesOnAc: number;
  /** ADE knows a command that changes it on this platform. */
  fixable: boolean;
  /** That command will ask for an administrator password. */
  fixNeedsPassword: boolean;
};

/** Everything the settings section needs, in one read. */
export type KeepAwakeSnapshot = {
  preferences: KeepAwakePreferences;
  /**
   * `false` on Windows, where `pmset disablesleep` has no equivalent. The
   * level is hidden entirely rather than shown disabled.
   */
  lidClosedSupported: boolean;
  /** The lid-closed level is stored AND in force right now. */
  lidClosedActive: boolean;
  /**
   * Why the stored level is not in force, in plain language. Non-null means
   * the level is inert — never let the UI imply otherwise.
   */
  levelError: string | null;
  /** Null when the platform's power configuration could not be read. */
  systemSleep: SystemSleepConfig | null;
};

/**
 * What a surface that holds no lock reports: the main process without the
 * service, a browser tab, the browser preview.
 *
 * One literal, because four places used to hand-write it and a field added to
 * `KeepAwakeSnapshot` would have had to be remembered in all four. Every field
 * says "off" — a missing service holds nothing, and must never look like it
 * does. Spread it where the caller mutates.
 *
 * Frozen through the nested object, not merely documented as shared. The main
 * process structured-clones its copy across IPC, but the web and browser-mock
 * paths hand this exact object identity straight into React state, so a caller
 * that mutated `snapshot.preferences.level` in place would silently rewrite
 * what every other surface reads as "off". A freeze turns that into a throw in
 * strict mode instead of a ghost.
 */
export const INERT_KEEP_AWAKE_SNAPSHOT: KeepAwakeSnapshot = Object.freeze({
  preferences: Object.freeze({ ...DEFAULT_KEEP_AWAKE_PREFERENCES }),
  lidClosedSupported: false,
  lidClosedActive: false,
  levelError: null,
  systemSleep: null,
}) as KeepAwakeSnapshot;

export type KeepAwakeFixResult = {
  ok: boolean;
  /** Plain-language failure, or null on success. */
  error: string | null;
  snapshot: KeepAwakeSnapshot;
};

/** True when the OS will sleep this machine out from under a running turn. */
export function systemSleepStopsAgents(config: SystemSleepConfig | null): boolean {
  return config != null && config.sleepMinutesOnAc > 0;
}
