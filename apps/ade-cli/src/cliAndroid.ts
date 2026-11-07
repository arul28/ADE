/**
 * `ade android`: the plan builder and the error hints for the lane's
 * Android emulator. The P1, P3 and `sdk` verbs are in `cliAndroidSuite.ts`;
 * the text formatters are in `cliAndroidFormat.ts`.
 *
 * cli.ts keeps the dispatch case, the help page and the output switch. The
 * argv primitives live there, so this module imports them back. That import
 * cycle is safe under the same rule as cliMacDesktop.ts:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 *
 * Every value use of those imports happens inside a function body. The hint
 * table, the flag lists and the button names are built at module scope from
 * the shared contract only.
 */
import path from "node:path";
import { ANDROID_CATALOG_IDS } from "../../desktop/src/shared/androidDeviceCatalog";
import {
  ANDROID_EMULATOR_DOMAIN,
  ANDROID_HARDWARE_KEYS,
  ANDROID_KEY_MODIFIERS,
  ANDROID_NAMED_KEYCODES,
  ANDROID_ORIENTATIONS,
  ANDROID_RENDER_ANGLE_IDS,
  ANDROID_RENDER_BACKGROUNDS,
  ANDROID_SDK_PERSON_ONLY_ACTIONS,
  ANDROID_SETTINGS_FLAGS,
  androidKeyCode,
  splitAndroidKeyCombo,
  type AndroidErrorCode,
  type AndroidHardwareKey,
} from "../../desktop/src/shared/types/androidEmulator";
import { localRuntimeActionTimeoutMs } from "../../desktop/src/main/services/localRuntime/localRuntimeTimeoutPolicy";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  firstStandalonePositional,
  listActionsStep,
  proofCallerRootArgs,
  readFlag,
  readNumberOption,
  readToolClaimArgs,
  readValue,
  requireTypedText,
  requireValue,
  standalonePositionals,
  workToolShowPlan,
  type CliPlan,
  type FormatterId,
  type JsonObject,
  type ValueCarrierFlags,
} from "./cli";
import { withAsked } from "./cliAndroidFormat";
import { buildAndroidSuitePlan } from "./cliAndroidSuite";
import { buildAndroidDevicePlan } from "./cliAndroidDevice";

/* ──────────────────────────────────────────────────────────────────────────
   ANDROID EMULATOR — `ade android`.

   One emulator per lane, on the machine that runs the lane's brain. One
   spelling per verb and flag: `ade apple`'s where the job is the same
   (`status`, `devices`, `device-create`, `device-attach`, `device-detach`,
   `start`, `stop`, `screenshot`, `tap`, `swipe`, `button`, `type`, `show`),
   and unknown flags are refused.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * `ade android`'s own value-carrying flags. Only flags read with
 * `readValue`/`readNumberOption` belong here; a boolean (`--keep`,
 * `--no-start`, `--profiles`) must stay out, or the next positional is
 * swallowed as its value.
 */
export const ANDROID_VALUE_FLAGS: readonly string[] = [
  "--accept-license",
  "--activity",
  "--airplane",
  "--amount",
  "--anchor-x",
  "--anchor-y",
  "--angle",
  "--angles",
  "--apk",
  "--animations",
  "--avd",
  "--background",
  "--battery",
  "--caption",
  "--catalog",
  "--charging",
  // `test --class <fqcn>`.
  "--class",
  "--color",
  "--data",
  "--direction",
  "--display-size",
  "--duration-ms",
  // Parity: `launch`/`relaunch --extra key=value` (typed) and `--extra-string key=value`, repeatable.
  "--extra",
  "--extra-string",
  "--folder",
  // `preview --fqn <name>`, repeatable.
  "--fqn",
  "--hold-ms",
  "--holder",
  "--id",
  "--identifier",
  "--image",
  "--index",
  "--label",
  "--lane",
  "--latitude",
  // Parity: `launch --launch-arg <am word>`, repeatable (`ade apple`'s spelling).
  "--launch-arg",
  "--layout-bounds",
  "--level",
  "--lighting",
  "--lines",
  "--longitude",
  "--max-seconds",
  "--method",
  "--module",
  "--name",
  "--out",
  "--package",
  "--profile",
  "--ref",
  "--role",
  "--show-taps",
  "--since",
  // `--text <value>` (an element's text). A bare `--text` is the output mode,
  // and the global parser keeps it out of the command's args.
  "--text",
  "--text-size",
  "--timeout-ms",
  "--token",
  "--ttl",
  "--url",
  "--value",
  "--variant",
  // `lease --wait <seconds>`. `sdk install --wait` is a switch: `sdk` reads
  // its args without it (ANDROID_SDK_VALUE_CARRIER_FLAGS).
  "--wait",
  "--wifi",
  "--x",
  "--y",
];

