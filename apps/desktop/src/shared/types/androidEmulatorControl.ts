/**
 * The Android emulator contract at `ade apple`'s level for the agent verbs
 * the parity audit found missing: named keys with modifiers, launch extras,
 * relaunch, app state, the app in front, one frame, Inspect at a point, and
 * the lane-device lifecycle (idle power-off, the cleanup pass).
 * Re-exported from `androidEmulator.ts`; import from there.
 */

import type { AndroidLaneArgs, AndroidPackageArgs, AndroidUiBounds, AndroidUiElement, AndroidUiTreeSource } from "./androidEmulator";
import type { AndroidLaunchResult } from "./androidEmulatorAgent";
import type { AndroidInputRecordArgs } from "./androidEmulatorRecording";

/* ---------- keys ---------- */

/**
 * `ade android key`: named keys as Android key codes (`KeyEvent.KEYCODE_*`),
 * the same names as `ade apple key`. `home` and `end` move the cursor to the
 * line's start and end (`MOVE_HOME`, `MOVE_END`), as the HID keys do on
 * Apple; the Home button is `ade android button home`. Single letters and
 * digits are added by `androidKeyCode`.
 */
export const ANDROID_NAMED_KEYCODES: Readonly<Record<string, number>> = {
  return: 66,
  enter: 66,
  escape: 111,
  esc: 111,
  delete: 67,
  backspace: 67,
  tab: 61,
  space: 62,
  "forward-delete": 112,
  home: 122,
  end: 123,
  "page-up": 92,
  "page-down": 93,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  f1: 131,
  f2: 132,
  f3: 133,
  f4: 134,
  f5: 135,
  f6: 136,
  f7: 137,
  f8: 138,
  f9: 139,
  f10: 140,
  f11: 141,
  f12: 142,
};

/**
 * Modifier keys held around an `android key` press: the left-hand key's code
 * and the `KeyEvent.META_*` bits a key event carries while it is held.
 * `cmd` is Apple's name for the same key Android calls meta.
 */
export const ANDROID_KEY_MODIFIERS: Readonly<Record<string, { keycode: number; meta: number }>> = {
  shift: { keycode: 59, meta: 0x01 | 0x40 },
  ctrl: { keycode: 113, meta: 0x1000 | 0x2000 },
  alt: { keycode: 57, meta: 0x02 | 0x10 },
  meta: { keycode: 117, meta: 0x10000 | 0x20000 },
  cmd: { keycode: 117, meta: 0x10000 | 0x20000 },
};

/** The key code for a key name, or one letter or digit; null for anything else. */
export function androidKeyCode(name: string): number | null {
  const key = name.trim().toLowerCase();
  const named = ANDROID_NAMED_KEYCODES[key];
  if (named !== undefined) return named;
  if (/^[a-z]$/u.test(key)) return 29 + key.charCodeAt(0) - "a".charCodeAt(0);
  if (/^[0-9]$/u.test(key)) return 7 + Number(key);
  return null;
}

/**
 * Splits `ctrl+shift+a` into its modifiers and its key. A lone `+` key is not
 * supported (Android has no key code for it on its own).
 */
export function splitAndroidKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parts = combo.trim().toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  return { key, modifiers: parts };
}

export type AndroidPressKeyArgs = AndroidLaneArgs & AndroidInputRecordArgs & {
  /** A name from `ANDROID_NAMED_KEYCODES`, one letter or digit, or a combo (`ctrl+a`). */
  key: string;
  /** Held while the key is pressed: shift, ctrl, alt, meta (or cmd). */
  modifiers?: string[] | null;
};

export type AndroidPressKeyResult = {
  ok: true;
  /** What was pressed, modifiers first (`ctrl+a`). */
  key: string;
  /** `scrcpy` while a stream runs, else `adb`. */
  via: "scrcpy" | "adb";
};

/* ---------- apps ---------- */

export const ANDROID_INTENT_EXTRA_TYPES = ["string", "int", "long", "float", "bool"] as const;
export type AndroidIntentExtraType = (typeof ANDROID_INTENT_EXTRA_TYPES)[number];

/** One intent extra, as `am start --es/--ei/--el/--ef/--ez` takes it. */
export type AndroidIntentExtra = { key: string; type: AndroidIntentExtraType; value: string };

/**
 * `key=value` as an intent extra. `true`/`false` is a bool, a whole number an
 * int (a long past 32 bits), a decimal a float, anything else a string.
 * `forceString` keeps `123` a string (`--extra-string`).
 */
