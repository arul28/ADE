/**
 * `ade android`: the device-state verbs at `ade apple`'s level
 * (`accessibility`, `status-bar`, `location --clear`, `play-store-shots`,
 * `window`), and their text formatters. cliAndroid.ts keeps the flag tables
 * and calls `buildAndroidDevicePlan` before the suite.
 *
 * This module and cliAndroid.ts import each other, as cliAndroidSuite.ts
 * does. The cycle is safe under the same rule:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import {
  ANDROID_ACCESSIBILITY_LABELS,
  ANDROID_ACCESSIBILITY_OPTIONS,
  ANDROID_STATUS_BAR_NETWORKS,
  ANDROID_WINDOW_LAYOUT_ACTIONS,
} from "../../desktop/src/shared/types/androidEmulator";
import {
  CliUsageError,
  asString,
  isRecord,
  readFlag,
  readNumberOption,
  readValue,
  renderKeyValues,
  renderTable,
  unwrapActionEnvelope,
  type CliPlan,
  type FormatterId,
  type JsonObject,
} from "./cli";
import { withAsked } from "./cliAndroid";

type AndroidActionBuilder = (
  label: string,
  method: string,
  payload: JsonObject,
  formatter: FormatterId,
  extra?: { shapeResult?: (values: JsonObject) => unknown; progressNotice?: string },
) => CliPlan & { kind: "execute" };

/** `ade android window`'s layout switches (`--left`), each to its action. */
const WINDOW_LAYOUT_FLAGS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["--split"], "split"],
  [["--left"], "left"],
  [["--right"], "right"],
  [["--top"], "top"],
  [["--bottom"], "bottom"],
  [["--swap"], "swap"],
  [["--freeform", "--free"], "freeform"],
  [["--fill", "--full", "--full-screen"], "fill"],
  [["--close"], "close"],
];

/**
 * Spellings of the verbs (Apple's is `app-store-shots`). cliAndroid.ts lists
 * each verb's flags under every spelling, as literals: a value from this
 * module may not be read at module scope there (the import cycle rule).
 */
const ANDROID_DEVICE_VERB_ALIASES: Readonly<Record<string, string>> = {
  a11y: "accessibility",
  "store-shots": "play-store-shots",
  "app-store-shots": "play-store-shots",
  windows: "window",
};