/**
 * Parity (device track): the value flags of `accessibility`, `status-bar` and
 * `window` (cliAndroidDevice.ts). Literals: see that file's cycle note.
 */
const ANDROID_DEVICE_VALUE_FLAGS: readonly string[] = [
  "--option", "--time", "--data-network", "--wifi-bars", "--cellular-bars", "--battery-level", "--battery-state",
  "--with", "--size", "--move",
];

/** `ade android key`'s modifier switches. They never take a value, though `accessibility --option <name>` does. */
const ANDROID_KEY_MODIFIER_FLAGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["shift", ["--shift"]],
  ["ctrl", ["--ctrl", "--control"]],
  ["alt", ["--alt", "--option"]],
  ["meta", ["--meta", "--cmd", "--command"]],
];

const ANDROID_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set([...ANDROID_VALUE_FLAGS, ...ANDROID_DEVICE_VALUE_FLAGS]);
const ANDROID_SDK_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set([...ANDROID_VALUE_FLAGS, ...ANDROID_DEVICE_VALUE_FLAGS].filter((flag) => flag !== "--wait"));
const ANDROID_KEY_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set(
  [...ANDROID_VALUE_CARRIER_FLAGS].filter((flag) => !ANDROID_KEY_MODIFIER_FLAGS.some(([, names]) => names.includes(flag))),
);
/** The verbs whose value flags differ from the rest. */
const ANDROID_VERB_VALUE_CARRIER_FLAGS = new Map<string, ValueCarrierFlags>([
  ["sdk", ANDROID_SDK_VALUE_CARRIER_FLAGS],
  ["key", ANDROID_KEY_VALUE_CARRIER_FLAGS],
]);

/** The element query flags, `ade apple`'s (`--text` is the element's text). */
const ANDROID_QUERY_FLAGS = ["--ref", "--identifier", "--label", "--text", "--role", "--index"] as const;
const ANDROID_INSTALL_FLAGS = ["--apk", "--gradle", "--module", "--variant"] as const;
/** Launch arguments and intent extras, on `launch` and `relaunch`; `-- <words>` too. */
const ANDROID_LAUNCH_EXTRA_FLAGS = ["--extra", "--extra-string", "--launch-arg"] as const;

/**
 * Each verb and the only flags it takes (besides `--lane`). One spelling per
 * job, `ade apple`'s where the job is the same. Anything else is refused,
 * never dropped: a dropped `--duration-ms` would swipe at the default speed
 * and still say done.
 */
