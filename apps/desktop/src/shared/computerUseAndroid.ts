/**
 * The `ade android` part of `computerUseActionSummary.ts`: the verbs only an
 * emulator has, and the app, device and target its rows name. The summary
 * calls `resolveAndroidVerb` and `androidSummaryParts`, and nothing else
 * here. The iOS app ports it in `WorkComputerUseSummary.swift`; keep them in step.
 *
 * Pure and platform-neutral, as the summary. Only types come from the
 * summary, so the two files do not import each other at run time.
 */

import { ANDROID_SETTINGS_FLAGS } from "./types/androidEmulatorDrawer";
import {
  appNameFromBundleId,
  flagValue,
  NUMBER,
  readAndroidDevice,
  readAndroidElementName,
  readAndroidFillUnseen,
  readString,
  type ParsedOutput,
} from "./computerUseActionOutput";
import type { ParsedInvocation, TargetShape, VerbSpec } from "./computerUseActionSummary";

const passiveSpec = (past: string, progressive: string, infinitive: string, target: VerbSpec["target"] = "none"): VerbSpec => (
  { past, progressive, infinitive, target, passive: true }
);

/**
 * `ade android` verbs that read as an action row, by the word typed. Each
 * `ade apple` twin keeps its `VERBS` entry; these are the words only Android
 * has, or that read another way on an emulator. A verb missing here and
 * from `VERBS` (`status`, `apps`, `devices`, `lease`, `sdk`, `show`, the
 * recording list) keeps its plain shell row.
 */
const ANDROID_VERBS: Readonly<Record<string, VerbSpec>> = {
  // The lifecycle verbs name the emulator, which later rows in the run borrow.
  start: passiveSpec("Started", "Starting", "start"),
  stop: passiveSpec("Stopped", "Stopping", "stop"),
  "device-create": passiveSpec("Created", "Creating", "create"),
  "device-attach": passiveSpec("Attached", "Attaching", "attach"),
  "device-detach": passiveSpec("Released", "Releasing", "release"),
  "find-element": passiveSpec("Found", "Finding", "find", "element"),
  drag: { past: "Dragged", progressive: "Dragging", infinitive: "drag", target: "none" },
  rotate: { past: "Rotated to", progressive: "Rotating to", infinitive: "rotate to", target: "none" },
  install: { past: "Installed", progressive: "Installing", infinitive: "install", target: "app" },
  uninstall: { past: "Uninstalled", progressive: "Uninstalling", infinitive: "uninstall", target: "app" },
  "app-state": passiveSpec("Checked", "Checking", "check", "app"),
  location: { past: "Set the location to", progressive: "Setting the location to", infinitive: "set the location to", target: "none" },
  appearance: { past: "Switched to", progressive: "Switching to", infinitive: "switch to", target: "none" },
  fold: { past: "Set the hinge to", progressive: "Setting the hinge to", infinitive: "set the hinge to", target: "none" },
  posture: passiveSpec("Read the hinge of", "Reading the hinge of", "read the hinge of"),
  settings: { past: "Set", progressive: "Setting", infinitive: "set", target: "none" },
  permission: { past: "Granted", progressive: "Granting", infinitive: "grant", target: "none" },
  "proof-bundle": { past: "Filed a proof bundle", progressive: "Filing a proof bundle", infinitive: "file a proof bundle", target: "caption" },
  preview: { past: "Rendered Compose previews", progressive: "Rendering Compose previews", infinitive: "render Compose previews", target: "none" },
  test: { past: "Ran tests", progressive: "Running tests", infinitive: "run tests", target: "none" },
  render: passiveSpec("Rendered", "Rendering", "render"),
  log: passiveSpec("Read the log of", "Reading the log of", "read the log of"),
  inspect: passiveSpec("Inspected", "Inspecting", "inspect", "element"),
  frame: passiveSpec("Took a frame of", "Taking a frame of", "take a frame of", "page"),
  foreground: { past: "Switched to", progressive: "Switching to", infinitive: "switch to", target: "app" },
  select: passiveSpec("Picked", "Picking", "pick", "element"),
};

/**
 * Verbs shared with the other surfaces, by the word typed, to the `VERBS`
 * entry they read as. Every other word not in `ANDROID_VERBS` keeps its
 * shell row.
 */
const ANDROID_SHARED_VERBS = new Set([
  "tap", "tap-element", "long-press", "swipe", "scroll", "type", "key", "button", "launch", "relaunch",
  "terminate", "open-url", "snapshot", "screenshot", "wait-for-element", "assert-visible",
  "record-start", "record-stop",
]);

