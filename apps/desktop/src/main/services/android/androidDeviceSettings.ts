import type {
  AndroidAccessibilityOption,
  AndroidAppearanceArgs,
  AndroidDeviceSetting,
  AndroidDeviceSettings,
  AndroidDeviceSettingsFields,
  AndroidDisplaySize,
  AndroidEmulatorAgentServiceApi,
  AndroidEmulatorDeviceServiceApi,
  AndroidLocationArgs,
  AndroidStatusBarArgs,
  AndroidStatusBarResult,
  AndroidPermissionArgs,
  AndroidTextSize,
} from "../../../shared/types/androidEmulator";
import {
  ANDROID_ACCESSIBILITY_LABELS,
  ANDROID_ACCESSIBILITY_OPTIONS,
  ANDROID_DEFAULT_LOCATION,
  ANDROID_PERMISSIONS,
  ANDROID_STATUS_BAR_NETWORKS,
  androidOrientationFor,
  isAndroidAccessibilityOption,
} from "../../../shared/types/androidEmulator";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";
import { assertPackageName } from "./androidApps";
import { ROTATION_PROBE, runDeviceScript, runDeviceShell, runEmulatorConsole, type BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import { createAndroidLaneQueue } from "./androidLaneQueue";

/*
 * The settings the Tools drawer shows and changes: text and display size,
 * the developer switches, the virtual battery and the radios.
 *
 * One read runs ONE device shell with every query in it, because each
 * `adb shell` costs a round trip to the emulator and the drawer reads again
 * after every change. The battery goes through the emulator console
 * (`adb emu power`), so the device sees a real power event and its status bar
 * follows; `dumpsys battery set` would freeze the battery until a reset.
 *
 * The agent verbs that change the device (`setLocation`, `setAppearance`,
 * `setPermission`) are here too. The read reports the appearance so the
 * drawer shows the device's value.
 */

export type AndroidDeviceSettingsDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** A change can move the screen: the lane's cached UI tree ends. */
  onScreenChanged: (laneId: string) => void;
  signal: AbortSignal;
};

const ANDROID_TEXT_SCALES: Record<AndroidTextSize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  largest: 1.3,
};

const ANDROID_DISPLAY_SCALES: Record<AndroidDisplaySize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  larger: 1.3,
};

/*
 * The focused window, the first focused app (a second display can list
 * `null` first), and the home app, so the launcher reads as "no app in
 * front". `mFocusedApp` names the app even while a system window (the shade,
 * a restart) holds focus; `mCurrentFocus` changes with every window, so the
 * UI tree cache keys on it.
 */
const FOCUS_LINES = [
  "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus=|mFocusedApp=ActivityRecord' | sed 's/^ */focus:/'",
  "echo \"home=$(cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1)\"",
].join("; ");

/** TalkBack's package and service, the same on Play and Google APIs images that have it. */
const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
const TALKBACK_SERVICE = `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.TalkBackService`;

/** `font_weight_adjustment` for Bold text, as Settings writes it. */
const BOLD_TEXT_WEIGHT = 300;
/** Daltonizer modes: grayscale (monochromacy) and deuteranomaly (the Settings default for correction). */
const DALTONIZER_GRAYSCALE = 0;
const DALTONIZER_CORRECTION = 12;

const ACCESSIBILITY_KEYS = [
  "high_text_contrast_enabled",
  "font_weight_adjustment",
  "accessibility_display_inversion_enabled",
  "accessibility_display_daltonizer_enabled",
  "accessibility_display_daltonizer",
  "enabled_accessibility_services",
  "accessibility_enabled",
] as const;

/** Prints `boot=<id>`: one boot of the emulator. */
const BOOT_ID_LINE = "echo \"boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)\"";

/**
 * How the display is turned: the window manager's rotation (0 to 3), the
 * natural size and the boot id. The boot id ties ADE's location record to
 * one boot of the emulator.
 */
const ORIENTATION_LINES = [
  `echo "rotation=$(${ROTATION_PROBE} | cut -d= -f2)"`,
  "wm size | sed 's/^/size:/'",
  BOOT_ID_LINE,
].join("; ");