const ANDROID_VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  help: [],
  actions: [],
  status: [],
  show: ["--floating", "--float"],
  devices: ["--profiles"],
  "device-create": ["--profile", "--catalog", "--color", "--image", "--name", "--no-start"],
  "device-attach": ["--avd", "--no-start"],
  start: ["--force"],
  stop: [],
  "device-detach": ["--keep"],
  screenshot: ["--out", "--caption", "--no-proof"],
  tap: ["--x", "--y"],
  swipe: ["--duration-ms"],
  button: ["--name"],
  rotate: [],
  type: ["--value", "--submit"],
  // Parity: one key with modifiers held (`key a --ctrl`, or `key ctrl+a`).
  key: ANDROID_KEY_MODIFIER_FLAGS.flatMap(([, names]) => names),
  // `ade apple render`'s spellings, so one render verb reads the same on both.
  render: ["--angles", "--angle", "--lighting", "--background", "--no-shadow", "--video", "--turntable", "--sheet", "--contact-sheet"],
  // P1 agent suite.
  apps: [],
  install: [...ANDROID_INSTALL_FLAGS],
  launch: ["--package", "--activity", ...ANDROID_INSTALL_FLAGS, ...ANDROID_LAUNCH_EXTRA_FLAGS],
  relaunch: ["--package", "--activity", ...ANDROID_LAUNCH_EXTRA_FLAGS],
  "app-state": ["--package"],
  foreground: ["--package", "--wait"],
  frame: ["--out"],
  inspect: ["--x", "--y", "--ref", "--screenshot"],
  select: ["--x", "--y", "--ref"],
  "device-cleanup": ["--power-off-idle", "--dry-run"],
  terminate: ["--package"],
  uninstall: ["--package"],
  "open-url": ["--url"],
  "long-press": ["--x", "--y", "--duration-ms"],
  drag: ["--duration-ms"],
  scroll: ["--direction", "--amount", "--anchor-x", "--anchor-y"],
  snapshot: ["--fresh"],
  "find-element": [...ANDROID_QUERY_FLAGS],
  "tap-element": [...ANDROID_QUERY_FLAGS, "--hold-ms"],
  "fill-element": [...ANDROID_QUERY_FLAGS, "--value", "--no-focus"],
  "wait-for-element": [...ANDROID_QUERY_FLAGS, "--timeout-ms", "--gone"],
  "assert-visible": [...ANDROID_QUERY_FLAGS],
  log: ["--package", "--level", "--since", "--lines"],
  // `ade apple`'s recording flags: `--plain` (or `--keep-idle`) files it as recorded, `--zoom` zooms on each tap.
  "record-start": ["--label", "--max-seconds", "--plain", "--keep-idle", "--zoom"],
  "record-stop": ["--discard", "--keep"],
  // `ade android auto-record on|off|status`: whether an agent's input on this lane starts a recording.
  "auto-record": [],
  "record-list": [],
  "record-delete": ["--id"],
  lease: ["--wait", "--ttl", "--holder", "--token"],
  location: ["--latitude", "--longitude", "--clear", "--reset"],
  // Parity (device track, cliAndroidDevice.ts). Other spellings: ANDROID_VERB_ALIASES.
  accessibility: ["--on", "--off", "--option"],
  "status-bar": ["--clear", "--reset", "--time", "--data-network", "--wifi-bars", "--cellular-bars", "--battery-level", "--battery-state"],
  "play-store-shots": ["--no-proof"],
  window: [
    "--package", "--with", "--size", "--move", "--split", "--left", "--right", "--top", "--bottom", "--swap",
    "--freeform", "--free", "--fill", "--full", "--full-screen", "--close",
  ],
  appearance: [],
  // P3 fold.
  fold: ["--angle"],
  posture: [],
  settings: [...ANDROID_SETTINGS_FLAGS],
  permission: ["--package"],
  "proof-bundle": ["--out", "--caption", "--package", "--no-elements"],
  // P3 Compose previews: `preview list` and `preview` (render).
  preview: ["--module", "--fqn", "--all", "--no-proof"],
  // P3 instrumentation tests: the install's Gradle flags, then one class or one method.
  test: ["--module", "--variant", "--class", "--method"],
  // P1 setup: each `sdk` verb's own flags are checked again below.
  sdk: ["--folder", "--with-cli", "--accept-license", "--wait", "--id", "--clear", "--image", "--installed"],
};

/** Other spellings of a verb (Apple's is `app-store-shots`), read before the flag lookup. */
const ANDROID_VERB_ALIASES: Readonly<Record<string, string>> = {
  a11y: "accessibility",
  "store-shots": "play-store-shots",
  "app-store-shots": "play-store-shots",
  windows: "window",
};

/**
 * The input verbs that take `--no-record` (`ade apple`'s): this call does not
 * start an automatic recording. A recording that runs still shows it.
 */
const ANDROID_NO_RECORD_VERBS: ReadonlySet<string> = new Set([
  "tap", "swipe", "button", "type", "key", "open-url", "long-press", "drag", "scroll", "tap-element", "fill-element",
  "select",
]);

/** `ade apple`'s button names (hyphens), each to the service's key. */
const ANDROID_BUTTONS: ReadonlyMap<string, AndroidHardwareKey> = new Map(
  ANDROID_HARDWARE_KEYS.map((key) => [key.replace(/_/gu, "-"), key] as const),
);

/** The `--flag` names in `args`, skipping each value flag's value and everything after `--`. */
export function androidFlagNames(args: readonly string[], carriers: ValueCarrierFlags = ANDROID_VALUE_CARRIER_FLAGS): string[] {
  const names: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.split("=")[0]!;
    names.push(name);
    if (!token.includes("=") && carriers.has(name)) index += 1;
  }
  return names;
}