/** The verb of an `ade android` command; `verbs` is the summary's shared table. */
export function resolveAndroidVerb(
  first: string,
  invocation: ParsedInvocation,
  verbs: Readonly<Record<string, VerbSpec>>,
): { key: string; spec: VerbSpec } | null {
  // `preview list` and `settings` with no setting are reads.
  if (first === "preview" && invocation.positionals[0] === "list") {
    return { key: "preview list", spec: passiveSpec("Listed Compose previews", "Listing Compose previews", "list Compose previews") };
  }
  if (first === "settings" && !androidSettingChange(invocation)) {
    return { key: "settings", spec: passiveSpec("Read the settings of", "Reading the settings of", "read the settings of") };
  }
  if (first === "permission" && invocation.positionals[0]?.toLowerCase() === "revoke") {
    return { key: "permission", spec: { past: "Revoked", progressive: "Revoking", infinitive: "revoke", target: "none" } };
  }
  if (first === "auto-record") {
    const word = invocation.positionals[0]?.toLowerCase() ?? "status";
    if (word !== "on" && word !== "off") return { key: first, spec: passiveSpec("Checked auto-record", "Checking auto-record", "check auto-record") };
    return { key: first, spec: { past: `Turned ${word} auto-record`, progressive: `Turning ${word} auto-record`, infinitive: `turn ${word} auto-record`, target: "none" } };
  }
  // `fill-element` is a fill: one canonical verb for the icon and the words.
  if (first === "fill-element") {
    const fill = verbs.fill;
    return fill ? { key: "fill", spec: fill } : null;
  }
  const own = ANDROID_VERBS[first];
  if (own) return { key: first, spec: own };
  if (!ANDROID_SHARED_VERBS.has(first)) return null;
  const spec = verbs[first];
  return spec ? { key: first, spec } : null;
}

/** The setting `ade android settings` changed, as words: "text size to large". Null for a read. */
function androidSettingChange(invocation: ParsedInvocation): string | null {
  // In the CLI's order, not the typed order: the iOS port reads an unordered map.
  for (const flag of ANDROID_SETTINGS_FLAGS) {
    const value = invocation.flags.get(flag);
    if (typeof value === "string" && value.trim()) return `${flag.slice(2).replace(/-/g, " ")} to ${value.trim()}`;
  }
  return null;
}

/** `ade android key`'s modifier flags, in the CLI's order, and the name each reads as. */
const ANDROID_KEY_MODIFIER_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["--shift", "Shift"], ["--ctrl", "Ctrl"], ["--control", "Ctrl"], ["--alt", "Alt"],
  ["--option", "Alt"], ["--meta", "Meta"], ["--cmd", "Meta"], ["--command", "Meta"],
];

/** Package names whose last word is not the app's name. */
const ANDROID_KNOWN_APPS: Readonly<Record<string, string>> = {
  "com.android.chrome": "Chrome",
  "com.android.vending": "Play Store",
  "com.google.android.gm": "Gmail",
  "com.google.android.youtube": "YouTube",
  "com.google.android.dialer": "Phone",
  "com.google.android.apps.messaging": "Messages",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.apps.nexuslauncher": "Home",
};

function appNameFromPackage(packageName: string | null): string | null {
  if (!packageName) return null;
  return ANDROID_KNOWN_APPS[packageName.toLowerCase()] ?? appNameFromBundleId(packageName);
}

/** A stroke's way, as the finger moves: from y 1500 to y 500 is "up". */
function strokeDirection(positionals: readonly string[]): string | null {
  const [x1, y1, x2, y2] = positionals.slice(0, 4).map(Number);
  if ([x1, y1, x2, y2].some((value) => value === undefined || !Number.isFinite(value))) return null;
  const dx = x2! - x1!;
  const dy = y2! - y1!;
  if (dx === 0 && dy === 0) return null;
  return Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "up" : "down") : (dx < 0 ? "left" : "right");
}

/** "412, 300" at a screen point, when both are numbers; null otherwise. */
function pointTarget(x: string | null, y: string | null): TargetShape | null {
  if (!x || !y || !NUMBER.test(x) || !NUMBER.test(y)) return null;
  return { target: `${Math.round(Number(x))}, ${Math.round(Number(y))}`, quoted: false, direction: null, point: true };
}

/**
 * The target of an `ade android` verb whose words differ from the shared
 * reading (`--package` for the app, `--name` for a button, a stroke's way).
 * Undefined hands the verb to `describeTarget`.
 */