export function parseAndroidIntentExtra(raw: string, forceString = false): AndroidIntentExtra {
  const at = raw.indexOf("=");
  if (at <= 0) throw new Error(`An extra is key=value; got ${JSON.stringify(raw)}.`);
  const key = raw.slice(0, at).trim();
  const value = raw.slice(at + 1);
  if (!/^[A-Za-z_][\w.$-]*$/u.test(key)) throw new Error(`The extra key ${JSON.stringify(key)} is not a key name.`);
  if (forceString) return { key, type: "string", value };
  if (value === "true" || value === "false") return { key, type: "bool", value };
  if (/^-?\d+$/u.test(value)) {
    const number = Number(value);
    return { key, type: Number.isSafeInteger(number) && number >= -2_147_483_648 && number <= 2_147_483_647 ? "int" : "long", value };
  }
  if (/^-?\d*\.\d+$/u.test(value)) return { key, type: "float", value };
  return { key, type: "string", value };
}

/** The `am start` words for the extras (`--es key value`, …). */
export function androidIntentExtraWords(extras: readonly AndroidIntentExtra[]): string[] {
  const flag: Record<AndroidIntentExtraType, string> = { string: "--es", int: "--ei", long: "--el", float: "--ef", bool: "--ez" };
  return extras.flatMap((extra) => [flag[extra.type], extra.key, extra.value]);
}

/** Launch arguments and extras, on `launchApp` and `relaunchApp`. */
export type AndroidLaunchExtrasArgs = {
  /**
   * Extra `am start` words, as given (`-a android.intent.action.VIEW`,
   * `--activity-clear-task`). Android apps have no argv; these are the
   * launch's own options. `ade android launch … -- <words>`.
   */
  arguments?: string[] | null;
  /** Intent extras (`--extra key=value`). */
  extras?: AndroidIntentExtra[] | null;
};

export type AndroidRelaunchArgs = AndroidPackageArgs & AndroidLaunchExtrasArgs & {
  activity?: string | null;
};

export type AndroidAppState = {
  laneId: string;
  packageName: string;
  installed: boolean;
  running: boolean;
  /** The app's activity is the one in front. */
  foreground: boolean;
  /** The main process id, when it runs. */
  pid: number | null;
  versionName: string | null;
  versionCode: number | null;
  checkedAt: string;
};

export type AndroidForegroundArgs = AndroidLaneArgs & {
  /** Keep asking until an app (or `packageName`) is in front, up to 30000 ms. */
  waitMs?: number | null;
  /** Wait for this app. With it, a wait that runs out refuses with `ANDROID_WAIT_TIMEOUT`. */
  packageName?: string | null;
};

/** The app in front; `null` when none is (the lock screen, a boot in progress). */
export type AndroidForegroundApp = {
  laneId: string;
  packageName: string;
  /** `com.example/.MainActivity`, when the window manager names it. */
  activity: string | null;
  pid: number | null;
  checkedAt: string;
  /** How long the call waited, when it waited. */
  waitedMs: number | null;
} | null;

/* ---------- frame ---------- */

export type AndroidFrameArgs = AndroidLaneArgs & {
  /** A path inside the lane's worktree; omitted = a file under ADE's data folder. */
  outPath?: string | null;
};

export type AndroidFrameResult = {
  laneId: string;
  filePath: string;
  width: number;
  height: number;
  capturedAt: string;
  /** A viewer's live stream was running when the frame was taken. */
  streamRunning: boolean;
};

/* ---------- inspect ---------- */

/** How sure ADE is of the source line: `exact` (an id or tag match), `candidate` (a text match), `none`. */
export type AndroidSourceConfidence = "exact" | "candidate" | "none";

export type AndroidSourceMatch = {
  /** Relative to the lane's worktree, with `/`. */
  sourceFile: string;
  sourceLine: number;
  confidence: Exclude<AndroidSourceConfidence, "none">;
  /** What matched: `testTag("submit")`, `@+id/submit`, `"Sign in"`. */
  reason: string;
  snippet: string;
};

export type AndroidInspectPointArgs = AndroidLaneArgs & {
  x: number;
  y: number;
  /** Aim at this element (`ref`) instead of the smallest one under the point. */
  ref?: string | null;
  /** Add a PNG crop of the element (`screenshotDataUrl`). */
  includeScreenshot?: boolean | null;
};

export type AndroidSelectPointArgs = AndroidInspectPointArgs & AndroidInputRecordArgs;