const READ_SCRIPT = [
  "echo \"night=$(cmd uimode night 2>/dev/null)\"",
  "echo \"font=$(settings get system font_scale)\"",
  "wm density | sed 's/^/density:/'",
  "echo \"anim=$(settings get global window_animation_scale),$(settings get global transition_animation_scale),$(settings get global animator_duration_scale)\"",
  "echo \"taps=$(settings get system show_touches)\"",
  "echo \"bounds=$(getprop debug.layout)\"",
  "dumpsys battery | grep -E '^ *(level|AC powered|USB powered|Wireless powered):' | sed 's/^ */battery:/'",
  "echo \"wifi=$(settings get global wifi_on)\"",
  "echo \"data=$(settings get global mobile_data)\"",
  "echo \"airplane=$(settings get global airplane_mode_on)\"",
  // Parity: the accessibility switches and demo mode, one `settings list` each.
  `settings list secure | grep -E '^(${ACCESSIBILITY_KEYS.join("|")})=' | sed 's/^/secure:/'`,
  "settings list global | grep -E '^sysui_tuner_demo_on=' | sed 's/^/global:/'",
  `echo "talkback=$(pm path ${TALKBACK_PACKAGE} 2>/dev/null | head -n 1)"`,
  ORIENTATION_LINES,
  FOCUS_LINES,
].join("; ");

function closest<K extends string>(table: Record<K, number>, value: number | null, tolerance: number): K | null {
  if (value === null || !Number.isFinite(value)) return null;
  for (const [key, scale] of Object.entries(table) as Array<[K, number]>) {
    if (Math.abs(scale - value) <= tolerance) return key;
  }
  return null;
}

/** `null` (the setting was never written) reads as the platform default. */
function settingNumber(raw: string | undefined, fallback: number | null): number | null {
  const text = raw?.trim();
  if (!text || text === "null") return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function settingFlag(raw: string | undefined, fallback: boolean | null): boolean | null {
  const value = settingNumber(raw, null);
  if (value === null) return raw?.trim() === "null" || !raw?.trim() ? fallback : null;
  return value !== 0;
}

/**
 * `wifi_on`: 0 off, 1 on, 2 on in airplane mode, 3 off for airplane mode
 * (it comes back on when airplane mode ends).
 */
function wifiOn(raw: string | undefined): boolean | null {
  const value = settingNumber(raw, null);
  if (value === null) return null;
  return value === 1 || value === 2;
}

/** `mFocusedApp=ActivityRecord{… u0 com.example/.MainActivity t13}` → `com.example` and `com.example/.MainActivity`. */
function parseForegroundApp(line: string | undefined): { packageName: string; activity: string } | null {
  const match = line?.match(/\su\d+\s+([A-Za-z0-9_.]+)\/([^\s}]+)/u);
  return match ? { packageName: match[1]!, activity: `${match[1]}/${match[2]}` } : null;
}

/** What is in front of the device now. */
export type AndroidForeground = {
  /** The focused window line (`Window{… u0 com.app/com.app.Main}`); it changes with each window. */
  window: string | null;
  /** The app in front, or null on the home screen (the launcher is "no app", as SpringBoard is on Apple). */
  foregroundPackage: string | null;
  /** Its component (`com.app/.Main`), or null with no app in front. */
  activity: string | null;
};

/** Parses the `focus:` and `home=` lines of `FOCUS_LINES`. */
function parseAndroidForeground(text: string): AndroidForeground {
  let window: string | null = null;
  let appLine: string | undefined;
  let home: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("focus:")) {
      const currentFocus = /mCurrentFocus=(.*)$/u.exec(line)?.[1]?.trim();
      if (currentFocus !== undefined) window ??= currentFocus;
      else if (line.includes("mFocusedApp=")) appLine ??= line;
    } else if (line.startsWith("home=")) {
      home = line.slice("home=".length).trim().split("/")[0] || null;
    }
  }
  const app = parseForegroundApp(appLine);
  const front = app && app.packageName !== home ? app : null;
  return { window, foregroundPackage: front?.packageName ?? null, activity: front?.activity ?? null };
}