/** The device verbs; null for any other verb (and for `location` without `--clear`). */
export function buildAndroidDevicePlan(
  rawSub: string,
  args: string[],
  ctx: {
    positionals: () => string[];
    laneClaim: () => JsonObject;
    chatSessionId: string | null;
    androidAction: AndroidActionBuilder;
  },
): CliPlan | null {
  const sub = ANDROID_DEVICE_VERB_ALIASES[rawSub] ?? rawSub;
  const { positionals, laneClaim, androidAction } = ctx;
  const usage = (message: string) => new CliUsageError(`android ${sub}: ${message}`);

  if (sub === "accessibility") {
    // `ade apple accessibility <option> on|off`'s shape.
    const on = readFlag(args, ["--on"]);
    const off = readFlag(args, ["--off"]);
    if (on && off) throw usage("use --on or --off, not both.");
    const optionFlag = readValue(args, ["--option"]);
    const words = positionals();
    const option = (optionFlag ?? words[0] ?? "").toLowerCase();
    if (!(ANDROID_ACCESSIBILITY_OPTIONS as readonly string[]).includes(option)) {
      throw usage(`say one of ${ANDROID_ACCESSIBILITY_OPTIONS.join(", ")}, then on or off.`);
    }
    const state = (words[optionFlag ? 0 : 1] ?? "").toLowerCase();
    const enabled = on ? true : off ? false : state === "on" || state === "true" ? true : state === "off" || state === "false" ? false : null;
    if (enabled === null) throw usage("needs a state: on, off, --on or --off.");
    return androidAction("android accessibility", "setDeviceSetting", {
      ...laneClaim(),
      setting: { kind: "accessibility", option, on: enabled },
    }, "android-settings", { shapeResult: withAsked({ changed: `${option} ${enabled ? "on" : "off"}` }) });
  }

  if (sub === "status-bar") {
    if (readFlag(args, ["--clear", "--reset"])) {
      return androidAction("android status-bar", "clearStatusBar", laneClaim(), "android-status-bar");
    }
    const time = readValue(args, ["--time"]);
    const dataNetwork = readValue(args, ["--data-network"]);
    if (dataNetwork && !(ANDROID_STATUS_BAR_NETWORKS as readonly string[]).includes(dataNetwork.toLowerCase())) {
      throw usage(`--data-network takes ${ANDROID_STATUS_BAR_NETWORKS.join(", ")}.`);
    }
    const wifiBars = readNumberOption(args, ["--wifi-bars"]);
    const cellularBars = readNumberOption(args, ["--cellular-bars"]);
    const batteryLevel = readNumberOption(args, ["--battery-level"]);
    const batteryState = readValue(args, ["--battery-state"]);
    if (batteryState && !["charging", "charged", "discharging"].includes(batteryState)) {
      throw usage("--battery-state takes charging, charged or discharging.");
    }
    return androidAction("android status-bar", "setStatusBar", {
      ...laneClaim(),
      ...(time ? { time } : {}),
      ...(dataNetwork ? { dataNetwork: dataNetwork.toLowerCase() } : {}),
      ...(wifiBars == null ? {} : { wifiBars }),
      ...(cellularBars == null ? {} : { cellularBars }),
      ...(batteryLevel == null ? {} : { batteryLevel }),
      ...(batteryState ? { batteryState } : {}),
    }, "android-status-bar");
  }

  if (sub === "location" && readFlag(args, ["--clear", "--reset"])) {
    return androidAction("android location", "clearLocation", laneClaim(), "android-action", {
      shapeResult: withAsked({ action: "location-clear" }),
    });
  }

  if (sub === "play-store-shots") {
    const noProof = readFlag(args, ["--no-proof"]);
    return androidAction("android play-store-shots", "storeScreenshots", {
      ...laneClaim(),
      ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
      ...(noProof ? { proof: false } : {}),
    }, "android-store-shots", { progressNotice: "Taking Google Play screenshots of the lane's emulator (a foldable folds and opens)…" });
  }

  if (sub === "window") {
    // `ade apple window`'s shape: one layout, as a switch or a positional.
    const packageName = readValue(args, ["--package"]);
    const withPackage = readValue(args, ["--with"]);
    const sizeValue = readValue(args, ["--size"]);
    const moveValue = readValue(args, ["--move"]);
    const chosen = WINDOW_LAYOUT_FLAGS.filter(([names]) => readFlag(args, [...names])).map(([, action]) => action);
    const positional = positionals()[0]?.toLowerCase() ?? null;
    if (positional) chosen.push(positional === "full" || positional === "full-screen" ? "fill" : positional === "free" ? "freeform" : positional);
    if (sizeValue) chosen.push("size");
    if (moveValue) chosen.push("move");
    const unique = [...new Set(chosen)];
    if (unique.length > 1) throw usage(`takes one layout at a time, not ${unique.join(" and ")}.`);
    const action = unique[0] ?? "status";
    if (!(ANDROID_WINDOW_LAYOUT_ACTIONS as readonly string[]).includes(action)) {
      throw usage(`unknown layout '${action}'. Use ${ANDROID_WINDOW_LAYOUT_ACTIONS.join(", ")}.`);
    }
    let frame: JsonObject = {};
    if (action === "size") {
      const match = /^(\d+)\s*[x×,]\s*(\d+)$/u.exec(sizeValue ?? "");
      if (!match) throw usage("--size takes WIDTHxHEIGHT in pixels, e.g. --size 1000x1200.");
      frame = { width: Number(match[1]), height: Number(match[2]) };
    }
    if (action === "move") {
      const match = /^(\d+)\s*,\s*(\d+)$/u.exec(moveValue ?? "");
      if (!match) throw usage("--move takes X,Y in pixels (the window's new top-left corner), e.g. --move 0,200.");
      frame = { x: Number(match[1]), y: Number(match[2]) };
    }
    if (withPackage && action !== "split" && action !== "left" && action !== "right" && action !== "top" && action !== "bottom") {
      throw usage("--with goes with split, left, right, top or bottom.");
    }
    return {
      ...androidAction("android window", "windowLayout", {
        ...laneClaim(),
        action,
        ...(packageName ? { packageName } : {}),
        ...(withPackage ? { withPackage } : {}),
        ...frame,
      }, "android-window"),
      // A layout that did not land exits 1, like `ade apple window`.
      exitCodeFromResult: (result: unknown) => {
        const value = unwrapActionEnvelope(result);
        const inner = isRecord(value) && isRecord(value.result) ? unwrapActionEnvelope(value.result) : value;
        return isRecord(inner) && inner.applied === false ? 1 : 0;
      },
    };
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
   Formatters (registered in cli.ts's output switch).
   ────────────────────────────────────────────────────────────────────────── */

function recordOf(value: unknown): JsonObject {
  const unwrapped = unwrapActionEnvelope(value);
  return isRecord(unwrapped) ? unwrapped : {};
}

/** `status-bar`: whether the override is on now. */
export function formatAndroidStatusBar(value: unknown): string {
  const result = recordOf(value);
  if (result.overridden === true) return `android status-bar: overridden${asString(result.time) ? ` (${asString(result.time)})` : ""}`;
  return "android status-bar: the device's own";
}

/** `play-store-shots`: one line per PNG (raw, so an agent can Read the path back). */
export function formatAndroidStoreShots(value: unknown): string {
  const result = recordOf(value);
  const shots = Array.isArray(result.shots) ? result.shots.filter(isRecord) : [];
  return [
    renderKeyValues("ADE Google Play screenshots", [
      ["device", result.foldable === true ? "foldable (cover shut, inner open)" : "one screen"],
      ["shots", String(shots.length)],
    ]),
    ...shots.map((shot) => {
      const slot = asString(shot.slot) === "large-screen" ? "large screen (7\"/10\" tablet slot)" : "phone";
      const screen = typeof shot.screenWidth === "number" ? ` from ${shot.screenWidth}x${shot.screenHeight}` : "";
      const filed = asString(shot.proofArtifactId) ? " (filed as proof)" : "";
      return `shot: ${asString(shot.display) ?? "screen"} · ${slot} · ${String(shot.width)}x${String(shot.height)}${screen}: ${asString(shot.filePath) ?? ""}${filed}`;
    }),
  ].join("\n");
}

/** `window`: the app windows after the action, and whether it landed. */
export function formatAndroidWindow(value: unknown): string {
  const result = recordOf(value);
  const windows = Array.isArray(result.windows) ? result.windows.filter(isRecord) : [];
  const screen = isRecord(result.screen) ? result.screen : null;
  const frame = (entry: JsonObject) => {
    const f = isRecord(entry.frame) ? entry.frame : {};
    return `${String(f.width)}x${String(f.height)} at ${String(f.x)},${String(f.y)}`;
  };
  return [
    renderKeyValues(`ADE Android window ${asString(result.action) ?? "status"}`, [
      ["screen", screen ? `${String(screen.width)}x${String(screen.height)}` : null],
      ["app", result.packageName],
      ["applied", result.applied === false ? `no: ${asString(result.reason) ?? "the window did not move"}` : "yes"],
    ]),
    renderTable(
      ["task", "app", "mode", "frame", "visible"],
      windows.map((entry) => [entry.taskId, entry.packageName, entry.mode, frame(entry), entry.visible === true ? "yes" : "no"]),
      "No app windows.",
    ),
  ].join("\n");
}

/** The settings lines this track adds to `formatAndroidSettings`. */
export function androidDeviceSettingsLines(settings: JsonObject): Array<[string, unknown]> {
  const accessibility = isRecord(settings.accessibility) ? settings.accessibility : null;
  const location = isRecord(settings.location) ? settings.location : null;
  const lines: Array<[string, unknown]> = [];
  if (accessibility) {
    for (const option of ANDROID_ACCESSIBILITY_OPTIONS) {
      const state = accessibility[option];
      lines.push([ANDROID_ACCESSIBILITY_LABELS[option].toLowerCase(), state === true ? "on" : state === false ? "off" : state === null ? "not on this image" : null]);
    }
  }
  if (settings.statusBarOverridden !== undefined) {
    lines.push(["status bar", settings.statusBarOverridden === true ? "overridden (demo mode)" : settings.statusBarOverridden === false ? "the device's own" : null]);
  }
  if (settings.location !== undefined) {
    lines.push(["location", location ? `${String(location.latitude)}, ${String(location.longitude)} (set by ADE)` : "not set by ADE on this boot"]);
  }
  if (settings.orientation !== undefined) lines.push(["orientation", settings.orientation]);
  return lines;
}