/** The next step for each coded refusal. Keyed on the contract's codes, so a new code needs a line. */
const ANDROID_ERROR_HINTS: Record<AndroidErrorCode, string> = {
  ANDROID_SDK_NOT_FOUND:
    "hint: install the Android SDK (Android Studio, or the command-line tools) or set ANDROID_HOME, then run `ade android status --text`.",
  ANDROID_TOOL_MISSING:
    "hint: install the missing SDK package (platform-tools, emulator, cmdline-tools) with sdkmanager, then run `ade android status --text`.",
  ANDROID_NO_ACCELERATION:
    "hint: turn on hardware acceleration (Windows: Windows Hypervisor Platform; Linux: KVM access), then try again. `ade android status --text` shows what the check found.",
  ANDROID_NO_SYSTEM_IMAGE:
    "hint: install a system image for this machine's ABI with sdkmanager, or pass --image <package>. `ade android devices --text` lists the installed ones.",
  ANDROID_AVD_NOT_FOUND: "hint: `ade android devices --text` lists this machine's AVDs.",
  ANDROID_AVD_HELD_BY_OTHER_LANE:
    "hint: another lane holds that AVD. Pick a free one (`ade android devices --text`), or make one: `ade android device-create --profile <id>`.",
  ANDROID_LANE_HAS_DEVICE:
    "hint: this lane already holds an AVD. Use it (`ade android start`), or `ade android device-detach` before you create or attach another.",
  ANDROID_AVD_RUNNING:
    "hint: that AVD already runs outside this lane. Close that emulator first, or attach another AVD.",
  ANDROID_NO_FREE_PORT:
    "hint: every emulator port (5554-5682) is in use. Stop an emulator you do not need, then try again.",
  ANDROID_BOOT_TIMEOUT:
    "hint: the emulator did not finish booting in time. Read the log it names, then run `ade android start` again.",
  ANDROID_EMULATOR_EXITED:
    "hint: the emulator quit. Read the log it names (`ade android status --text` shows the path).",
  ANDROID_STREAM_FAILED:
    "hint: the live view failed. `tap`, `button`, `type` and `screenshot` do not need it.",
  ANDROID_PATH_OUTSIDE_LANE:
    "hint: --out must be inside the lane worktree. Pass a path there, or leave out --out for a file under ADE's data folder.",
  ANDROID_NOT_RUNNING:
    "hint: boot the lane's emulator first: `ade android start`, or `ade android device-create --profile <id>` when the lane has none.",
  // P1 setup.
  // Only the user installs, in the desktop app; the CLI reads the plan and the progress.
  ANDROID_SDK_LICENSE_NOT_ACCEPTED:
    "hint: The user accepts each licence in the ADE desktop app's setup card. `ade android sdk licenses` shows their text.",
  ANDROID_SDK_NO_SPACE: "hint: Free space, or pick a folder on another drive in the setup card.",
  ANDROID_SDK_INSTALL_BUSY: "hint: Wait for it: `ade android sdk status --text` shows its progress. The setup card can stop it.",
  ANDROID_SDK_INSTALL_FAILED:
    "hint: Run `ade android sdk status` to see what is missing. The user installs again from the setup card; finished parts stay.",
  ANDROID_SDK_PATH_INVALID: "hint: Pick the folder that holds platform-tools, emulator or system-images.",
  ANDROID_LOW_MEMORY:
    "hint: close apps or stop an emulator you do not need, then try again. Ask the user before you run `ade android start --force`: it boots anyway, and the machine can swap.",
  // P1 agent suite.
  ANDROID_ELEMENT_NOT_FOUND:
    "hint: run `ade android snapshot --text` to see the screen's elements, then aim with --ref, --identifier, --label or --text.",
  ANDROID_WAIT_TIMEOUT:
    "hint: run `ade android snapshot --text` to see what is on screen; pass --timeout-ms <ms> (up to 120000) to wait longer.",
  ANDROID_UI_TREE_FAILED:
    "hint: the screen's element tree could not be read. Try again; `ade android screenshot --text` still shows the screen.",
  ANDROID_APP_NOT_FOUND: "hint: `ade android apps --text` lists the apps on the emulator.",
  ANDROID_BUILD_FAILED:
    "hint: read the build output above, fix the build, then run the command again. --module and --variant pick another module or build type.",
  ANDROID_INSTALL_FAILED: "hint: read adb's reason above. A signature conflict needs `ade android uninstall --package <name>` first.",
  ANDROID_PACKAGE_NOT_ADE_INSTALLED:
    "hint: this lane uses an AVD it did not make, and ADE did not install this app, so ADE leaves it. Uninstall it in the emulator yourself.",
  ANDROID_RECORDING_ACTIVE: "hint: stop it first: `ade android record-stop --text`.",
  ANDROID_RECORDING_NOT_FOUND: "hint: `ade android record-list --text` lists this lane's recordings.",
  // P3.
  ANDROID_SYSTEM_IMAGE_IN_USE:
    "hint: an AVD uses that system image. Stop the emulator first; `ade android sdk images --text` shows which AVDs use each image.",
  ANDROID_TESTS_RUNNING: "hint: this lane's instrumentation tests already run. Wait for that run to finish, then try again.",
};