/** Reads what is in front of the device: one device shell. */
export async function readAndroidForeground(booted: BootedDevice, signal: AbortSignal): Promise<AndroidForeground> {
  const result = await runDeviceScript(booted, FOCUS_LINES, { timeoutMs: 15_000, signal });
  return parseAndroidForeground(result.stdout);
}

/**
 * `camera` → `android.permission.CAMERA`; the short names of
 * `ANDROID_PERMISSIONS` map to their full name (`location` →
 * `android.permission.ACCESS_FINE_LOCATION`); a dotted name stays as it is.
 */
function androidPermissionName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z][\w.]*$/u.test(trimmed)) throw new Error(`permission ${JSON.stringify(value)} is not a permission name.`);
  if (trimmed.includes(".")) return trimmed;
  const known = ANDROID_PERMISSIONS.find((permission) => permission.short === trimmed.toLowerCase());
  return known?.value ?? `android.permission.${trimmed.toUpperCase()}`;
}

const SETTING_KINDS: ReadonlySet<string> = new Set<AndroidDeviceSetting["kind"]>([
  "text-size", "display-size", "animations", "show-taps", "layout-bounds", "battery", "wifi", "mobile-data", "airplane",
  "accessibility",
]);

/** A device setting from a caller, checked for its shape; `write` checks each value. */
export function readAndroidDeviceSetting(value: unknown): AndroidDeviceSetting {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") {
    throw new Error("setting must be an object with a kind.");
  }
  const kind = (value as { kind: string }).kind;
  if (!SETTING_KINDS.has(kind)) throw new Error(`Unknown setting kind "${kind}".`);
  if (kind === "accessibility" && !isAndroidAccessibilityOption((value as { option?: unknown }).option)) {
    throw new Error(`accessibility option must be one of ${ANDROID_ACCESSIBILITY_OPTIONS.join(", ")}.`);
  }
  return value as AndroidDeviceSetting;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

/** Parses the output of the one-shell read. A query the image does not have reads as null. */
function parseAndroidDeviceSettings(laneId: string, text: string): AndroidDeviceSettings {
  const values = new Map<string, string>();
  const battery = new Map<string, string>();
  let physical: number | null = null;
  let override: number | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("density:")) {
      const match = line.match(/(Physical|Override) density:\s*(\d+)/u);
      if (match?.[1] === "Physical") physical = Number(match[2]);
      if (match?.[1] === "Override") override = Number(match[2]);
      continue;
    }
    if (line.startsWith("battery:")) {
      const [key, value] = line.slice("battery:".length).split(":");
      if (key && value !== undefined) battery.set(key.trim(), value.trim());
      continue;
    }
    if (line.startsWith("focus:")) continue;
    if (line.startsWith("size:")) {
      const match = /(Physical|Override) size:\s*(\d+)x(\d+)/u.exec(line);
      if (match) values.set(`size.${match[1]}`, `${match[2]}x${match[3]}`);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }

  const night = values.get("night") ?? "";
  const appearance = /:\s*yes\b/iu.test(night) ? "dark" : /:\s*(no|auto|custom)\b/iu.test(night) ? "light" : null;
  const fontScale = settingNumber(values.get("font"), 1);
  const scales = (values.get("anim") ?? "").split(",").map((part) => settingNumber(part, 1));
  const animationsOff = scales.length === 3 && scales.every((scale) => scale !== null)
    ? scales.every((scale) => scale === 0)
    : null;
  const level = battery.has("level") ? Number(battery.get("level")) : NaN;
  const powered = ["AC powered", "USB powered", "Wireless powered"]
    .filter((key) => battery.has(key))
    .map((key) => battery.get(key) === "true");
  const bounds = values.get("bounds")?.trim();

  return {
    laneId,
    appearance,
    fontScale,
    textSize: closest(ANDROID_TEXT_SCALES, fontScale, 0.01),
    density: { physical, override },
    displaySize: physical === null
      ? null
      : override === null || override === physical
        ? "default"
        : closest(ANDROID_DISPLAY_SCALES, override / physical, 0.02),
    animationsOff,
    showTaps: settingFlag(values.get("taps"), false),
    layoutBounds: bounds === undefined ? null : bounds === "true" || bounds === "1",
    battery: {
      level: Number.isFinite(level) ? level : null,
      charging: powered.length ? powered.some(Boolean) : null,
    },
    network: {
      wifi: wifiOn(values.get("wifi")),
      mobileData: settingFlag(values.get("data"), null),
      airplane: settingFlag(values.get("airplane"), false),
    },
    foregroundPackage: parseAndroidForeground(text).foregroundPackage,
    accessibility: parseAccessibility(values),
    statusBarOverridden: settingFlag(values.get("global:sysui_tuner_demo_on"), false),
    location: null,
    orientation: parseOrientation(values),
  };
}

