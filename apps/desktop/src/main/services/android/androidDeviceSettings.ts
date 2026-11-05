import type {
  AndroidAppearanceArgs,
  AndroidDeviceSetting,
  AndroidDeviceSettings,
  AndroidDisplaySize,
  AndroidEmulatorAgentServiceApi,
  AndroidLocationArgs,
  AndroidPermissionArgs,
  AndroidTextSize,
} from "../../../shared/types/androidEmulator";
import { ANDROID_PERMISSIONS } from "../../../shared/types/androidEmulator";
import { assertPackageName } from "./androidApps";
import { runDeviceScript, runDeviceShell, runEmulatorConsole, type BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";

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

/** `mFocusedApp=ActivityRecord{… u0 com.example/.MainActivity t13}` → `com.example`. */
function parseForegroundPackage(line: string | undefined): string | null {
  const match = line?.match(/\su\d+\s+([A-Za-z0-9_.]+)\/[^\s}]+/u);
  return match?.[1] ?? null;
}

/** What is in front of the device now. */
export type AndroidForeground = {
  /** The focused window line (`Window{… u0 com.app/com.app.Main}`); it changes with each window. */
  window: string | null;
  /** The app in front, or null on the home screen. */
  foregroundPackage: string | null;
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
  const foreground = parseForegroundPackage(appLine);
  return { window, foregroundPackage: foreground && foreground !== home ? foreground : null };
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
]);

/** A device setting from a caller, checked for its shape; `write` checks each value. */
export function readAndroidDeviceSetting(value: unknown): AndroidDeviceSetting {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") {
    throw new Error("setting must be an object with a kind.");
  }
  const kind = (value as { kind: string }).kind;
  if (!SETTING_KINDS.has(kind)) throw new Error(`Unknown setting kind "${kind}".`);
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

  const consolePower = (booted: BootedDevice, args: string[]) =>
    runEmulatorConsole(booted, ["power", ...args], `The emulator console did not take "power ${args.join(" ")}"`, { signal });

  const read = async (laneId: string, fields: "all" | "foreground"): Promise<AndroidDeviceSettings> => {
    const booted = await deps.requireBooted(laneId);
    const result = await shell(booted, fields === "foreground" ? FOCUS_LINES : READ_SCRIPT, 20_000);
    return parseAndroidDeviceSettings(laneId, result.stdout);
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
      default:
        throw new Error(`Unknown setting kind "${(setting as { kind: string }).kind}".`);
    }
    deps.onScreenChanged(laneId);
  };

  /** The agent verbs that change the device. */
  const verbs: Pick<AndroidEmulatorAgentServiceApi, "setLocation" | "setAppearance" | "setPermission"> = {
    async setLocation(args: AndroidLocationArgs) {
      const laneId = requireLaneId(args?.laneId);
      const latitude = finiteNumber(args.latitude, "latitude");
      const longitude = finiteNumber(args.longitude, "longitude");
      if (latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90.");
      if (longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180.");
      const booted = await deps.requireBooted(laneId);
      // The emulator console takes longitude first.
      await runEmulatorConsole(booted, ["geo", "fix", String(longitude), String(latitude)], "The emulator did not take the location", { signal });
      return { laneId, latitude, longitude };
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
    getDeviceSettings: (laneId: string, fields: "all" | "foreground" = "all") => read(laneId, fields),
    setDeviceSetting: write,
    verbs,
  };
}
