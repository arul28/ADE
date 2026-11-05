import type {
  AndroidDeviceSetting,
  AndroidDeviceSettings,
  AndroidDisplaySize,
  AndroidTextSize,
} from "../../../shared/types/androidEmulator";
import { runAdb } from "./adb";
import { runDeviceShell } from "./androidDeviceShell";

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
 * Location and appearance stay with the agent verbs (`setLocation`,
 * `setAppearance`); the read reports the appearance so the drawer shows the
 * device's value.
 */

type BootedDevice = { serial: string; adbPath: string };

export type AndroidDeviceSettingsDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** A change can move the screen: the lane's cached UI tree ends. */
  onScreenChanged: (laneId: string) => void;
  signal: AbortSignal;
};

export const ANDROID_TEXT_SCALES: Record<AndroidTextSize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  largest: 1.3,
};

export const ANDROID_DISPLAY_SCALES: Record<AndroidDisplaySize, number> = {
  small: 0.85,
  default: 1,
  large: 1.15,
  larger: 1.3,
};

/*
 * The first focused app (a second display can list `null` first), and the
 * home app, so the launcher reads as "no app in front". `mFocusedApp` names
 * the app even while a system window (the shade, a restart) holds focus.
 */
const FOCUS_LINES = [
  "dumpsys window 2>/dev/null | grep -m1 'mFocusedApp=ActivityRecord' | sed 's/^ */focus:/'",
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
export function parseForegroundPackage(line: string | undefined): string | null {
  const match = line?.match(/\su\d+\s+([A-Za-z0-9_.]+)\/[^\s}]+/u);
  return match?.[1] ?? null;
}

/** Parses the output of the one-shell read. A query the image does not have reads as null. */
export function parseAndroidDeviceSettings(laneId: string, text: string): AndroidDeviceSettings {
  const values = new Map<string, string>();
  const battery = new Map<string, string>();
  let physical: number | null = null;
  let override: number | null = null;
  let focusLine: string | undefined;
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
    if (line.startsWith("focus:")) {
      focusLine = line;
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
  const foreground = parseForegroundPackage(focusLine);
  const homePackage = values.get("home")?.trim().split("/")[0] || null;

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
    foregroundPackage: foreground && foreground !== homePackage ? foreground : null,
  };
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

export function createAndroidDeviceSettings(deps: AndroidDeviceSettingsDeps) {
  const { signal } = deps;

  const shell = async (booted: BootedDevice, script: string, timeoutMs = 15_000) => {
    const result = await runDeviceShell(booted.adbPath, booted.serial, ["sh", "-c", script], { timeoutMs, signal });
    return result;
  };

  /** Runs every line; the first that prints an error stops the change. */
  const apply = async (booted: BootedDevice, lines: string[], what: string) => {
    const result = await shell(booted, lines.join(" && "));
    if (result.exitCode !== 0 || /Exception|Error:|Security|not allowed|Unknown command/iu.test(result.text)) {
      throw new Error(`The emulator did not change ${what}: ${result.text.split(/\r?\n/u)[0]?.slice(0, 240) || `exit ${result.exitCode}`}`);
    }
  };

  const consolePower = async (booted: BootedDevice, args: string[]) => {
    const result = await runAdb(booted.adbPath, ["emu", "power", ...args], { serial: booted.serial, timeoutMs: 15_000, signal, allowFailure: true });
    const text = `${result.stdout.toString("utf8")}${result.stderr}`.trim();
    if (result.exitCode !== 0 || /KO|error/iu.test(text)) {
      throw new Error(`The emulator console did not take "power ${args.join(" ")}": ${text.slice(0, 200) || `exit ${result.exitCode}`}`);
    }
  };

  const read = async (laneId: string, fields: "all" | "foreground"): Promise<AndroidDeviceSettings> => {
    const booted = await deps.requireBooted(laneId);
    const result = await shell(booted, fields === "foreground" ? FOCUS_LINES : READ_SCRIPT, 20_000);
    return parseAndroidDeviceSettings(laneId, result.stdout);
  };

  const write = async (laneId: string, setting: AndroidDeviceSetting): Promise<void> => {
    if (!setting || typeof setting !== "object" || typeof (setting as { kind?: unknown }).kind !== "string") {
      throw new Error("setting must be an object with a kind.");
    }
    const booted = await deps.requireBooted(laneId);
    switch (setting.kind) {
      case "text-size": {
        const scale = ANDROID_TEXT_SCALES[setting.value];
        if (scale === undefined) throw new Error(`text-size must be one of ${Object.keys(ANDROID_TEXT_SCALES).join(", ")}.`);
        await apply(booted, [`settings put system font_scale ${scale}`], "the text size");
        break;
      }
      case "display-size": {
        const scale = ANDROID_DISPLAY_SCALES[setting.value];
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

  return {
    getDeviceSettings: (laneId: string, fields: "all" | "foreground" = "all") => read(laneId, fields),
    setDeviceSetting: write,
  };
}

export type AndroidDeviceSettingsApi = ReturnType<typeof createAndroidDeviceSettings>;