/** The accessibility switches from the `secure:` lines; TalkBack is null on an image without it. */
function parseAccessibility(values: Map<string, string>): Record<AndroidAccessibilityOption, boolean | null> {
  const secure = (key: string) => values.get(`secure:${key}`);
  const daltonizerOn = settingFlag(secure("accessibility_display_daltonizer_enabled"), false);
  const mode = settingNumber(secure("accessibility_display_daltonizer"), DALTONIZER_CORRECTION);
  const weight = settingNumber(secure("font_weight_adjustment"), 0);
  const hasTalkBack = (values.get("talkback") ?? "").trim().startsWith("package:");
  const services = (secure("enabled_accessibility_services") ?? "").split(":").map((entry) => entry.trim());
  const talkbackOn = services.some((entry) => entry === TALKBACK_SERVICE || entry.startsWith(`${TALKBACK_PACKAGE}/`));
  return {
    "increase-contrast": settingFlag(secure("high_text_contrast_enabled"), false),
    "bold-text": weight === null ? null : weight >= BOLD_TEXT_WEIGHT,
    "invert-colors": settingFlag(secure("accessibility_display_inversion_enabled"), false),
    grayscale: daltonizerOn === null ? null : daltonizerOn && mode === DALTONIZER_GRAYSCALE,
    "color-correction": daltonizerOn === null ? null : daltonizerOn && mode !== DALTONIZER_GRAYSCALE && mode !== -1,
    talkback: hasTalkBack ? talkbackOn : null,
  };
}

/** The display's turn from the `rotation=` and `size:` lines; the override size wins, as on the screen. */
function parseOrientation(values: Map<string, string>): DeviceOrientation | null {
  const rotation = settingNumber(values.get("rotation"), null);
  const size = values.get("size.Override") ?? values.get("size.Physical");
  if (rotation === null || !size) return null;
  const [width, height] = size.split("x").map(Number);
  return androidOrientationFor(rotation, Number(width) > Number(height));
}

/** The boot id from the read (`boot=`), or null. */
function parseBootId(text: string): string | null {
  return /^boot=([0-9a-f-]{8,})\s*$/mu.exec(text)?.[1] ?? null;
}

/** `setStatusBar`'s fields, checked, with the screenshot values for each one left out. */
export function readStatusBar(args: Partial<AndroidStatusBarArgs>): {
  time: string; hhmm: string; network: string; wifiBars: number; cellularBars: number; batteryLevel: number; charging: boolean;
} {
  const time = (typeof args.time === "string" && args.time.trim()) || "9:41";
  const clock = /^(\d{1,2}):(\d{2})$/u.exec(time);
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) throw new Error("time must be H:MM or HH:MM (24-hour), like 9:41.");
  const network = (typeof args.dataNetwork === "string" && args.dataNetwork.trim().toLowerCase()) || "wifi";
  if (!(ANDROID_STATUS_BAR_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`dataNetwork must be one of ${ANDROID_STATUS_BAR_NETWORKS.join(", ")}.`);
  }
  const bars = (value: unknown, name: string): number => {
    if (value === undefined || value === null) return 4;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) throw new Error(`${name} must be a whole number from 0 to 4.`);
    return value;
  };
  const level = args.batteryLevel ?? 100;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 100) {
    throw new Error("batteryLevel must be a whole number from 0 to 100.");
  }
  const state = args.batteryState ?? null;
  if (state !== null && state !== "charging" && state !== "charged" && state !== "discharging") {
    throw new Error("batteryState must be charging, charged or discharging.");
  }
  return {
    time,
    hhmm: `${clock[1]!.padStart(2, "0")}${clock[2]}`,
    network,
    wifiBars: bars(args.wifiBars, "wifiBars"),
    cellularBars: bars(args.cellularBars, "cellularBars"),
    batteryLevel: level,
    charging: state === "charging",
  };
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