/** An Agent 37 box has no KVM: the agent moves the chat to a VM, within the owner's agent limits. */
const AGENT37_BOX_ANDROID_HINT =
  "hint: tell the user the message above in plain words. To move: `ade agent37 create --kind vm --shape <the size the message names> --name <name>` "
  + "(ADE asks the user or refuses when the agent limits say so), then "
  + "`ade chat handoff \"$ADE_CHAT_SESSION_ID\" --machine <name> --fork --include-changes --clone --when-turn-ends --note \"<the task, then offer to delete the box>\"`. "
  + "The `ade-agent37` skill has the steps.";

const ANDROID_ERROR_HINT_ENTRIES = Object.entries(ANDROID_ERROR_HINTS) as Array<[AndroidErrorCode, string]>;

/**
 * The SDK setup verbs only the user may run, in the desktop app. The brain
 * refuses every other caller, a terminal too.
 */
const ANDROID_PERSON_ONLY_SDK = new RegExp(
  `android_emulator\\.(${ANDROID_SDK_PERSON_ONLY_ACTIONS.join("|")})\\b[^\\n]*(?:not permitted|limited to user clients|requires elevated role)`,
  "u",
);

/** The hint line for an `ANDROID_*: sentence` error, or null. */
export function androidEmulatorErrorHint(message: string): string | null {
  const personOnly = ANDROID_PERSON_ONLY_SDK.exec(message);
  if (personOnly) {
    if (personOnly[1] === "installSystemImage" || personOnly[1] === "removeSystemImage") {
      return "Only the user installs or removes Android system images, in the ADE desktop app: the device picker's System images. "
        + "Ask the user. `ade android sdk images --text` shows what is installed and what is available.";
    }
    if (personOnly[1] === "setMachinePreferences") {
      return "Only the user changes this machine's Android preferences (tap rings, key badges, auto-record, the storage warning, the remote bitrate), "
        + "in the ADE desktop app: Settings › Android devices. Ask the user. To stop auto-record in this lane: ade android auto-record off.";
    }
    return personOnly[1] === "setSdkPath"
      ? "Only the user picks this machine's Android SDK folder, in the ADE desktop app: Settings › Android devices. Ask the user."
      : "Only the user installs the Android SDK and accepts Google's licences, in the ADE desktop app: "
        + "the setup card in the Android tool, or Settings › Android devices. Ask the user.";
  }
  if (message.includes("ANDROID_NO_ACCELERATION:") && message.includes("Agent 37 box")) return AGENT37_BOX_ANDROID_HINT;
  return ANDROID_ERROR_HINT_ENTRIES.find(([code]) => message.includes(`${code}:`))?.[1] ?? null;
}

/**
 * `--out` as an absolute path when the folder is this shell's: a relative path
 * means "from where this shell stands", as for any other command. It is sent
 * as typed when this shell has no lane, or with `--machine`, so a brain on
 * another machine resolves it against that lane's worktree (or the chat's
 * work copy there) instead of a folder that exists only here.
 */
export function androidOutPath(value: string | null, remote: boolean): string | null {
  if (!value || path.isAbsolute(value) || remote) return value;
  return process.env.ADE_LANE_ID ? path.resolve(process.cwd(), value) : value;
}

export function finiteNumber(raw: string | undefined, label: string, verb: string): number {
  const value = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(value)) {
    throw new CliUsageError(`android ${verb}: ${label} must be a number.`);
  }
  return value;
}

/** One point in device pixels: `--x`/`--y`, or `<x> <y>`. */
export function readPoint(args: string[], rest: readonly string[], verb: string): { x: number; y: number } {
  const flagX = readNumberOption(args, ["--x"]);
  const flagY = readNumberOption(args, ["--y"]);
  return { x: flagX ?? finiteNumber(rest[0], "x", verb), y: flagY ?? finiteNumber(rest[1], "y", verb) };
}

/** A stroke in device pixels: `<x1> <y1> <x2> <y2>`. */
export function readStroke(rest: readonly string[], verb: string): { fromX: number; fromY: number; toX: number; toY: number } {
  if (rest.length < 4) throw new CliUsageError(`android ${verb} needs <x1> <y1> <x2> <y2> (device pixels).`);
  const [fromX, fromY, toX, toY] = (["x1", "y1", "x2", "y2"] as const).map((label, index) => finiteNumber(rest[index], label, verb));
  return { fromX: fromX!, fromY: fromY!, toX: toX!, toY: toY! };
}