function androidTarget(verbKey: string, invocation: ParsedInvocation, parsed: ParsedOutput, output: string): TargetShape | undefined {
  const shape = (target: string | null, quoted = false, direction: string | null = null): TargetShape => (
    { target, quoted, direction, point: false }
  );
  const [first, second] = invocation.positionals;
  switch (verbKey) {
    case "tap-element":
    case "fill":
    case "find-element":
    case "wait-for-element":
    case "assert-visible": {
      const named = parsed.hitName ?? readAndroidElementName(output)
        ?? flagValue(invocation, "--label", "--text", "--identifier");
      if (named) return shape(named, true);
      // `fill-element --ref e3 "hello"`: no name, so the text typed.
      if (verbKey === "fill") return shape(flagValue(invocation, "--value") ?? first ?? null, true);
      return undefined;
    }
    case "long-press":
      return pointTarget(flagValue(invocation, "--x") ?? first ?? null, flagValue(invocation, "--y") ?? second ?? null) ?? shape(null);
    case "swipe":
      return shape(null, false, strokeDirection(invocation.positionals));
    case "button":
      return shape(first ?? flagValue(invocation, "--name", "--key"), true);
    case "key": {
      // `key --shift a`: the parser cannot know a modifier takes no value, so
      // the key may sit in the last modifier's slot.
      const modifiers = ANDROID_KEY_MODIFIER_WORDS.filter(([flag]) => invocation.flags.has(flag));
      const stuck = modifiers.map(([flag]) => invocation.flags.get(flag)).find((value): value is string => typeof value === "string");
      const key = first ?? flagValue(invocation, "--name", "--key") ?? stuck ?? null;
      const names = [...new Set(modifiers.map(([, name]) => name))];
      return shape(key ? [...names, key].join("+") : null, true);
    }
    case "inspect":
    case "select": {
      if (parsed.hitName) return shape(parsed.hitName, true);
      return pointTarget(flagValue(invocation, "--x"), flagValue(invocation, "--y")) ?? shape(flagValue(invocation, "--ref"));
    }
    case "rotate":
    case "appearance":
      return shape(first ? `${first.toLowerCase()}${verbKey === "appearance" ? " mode" : ""}` : null);
    case "launch":
    case "relaunch":
    case "terminate":
    case "uninstall":
    case "app-state":
    case "foreground": {
      const packageName = flagValue(invocation, "--package") ?? first ?? readString(parsed.json?.packageName);
      return shape(appNameFromPackage(packageName) ?? (verbKey === "launch" ? "the app" : null));
    }
    case "install": {
      const apk = flagValue(invocation, "--apk");
      const installed = appNameFromPackage(readString(parsed.json?.packageName));
      return shape(installed ?? (apk ? apk.split(/[\\/]/).pop() ?? apk : "the app"));
    }
    case "location": {
      const latitude = flagValue(invocation, "--latitude") ?? first ?? null;
      const longitude = flagValue(invocation, "--longitude") ?? second ?? null;
      return shape(latitude && longitude ? `${latitude}, ${longitude}` : null);
    }
    case "fold": {
      const word = flagValue(invocation, "--angle") ?? first ?? null;
      return shape(word ? (NUMBER.test(word) ? `${word}°` : word.toLowerCase() === "half" ? "half open" : word.toLowerCase()) : null);
    }
    case "settings":
      return shape(androidSettingChange(invocation));
    case "permission": {
      const permission = second ? `${second} permission` : null;
      return shape(permission);
    }
    case "record-start":
    case "record-stop":
    case "proof-bundle":
      return shape(flagValue(invocation, "--label", "--caption"), true);
    case "preview":
      return shape(flagValue(invocation, "--fqn")?.split(".").pop() ?? null, true);
    case "test": {
      const className = flagValue(invocation, "--class")?.split(".").pop() ?? null;
      const method = flagValue(invocation, "--method");
      return shape(className ? (method ? `${className}.${method}` : className) : null, true);
    }
    default:
      return undefined;
  }
}

/** `ade android` verbs whose object is the emulator itself. */
const ANDROID_LIFECYCLE_VERBS = new Set(["start", "stop", "device-create", "device-attach", "device-detach"]);

/** What an `ade android` row reads that the shared summary does not. */
export type AndroidSummaryParts = {
  /** `fill-element`: the field does not show the text afterwards. */
  fillUnseen: boolean;
  /** The reason an unconfirmed row gives when the output gives none. */
  unconfirmedReason: string | null;
  appName: string | null;
  device: { name: string | null; os: string | null } | null;
  /** The target; undefined hands the verb to the shared reading. */
  shape: TargetShape | undefined;
};

export function androidSummaryParts(verbKey: string, invocation: ParsedInvocation, parsed: ParsedOutput, output: string): AndroidSummaryParts {
  const json = parsed.json;
  const device = readAndroidDevice(parsed);
  const fill = verbKey === "fill";
  return {
    fillUnseen: fill && readAndroidFillUnseen(parsed, output),
    unconfirmedReason: fill ? "The field does not show the text." : null,
    appName: parsed.values.get("app name")
      ?? readString(json?.appName)
      ?? appNameFromPackage(flagValue(invocation, "--package") ?? readString(json?.packageName)),
    device,
    // The lifecycle verbs name the device, which later rows in the run borrow.
    shape: ANDROID_LIFECYCLE_VERBS.has(verbKey)
      ? { target: device?.name ?? "the emulator", quoted: false, direction: null, point: false }
      : androidTarget(verbKey, invocation, parsed, output),
  };
}