export function createAndroidDeviceSettings(deps: AndroidDeviceSettingsDeps) {
  const { signal } = deps;

  const shell = (booted: BootedDevice, script: string, timeoutMs = 15_000) => runDeviceScript(booted, script, { timeoutMs, signal });

  /** Runs every line; the first that prints an error stops the change. */
  const apply = async (booted: BootedDevice, lines: string[], what: string) => {
    const result = await shell(booted, lines.join(" && "));
    if (result.exitCode !== 0 || /Exception|Error:|Security|not allowed|Unknown command/iu.test(result.text)) {
      throw new Error(`The emulator did not change ${what}: ${result.text.split(/\r?\n/u)[0]?.slice(0, 240) || `exit ${result.exitCode}`}`);
    }
  };

  /** The status bar each lane asked for, to apply again after the screen re-lays out. */
  const statusBars = new Map<string, ReturnType<typeof readStatusBar>>();
  /** Set, clear and refresh of one lane's bar run in order, so the newest request is the last one sent. */
  const statusBarQueue = createAndroidLaneQueue();

  /*
   * One accessibility switch. Grayscale and color correction share the
   * daltonizer: turning one on sets its mode; turning one off ends the
   * daltonizer only while that mode is the one in use.
   */
  const writeAccessibility = async (booted: BootedDevice, option: AndroidAccessibilityOption, on: boolean) => {
    const label = ANDROID_ACCESSIBILITY_LABELS[option];
    const daltonizerOff = (mode: "grayscale" | "correction") => {
      const test = mode === "grayscale" ? `= "${DALTONIZER_GRAYSCALE}"` : `!= "${DALTONIZER_GRAYSCALE}"`;
      return `if [ "$(settings get secure accessibility_display_daltonizer)" ${test} ]; then settings put secure accessibility_display_daltonizer_enabled 0; fi`;
    };
    switch (option) {
      case "increase-contrast":
        return apply(booted, [`settings put secure high_text_contrast_enabled ${on ? 1 : 0}`], label);
      case "bold-text":
        return apply(booted, [`settings put secure font_weight_adjustment ${on ? BOLD_TEXT_WEIGHT : 0}`], label);
      case "invert-colors":
        return apply(booted, [`settings put secure accessibility_display_inversion_enabled ${on ? 1 : 0}`], label);
      case "grayscale":
      case "color-correction": {
        const mode = option === "grayscale" ? DALTONIZER_GRAYSCALE : DALTONIZER_CORRECTION;
        return apply(booted, on
          ? [`settings put secure accessibility_display_daltonizer ${mode}`, "settings put secure accessibility_display_daltonizer_enabled 1"]
          : [daltonizerOff(option === "grayscale" ? "grayscale" : "correction")], label);
      }
      case "talkback": {
        const read = await shell(booted, [
          `pm path ${TALKBACK_PACKAGE} 2>/dev/null | head -n 1`,
          "echo \"services=$(settings get secure enabled_accessibility_services)\"",
        ].join("; "));
        if (!read.stdout.includes("package:")) {
          throw new Error("This emulator's system image has no TalkBack app. Google Play images have it; most Google APIs images do not.");
        }
        const current = (/^services=(.*)$/mu.exec(read.stdout)?.[1] ?? "").trim();
        const others = current === "null" ? [] : current.split(":").map((entry) => entry.trim())
          .filter((entry) => entry && !entry.startsWith(`${TALKBACK_PACKAGE}/`));
        const next = on ? [...others, TALKBACK_SERVICE] : others;
        // An empty list is written as "" so Android reads "no services".
        return apply(booted, [
          `settings put secure enabled_accessibility_services ${next.length ? next.join(":") : "\"\""}`,
          `settings put secure accessibility_enabled ${next.length ? 1 : 0}`,
        ], label);
      }
      default:
        throw new Error(`Unknown accessibility option "${String(option)}".`);
    }
  };

  const consolePower = (booted: BootedDevice, args: string[]) =>
    runEmulatorConsole(booted, ["power", ...args], `The emulator console did not take "power ${args.join(" ")}"`, { signal });

  /**
   * The last location ADE set, per lane, with the boot it was set on. The
   * emulator cannot report its location (the console has no "geo get"), so
   * this record is what the drawer shows, as Apple's; a new boot ends it.
   */
  const locations = new Map<string, { bootId: string | null; latitude: number; longitude: number }>();

  const readBootId = async (booted: BootedDevice) =>
    parseBootId((await shell(booted, BOOT_ID_LINE)).stdout);

  const read = async (laneId: string, fields: AndroidDeviceSettingsFields): Promise<AndroidDeviceSettings> => {
    const booted = await deps.requireBooted(laneId);
    const script = fields === "foreground" ? FOCUS_LINES : fields === "orientation" ? ORIENTATION_LINES : READ_SCRIPT;
    const result = await shell(booted, script, 20_000);
    const settings = parseAndroidDeviceSettings(laneId, result.stdout);
    if (fields !== "all") return settings;
    const placed = locations.get(laneId);
    const bootId = parseBootId(result.stdout);
    if (placed && placed.bootId !== null && bootId !== null && placed.bootId !== bootId) locations.delete(laneId);
    const current = locations.get(laneId);
    return { ...settings, location: current ? { latitude: current.latitude, longitude: current.longitude } : null };
  };

  /** SystemUI demo mode: each command is one broadcast; `sysui_demo_allowed` must be 1 first. */
  const demo = (command: string, extras: Record<string, string> = {}) =>
    ["am broadcast -a com.android.systemui.demo -e command", command,
      ...Object.entries(extras).flatMap(([key, value]) => ["-e", key, value]), ">/dev/null"].join(" ");

  /** Demo mode's enter and each icon of the bar. */
  const statusBarCommands = (bar: ReturnType<typeof readStatusBar>): string[] => {
    const wifi = bar.network === "wifi";
    return [
      demo("enter"),
      demo("clock", { hhmm: bar.hhmm }),
      demo("battery", { level: String(bar.batteryLevel), plugged: bar.charging ? "true" : "false" }),
      demo("network", wifi
        ? { wifi: "show", level: String(bar.wifiBars), fully: "true" }
        : { wifi: "hide" }),
      // Wi-Fi hides the mobile icon: SystemUI keeps a stale type label (3G) on it in demo mode.
      demo("network", wifi
        ? { mobile: "hide" }
        : { mobile: "show", datatype: bar.network, level: String(bar.cellularBars), fully: "true" }),
      demo("notifications", { visible: "false" }),
    ];
  };

  /**
   * SystemUI adds one more demo Wi-Fi icon each time the status bar lays out
   * again in demo mode (a rotation, a text or display size change). Sending
   * the icons again does not remove the extra ones; leaving demo mode and
   * entering it again does. Only while the override is still on: a person may
   * have turned demo mode off on the device.
   */
  const refreshStatusBar = (laneId: string): Promise<void> => statusBarQueue(laneId, async () => {
    const bar = statusBars.get(laneId);
    if (!bar) return;
    const booted = await deps.requireBooted(laneId);
    const commands = [demo("exit"), ...statusBarCommands(bar)].join(" && ");
    await apply(booted, [`if [ "$(settings get global sysui_tuner_demo_on)" = 1 ]; then ${commands}; fi`], "the status bar");
  });

  const statusBarState = async (booted: BootedDevice, laneId: string, time: string | null): Promise<AndroidStatusBarResult> => {
    const text = (await shell(booted, "settings get global sysui_tuner_demo_on")).stdout.trim();
    return { laneId, overridden: text === "1", time };
  };

  const write = async (laneId: string, value: unknown): Promise<void> => {
    const setting = readAndroidDeviceSetting(value);
    const booted = await deps.requireBooted(laneId);
    switch (setting.kind) {
      case "text-size": {
        const scale = Object.hasOwn(ANDROID_TEXT_SCALES, setting.value) ? ANDROID_TEXT_SCALES[setting.value] : undefined;
        if (scale === undefined) throw new Error(`text-size must be one of ${Object.keys(ANDROID_TEXT_SCALES).join(", ")}.`);
        await apply(booted, [`settings put system font_scale ${scale}`], "the text size");
        break;
      }
      case "display-size": {
        const scale = Object.hasOwn(ANDROID_DISPLAY_SCALES, setting.value) ? ANDROID_DISPLAY_SCALES[setting.value] : undefined;
        if (scale === undefined) throw new Error(`display-size must be one of ${Object.keys(ANDROID_DISPLAY_SCALES).join(", ")}.`);
        if (setting.value === "default") {
          await apply(booted, ["wm density reset"], "the display size");
          break;
        }
        const current = parseAndroidDeviceSettings(laneId, (await shell(booted, "wm density | sed 's/^/density:/'")).stdout);
        if (!current.density.physical) throw new Error("The emulator did not report its screen density.");
        await apply(booted, [`wm density ${Math.round(current.density.physical * scale)}`], "the display size");
        break;
      }
      case "animations": {
        const scale = bool(setting.off, "off") ? 0 : 1;
        await apply(booted, [
          `settings put global window_animation_scale ${scale}`,
          `settings put global transition_animation_scale ${scale}`,
          `settings put global animator_duration_scale ${scale}`,
        ], "the animation speed");
        break;
      }
      case "show-taps":
        await apply(booted, [`settings put system show_touches ${bool(setting.on, "on") ? 1 : 0}`], "Show taps");
        break;
      case "layout-bounds":
        // SYSPROPS_TRANSACTION makes running apps read the property again, as the developer option does.
        await apply(booted, [
          `setprop debug.layout ${bool(setting.on, "on") ? "true" : "false"}`,
          "service call activity 1599295570 >/dev/null",
        ], "Show layout bounds");
        break;
      case "battery": {
        if (setting.level !== undefined && setting.level !== null) {
          const level = Number(setting.level);
          if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error("battery level must be a whole number from 0 to 100.");
          await consolePower(booted, ["capacity", String(level)]);
        }
        if (setting.charging !== undefined && setting.charging !== null) {
          const charging = bool(setting.charging, "charging");
          await consolePower(booted, ["ac", charging ? "on" : "off"]);
          await consolePower(booted, ["status", charging ? "charging" : "discharging"]);
        }
        break;
      }
      case "wifi":
        await apply(booted, [`svc wifi ${bool(setting.on, "on") ? "enable" : "disable"}`], "Wi-Fi");
        break;
      case "mobile-data":
        await apply(booted, [`svc data ${bool(setting.on, "on") ? "enable" : "disable"}`], "mobile data");
        break;
      case "airplane":
        await apply(booted, [`cmd connectivity airplane-mode ${bool(setting.on, "on") ? "enable" : "disable"}`], "airplane mode");
        break;
      case "accessibility":
        await writeAccessibility(booted, setting.option, bool(setting.on, "on"));
        break;
      default:
        throw new Error(`Unknown setting kind "${(setting as { kind: string }).kind}".`);
    }
    if (setting.kind === "text-size" || setting.kind === "display-size") await refreshStatusBar(laneId);
    deps.onScreenChanged(laneId);
  };

  /** The agent verbs that change the device. */
  const verbs: Pick<AndroidEmulatorAgentServiceApi, "setLocation" | "setAppearance" | "setPermission">
    & Pick<AndroidEmulatorDeviceServiceApi, "clearLocation" | "setStatusBar" | "clearStatusBar"> = {
    async setLocation(args: AndroidLocationArgs) {
      const laneId = requireLaneId(args?.laneId);
      const latitude = finiteNumber(args.latitude, "latitude");
      const longitude = finiteNumber(args.longitude, "longitude");
      if (latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90.");
      if (longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180.");
      const booted = await deps.requireBooted(laneId);
      // The emulator console takes longitude first.
      await runEmulatorConsole(booted, ["geo", "fix", String(longitude), String(latitude)], "The emulator did not take the location", { signal });
      locations.set(laneId, { bootId: await readBootId(booted).catch(() => null), latitude, longitude });
      return { laneId, latitude, longitude };
    },

    // Parity: Apple's Clear location. The emulator has no "no location", so
    // the GPS goes back to where a cold boot puts it, and ADE's record ends.
    async clearLocation(args) {
      const laneId = requireLaneId(args?.laneId);
      const booted = await deps.requireBooted(laneId);
      const { latitude, longitude } = ANDROID_DEFAULT_LOCATION;
      await runEmulatorConsole(booted, ["geo", "fix", String(longitude), String(latitude)], "The emulator did not take the location", { signal });
      locations.delete(laneId);
      return { laneId, latitude, longitude, cleared: true as const };
    },

    // Parity: Apple's status bar override, as SystemUI demo mode.
    async setStatusBar(args: AndroidStatusBarArgs) {
      const laneId = requireLaneId(args?.laneId);
      const bar = readStatusBar(args);
      return statusBarQueue(laneId, async () => {
        const booted = await deps.requireBooted(laneId);
        await apply(booted, [
          "settings put global sysui_demo_allowed 1",
          // The tuner switch is what SystemUI reads for "in demo mode", and what the read reports.
          "settings put global sysui_tuner_demo_on 1",
          ...statusBarCommands(bar),
        ], "the status bar");
        statusBars.set(laneId, bar);
        deps.onScreenChanged(laneId);
        return statusBarState(booted, laneId, bar.time);
      });
    },

    async clearStatusBar(args) {
      const laneId = requireLaneId(args?.laneId);
      return statusBarQueue(laneId, async () => {
        const booted = await deps.requireBooted(laneId);
        await apply(booted, [demo("exit"), "settings put global sysui_tuner_demo_on 0"], "the status bar");
        statusBars.delete(laneId);
        deps.onScreenChanged(laneId);
        return statusBarState(booted, laneId, null);
      });
    },

    async setAppearance(args: AndroidAppearanceArgs) {
      const laneId = requireLaneId(args?.laneId);
      const appearance = args.appearance;
      if (appearance !== "light" && appearance !== "dark") throw new Error("appearance must be light or dark.");
      const booted = await deps.requireBooted(laneId);
      const result = await runDeviceShell(booted.adbPath, booted.serial, ["cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"], { timeoutMs: 15_000, signal });
      if (result.exitCode !== 0 || /Error|Exception|Unknown/u.test(result.text)) {
        throw new Error(`The emulator did not change its appearance: ${result.text.slice(0, 200)}`);
      }
      deps.onScreenChanged(laneId);
      return { laneId, appearance };
    },

    async setPermission(args: AndroidPermissionArgs) {
      const laneId = requireLaneId(args?.laneId);
      const action = args.action;
      if (action !== "grant" && action !== "revoke") throw new Error("action must be grant or revoke.");
      const packageName = assertPackageName(args.packageName);
      const permission = androidPermissionName(typeof args.permission === "string" ? args.permission : "");
      const booted = await deps.requireBooted(laneId);
      const result = await runDeviceShell(booted.adbPath, booted.serial, ["pm", action, packageName, permission], { timeoutMs: 15_000, signal });
      if (result.exitCode !== 0 || /Exception|Error|Unknown/u.test(result.text)) {
        const notInstalled = /Unknown package|not installed/iu.test(result.text);
        if (notInstalled) throw new AndroidEmulatorFailure("ANDROID_APP_NOT_FOUND", `${packageName} is not installed on this lane's emulator.`);
        throw new Error(`pm ${action} ${permission} failed: ${result.text.split(/\r?\n/u)[0]?.slice(0, 240) ?? `exit ${result.exitCode}`}. Only runtime (dangerous) permissions the app declares can be granted or revoked.`);
      }
      return { laneId, action, packageName, permission };
    },
  };

  return {
    getDeviceSettings: (laneId: string, fields: AndroidDeviceSettingsFields = "all") => read(laneId, fields),
    setDeviceSetting: write,
    refreshStatusBar,
    verbs,
  };
}