/** A table's own entry: a typed word such as `constructor` must not read `Object.prototype`. */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function buildAndroidPlan(args: string[], options: { remote?: boolean } = {}): CliPlan {
  const typedSub = firstStandalonePositional(args, ANDROID_VALUE_CARRIER_FLAGS) ?? "status";
  const sub = ownEntry(ANDROID_VERB_ALIASES, typedSub) ?? typedSub;
  // `launch … -- <am words>`: everything after `--` is the launch's, as `ade apple launch -- <args>`.
  // Taken out first, so no flag reader sees a word meant for `am start`.
  const fence = sub === "launch" || sub === "relaunch" ? args.indexOf("--") : -1;
  // Trailing `--text`/`--json` are the output mode (`launch … -- -f 0x10 --text`); the same words
  // inside the fence are `am` words, such as an extra's value (`--es mode --json`).
  const launchPassthrough = fence >= 0 ? args.splice(fence).slice(1) : [];
  while (launchPassthrough.at(-1) === "--text" || launchPassthrough.at(-1) === "--json") launchPassthrough.pop();
  // `sdk install --wait` is a switch, `lease --wait <s>` takes seconds. In
  // `key`, `--option` is the alt switch, so `key --option tab` keeps its key.
  const carriers = ANDROID_VERB_VALUE_CARRIER_FLAGS.get(sub) ?? ANDROID_VALUE_CARRIER_FLAGS;
  const positionals = (): string[] => standalonePositionals(args, carriers);
  const verbFlags = ownEntry(ANDROID_VERB_FLAGS, sub);
  if (verbFlags) {
    const unknown = androidFlagNames(args, carriers).find((name) =>
      name !== "--lane" && !verbFlags.includes(name) && !(name === "--no-record" && ANDROID_NO_RECORD_VERBS.has(sub)));
    if (unknown) {
      throw new CliUsageError(`android ${sub} does not take ${unknown}. Run 'ade android --help'.`);
    }
  }
  const remote = options.remote === true;
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND["android"]! };
  if (sub === "actions")
    return { kind: "execute", label: "android actions", steps: [listActionsStep("actions", ANDROID_EMULATOR_DOMAIN)] };

  // The lane comes from --lane or ADE_LANE_ID. With neither, every call
  // carries `callerRoot`, and the brain binds a call made from inside a lane
  // worktree to that lane; a chat-bound agent is pinned to its chat's lane.
  const claimArgs = readToolClaimArgs(args);
  const laneClaim = (): JsonObject => (claimArgs.laneId ? { laneId: claimArgs.laneId } : {});
  const callerRootArgs = proofCallerRootArgs();
  const noRecord = ANDROID_NO_RECORD_VERBS.has(sub) && readFlag(args, ["--no-record"]);
  const androidAction = (
    label: string,
    method: string,
    payload: JsonObject,
    formatter: FormatterId,
    extra: { shapeResult?: (values: JsonObject) => unknown; progressNotice?: string } = {},
  ): CliPlan & { kind: "execute" } => {
    // Read before the step is built, so a timeout added to the shared table
    // reaches the CLI without a second edit.
    const minTimeoutMs = localRuntimeActionTimeoutMs(ANDROID_EMULATOR_DOMAIN, method);
    // `--no-record` on an input verb: this call starts no automatic recording.
    const recordPayload = noRecord ? { ...payload, noRecord: true } : payload;
    return {
      kind: "execute",
      label,
      formatter,
      steps: [actionStep("result", ANDROID_EMULATOR_DOMAIN, method, recordPayload, callerRootArgs)],
      ...(minTimeoutMs > 30_000 ? { minTimeoutMs: minTimeoutMs + 15_000 } : {}),
      ...extra,
    };
  };
  const bootNotice = "Booting the lane's Android emulator; the first boot of a new AVD can take about a minute…";

  if (sub === "status")
    return androidAction("android status", "getStatus", laneClaim(), "android-status");
  // Same verb as `ade ui show android`, spelled where an agent driving the
  // emulator looks for it. `--floating` asks for the floating player instead.
  if (sub === "show") {
    const floating = readFlag(args, ["--floating", "--float"]);
    return workToolShowPlan(claimArgs, floating ? "floating-android" : "android");
  }
  if (sub === "devices") {
    const showProfiles = readFlag(args, ["--profiles"]);
    return androidAction("android devices", "listDevices", laneClaim(), showProfiles ? "android-devices-profiles" : "android-devices");
  }
  if (sub === "device-create") {
    // A brand-grid device (`--catalog galaxy-s25 --color navy`) names its own
    // profile; otherwise `--profile` is required.
    const catalogId = readValue(args, ["--catalog"]);
    const colorId = readValue(args, ["--color"]);
    if (catalogId != null && !ANDROID_CATALOG_IDS.includes(catalogId)) {
      throw new CliUsageError(`android device-create: --catalog must be one of ${ANDROID_CATALOG_IDS.join(", ")}.`);
    }
    if (colorId != null && catalogId == null) throw new CliUsageError("android device-create: --color needs --catalog <id>.");
    const profileId = catalogId != null
      ? readValue(args, ["--profile"]) ?? ""
      : requireValue(readValue(args, ["--profile"]), "--profile <hardware profile id> (or --catalog <id>)");
    const systemImage = readValue(args, ["--image"]);
    const displayName = readValue(args, ["--name"]);
    const noStart = readFlag(args, ["--no-start"]);
    return androidAction("android device-create", "createDevice", {
      ...laneClaim(),
      profileId,
      ...(catalogId != null ? { catalogId } : {}),
      ...(colorId != null ? { colorId } : {}),
      ...(systemImage ? { systemImage } : {}),
      ...(displayName ? { displayName } : {}),
      ...(noStart ? { start: false } : {}),
    }, "android-device", noStart ? {} : { progressNotice: bootNotice });
  }
  if (sub === "device-attach") {
    const avdName = requireValue(readValue(args, ["--avd"]), "--avd <AVD name>");
    const noStart = readFlag(args, ["--no-start"]);
    return androidAction("android device-attach", "attachDevice", {
      ...laneClaim(),
      avdName,
      ...(noStart ? { start: false } : {}),
    }, "android-device", noStart ? {} : { progressNotice: bootNotice });
  }
  if (sub === "start") {
    // --force boots past the RAM guard (ANDROID_LOW_MEMORY).
    const force = readFlag(args, ["--force"]);
    return androidAction("android start", "start", { ...laneClaim(), ...(force ? { force: true } : {}) }, "android-device", { progressNotice: bootNotice });
  }
  if (sub === "stop")
    return androidAction("android stop", "stop", laneClaim(), "android-device");
  if (sub === "device-detach") {
    // An AVD ADE made for the lane is deleted on release; --keep keeps it on
    // disk. The user's own AVD is never deleted either way.
    const keep = readFlag(args, ["--keep"]);
    return androidAction("android device-detach", "releaseDevice", {
      ...laneClaim(),
      ...(keep ? { deleteCreated: false } : {}),
    }, "android-release");
  }
  if (sub === "render") {
    // `ade android render --angles front,back --lighting studio --sheet`: a
    // desktop window showing the lane's device in 3D draws the stills and
    // files them as proof.
    const raw = readValue(args, ["--angles", "--angle"]);
    let angles: string[] = ["front", "three-quarter-left"];
    if (raw != null) {
      angles = raw.split(",").map((value) => value.trim()).filter(Boolean);
      if (angles.length === 0) throw new CliUsageError("android render: --angles needs at least one value.");
      const bad = angles.find((value) => !(ANDROID_RENDER_ANGLE_IDS as readonly string[]).includes(value));
      if (bad !== undefined) throw new CliUsageError(`android render: '${bad}' is not one of ${ANDROID_RENDER_ANGLE_IDS.join(", ")}.`);
    }
    const background = readValue(args, ["--lighting", "--background"]) ?? "transparent";
    if (!(ANDROID_RENDER_BACKGROUNDS as readonly string[]).includes(background)) {
      throw new CliUsageError(`android render: --lighting must be ${ANDROID_RENDER_BACKGROUNDS.join(", ")}.`);
    }
    return androidAction("android render", "requestRender", {
      ...laneClaim(),
      request: {
        angles,
        background,
        shadow: !readFlag(args, ["--no-shadow"]),
        video: readFlag(args, ["--video", "--turntable"]),
        contactSheet: readFlag(args, ["--sheet", "--contact-sheet"]),
      },
    }, "android-render", { progressNotice: "Asking a desktop window to draw the lane's Android device in 3D…" });
  }
  if (sub === "screenshot") {
    const outPath = androidOutPath(readValue(args, ["--out"]), options.remote === true);
    const caption = readValue(args, ["--caption"]);
    // `--no-proof`: write the PNG, file nothing (as `ade apple screenshot --no-proof`).
    const noProof = readFlag(args, ["--no-proof"]);
    return androidAction("android screenshot", "screenshot", {
      ...laneClaim(),
      ...(outPath ? { outPath } : {}),
      ...(caption ? { caption } : {}),
      ...(noProof ? { proof: false } : {}),
    }, "android-screenshot", { shapeResult: withAsked(caption ? { caption } : {}) });
  }
  if (sub === "tap") {
    const { x, y } = readPoint(args, positionals(), "tap");
    return androidAction("android tap", "tap", { ...laneClaim(), x, y }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "tap", x, y }),
    });
  }
  if (sub === "swipe") {
    const stroke = readStroke(positionals(), "swipe");
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android swipe", "swipe", {
      ...laneClaim(),
      ...stroke,
      ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "swipe", ...stroke }),
    });
  }
  // The verbs and flags are `ade apple`'s for the same job (button, type,
  // --duration-ms, --out), so an agent learns one set of words.
  if (sub === "button") {
    const button = requireValue(readValue(args, ["--name"]) ?? positionals()[0] ?? null, "the button").toLowerCase();
    const key = ANDROID_BUTTONS.get(button);
    if (!key) {
      throw new CliUsageError(`android button: unknown button '${button}'. Valid buttons: ${[...ANDROID_BUTTONS.keys()].join(", ")}.`);
    }
    return androidAction("android button", "sendKey", { ...laneClaim(), key }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "button", button }),
    });
  }
  if (sub === "rotate") {
    // `ade apple rotate`'s names; `landscape` is `landscape-right`.
    const orientation = requireValue(positionals()[0] ?? null, "the orientation (portrait, portrait-upside-down, landscape-left or landscape-right)").toLowerCase();
    if (!(ANDROID_ORIENTATIONS as readonly string[]).includes(orientation)) {
      throw new CliUsageError(`android rotate: unknown orientation '${orientation}'. Use ${ANDROID_ORIENTATIONS.join(", ")}.`);
    }
    return androidAction("android rotate", "rotate", { ...laneClaim(), orientation }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "rotate", orientation }),
    });
  }
  if (sub === "type") {
    // `--submit` presses Enter after the text (`ade apple type --submit`); with no text, Enter alone.
    const submit = readFlag(args, ["--submit"]);
    const raw = readValue(args, ["--value"]) ?? positionals()[0] ?? null;
    // Typed exactly as given: a leading or trailing space is part of the text.
    const text = submit && (raw == null || raw === "") ? "" : requireTypedText(raw, "text");
    return androidAction("android type", "sendText", { ...laneClaim(), text, ...(submit ? { submit: true } : {}) }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "type", characters: text.length, ...(submit ? { submit: true } : {}) }),
    });
  }
  if (sub === "key") {
    // One key, modifiers held around it: `key a --ctrl` or `key ctrl+a`.
    // The modifier flags are read first, so none is taken as the key name.
    const flagModifiers = ANDROID_KEY_MODIFIER_FLAGS.filter(([, names]) => readFlag(args, [...names])).map(([modifier]) => modifier);
    const combo = requireValue(positionals()[0] ?? null, "the key (return, tab, escape, a letter, ctrl+a, …)");
    const { key, modifiers: comboModifiers } = splitAndroidKeyCombo(combo);
    const modifiers = [...new Set([...comboModifiers, ...flagModifiers])];
    const badModifier = modifiers.find((name) => ANDROID_KEY_MODIFIERS[name] === undefined);
    if (badModifier !== undefined) {
      throw new CliUsageError(`android key: unknown modifier '${badModifier}'. Modifiers: ${Object.keys(ANDROID_KEY_MODIFIERS).join(", ")}.`);
    }
    if (androidKeyCode(key) === null) {
      throw new CliUsageError(
        `android key: unknown key '${key || "(none)"}'. Valid keys: ${Object.keys(ANDROID_NAMED_KEYCODES).join(", ")}, `
          + "or one letter or digit (key a --ctrl). Modifiers: --shift, --ctrl, --alt, --meta (or --cmd).",
      );
    }
    return androidAction(`android key ${combo}`, "pressKey", {
      ...laneClaim(),
      key,
      ...(modifiers.length ? { modifiers } : {}),
    }, "android-action", { shapeResult: withAsked({ ...laneClaim(), action: "key", key: [...modifiers, key].join("+") }) });
  }
  const device = buildAndroidDevicePlan(sub, args, {
    positionals,
    laneClaim,
    chatSessionId: claimArgs.chatSessionId ?? null,
    androidAction,
  });
  if (device) return device;
  const suite = buildAndroidSuitePlan(sub, args, {
    remote,
    positionals,
    carriers,
    laneClaim,
    chatSessionId: claimArgs.chatSessionId ?? null,
    androidAction,
    launchPassthrough,
  });
  if (suite) return suite;
  throw new CliUsageError(`Unknown android subcommand '${sub}'. Run 'ade android --help'.`);
}