export type AndroidInspectResult = {
  /**
   * The composer chip: the same packet Apple's Inspect sends, with
   * `metadata.contextSurface: "android-emulator"`. Null when nothing is under the point.
   */
  item: AndroidElementContextItem | null;
  source: AndroidUiTreeSource | "coordinate-fallback" | "none";
  element: AndroidUiElement | null;
};

/**
 * The chip packet. It has Apple's `IosElementContextItem` shape, so the chat
 * composer takes it on the same path; `metadata.contextSurface` says Android.
 */
export type AndroidElementContextItem = {
  kind: "ios_element";
  id: string;
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: AndroidUiBounds | null;
  metadata: Record<string, unknown>;
  accessibilityIdentifier?: string | null;
  screenshotDataUrl?: string | null;
  selectedAt: string;
};

/* ---------- lifecycle ---------- */

/** Why ADE powered the lane's emulator off, when it did. Cleared by the next start. */
export type AndroidPowerOffRecord = {
  at: string;
  /** `idle`: the idle timer. `cleanup`: a `device-cleanup --power-off-idle`. */
  reason: "idle" | "cleanup";
  idleMinutes: number;
};

export type AndroidDeviceCleanupArgs = {
  laneId?: string | null;
  /** Also power off idle ADE emulators now, instead of waiting for the timer. */
  powerOffIdle?: boolean | null;
  /** Report what the pass would do, and change nothing. */
  dryRun?: boolean | null;
  /** Set by the RPC server for agent callers: `powerOffIdle` then reaches the caller's lane only. */
  agentCaller?: boolean | null;
};

/** `deviceCleanup`: what one pass found and did (or, with `dryRun`, would do). */
export type AndroidDeviceCleanupResult = {
  dryRun: boolean;
  /** Devices of lanes that ended, released (an AVD ADE made is deleted; an attached one stays). */
  released: Array<{ laneId: string; avdName: string }>;
  /** Emulators ADE started that no lane holds, stopped. */
  stoppedOrphans: Array<{ serial: string; avdName: string }>;
  /** Lane rows dropped because their AVD is gone from disk. */
  forgottenRows: Array<{ laneId: string; avdName: string }>;
  /** Idle ADE emulators powered off. */
  poweredOff: Array<{ laneId: string; avdName: string; idleMinutes: number }>;
  /**
   * AVDs ADE made that no lane of this project holds. Listed, never deleted:
   * the marker does not name the project, and a released AVD may be kept on purpose.
   */
  unheld: Array<{ avdName: string; markerLaneId: string | null }>;
  /** A failed step never stops the pass. */
  errors: Array<{ avdName: string | null; message: string }>;
  /** The idle timer's setting in minutes; 0 = off. */
  idlePowerOffMinutes: number;
};

/* ---------- the service ---------- */

export type AndroidEmulatorControlServiceApi = {
  /** One real key press with modifiers (`ctrl+a`, arrows, Enter, Tab). */
  pressKey(args: AndroidPressKeyArgs): Promise<AndroidPressKeyResult>;
  /** Force-stop, then start again, with new extras when given. */
  relaunchApp(args: AndroidRelaunchArgs): Promise<AndroidLaunchResult>;
  getAppState(args: AndroidPackageArgs): Promise<AndroidAppState>;
  getForegroundApp(args: AndroidForegroundArgs): Promise<AndroidForegroundApp>;
  /** One PNG of the screen now, not filed as proof (Apple's `frame`). */
  frame(args: AndroidFrameArgs): Promise<AndroidFrameResult>;
  /** The element under a point as a chip packet; changes nothing. */
  inspectPoint(args: AndroidInspectPointArgs): Promise<AndroidInspectResult>;
  /** Inspect with the crop always, as the person's pick (Apple's `selectPoint`). */
  selectPoint(args: AndroidSelectPointArgs): Promise<AndroidInspectResult>;
  /** The cleanup pass now (with `dryRun`, only the report). */
  deviceCleanup(args?: AndroidDeviceCleanupArgs): Promise<AndroidDeviceCleanupResult>;
};

/** The agent actions this section adds (`ANDROID_AGENT_ACTIONS` spreads it). */
export const ANDROID_CONTROL_ACTIONS = [
  "pressKey",
  "relaunchApp",
  "getAppState",
  "getForegroundApp",
  "frame",
  "inspectPoint",
  "selectPoint",
  "deviceCleanup",
] as const;
export type AndroidControlAction = (typeof ANDROID_CONTROL_ACTIONS)[number];
