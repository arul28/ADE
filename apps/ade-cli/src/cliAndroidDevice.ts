/**
 * `ade android`: the device-state verbs at `ade apple`'s level
 * (`accessibility`, `status-bar`, `location --clear`, `play-store-shots`,
 * `window`). Their text formatters are in cliAndroidFormat.ts. cliAndroid.ts
 * keeps the flag tables and the verb spellings, and calls
 * `buildAndroidDevicePlan` before the suite.
 *
 * It imports `./cli` back, under cli.ts's cycle rule:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import {
  ANDROID_ACCESSIBILITY_OPTIONS,
  ANDROID_STATUS_BAR_BATTERY_STATES,
  ANDROID_STATUS_BAR_NETWORKS,
  ANDROID_WINDOW_LAYOUT_ACTIONS,
} from "../../desktop/src/shared/types/androidEmulator";
import {
  CliUsageError,
  isRecord,
  readFlag,
  readNumberOption,
  readValue,
  unwrapActionEnvelope,
  type CliPlan,
  type FormatterId,
  type JsonObject,
} from "./cli";
import { withAsked } from "./cliAndroidFormat";

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

/** The device verbs; null for any other verb (and for `location` without `--clear`). */
export function buildAndroidDevicePlan(
  sub: string,
  args: string[],
  ctx: {
    positionals: () => string[];
    laneClaim: () => JsonObject;
    chatSessionId: string | null;
    androidAction: AndroidActionBuilder;
  },
): CliPlan | null {
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
      const setters = ["--time", "--data-network", "--wifi-bars", "--cellular-bars", "--battery-level", "--battery-state"];
      if (args.some((arg) => setters.includes(arg.split("=")[0]!))) throw usage("--clear takes no other flags; set the bar or clear it, not both.");
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
    if (batteryState && !(ANDROID_STATUS_BAR_BATTERY_STATES as readonly string[]).includes(batteryState)) {
      throw usage(`--battery-state takes ${ANDROID_STATUS_BAR_BATTERY_STATES.join(", ")}.`);
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
    if (positionals().length > 0) throw usage("--clear takes no coordinates; set a point or clear it, not both.");
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
