/**
 * `ade android`: the plan builder and the error hints for the lane's
 * Android emulator. The text formatters are in `cliAndroidFormat.ts`.
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
  ANDROID_ORIENTATIONS,
  ANDROID_RENDER_ANGLE_IDS,
  ANDROID_RENDER_BACKGROUNDS,
  ANDROID_DISPLAY_SIZES,
  ANDROID_LOG_LEVELS,
  ANDROID_PERMISSIONS,
  ANDROID_SCROLL_DIRECTIONS,
  ANDROID_SDK_PERSON_ONLY_ACTIONS,
  ANDROID_TEXT_SIZES,
  type AndroidErrorCode,
  type AndroidHardwareKey,
} from "../../desktop/src/shared/types/androidEmulator";
import { localRuntimeActionTimeoutMs } from "../../desktop/src/main/services/localRuntime/localRuntimeTimeoutPolicy";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  firstStandalonePositional,
  isRecord,
  listActionsStep,
  proofCallerRootArgs,
  readFlag,
  readNumberOption,
  readRepeatedValues,
  readToolClaimArgs,
  readValue,
  renderKeyValues,
  renderTable,
  requireTypedText,
  requireValue,
  standalonePositionals,
  unwrapActionEnvelope,
  workToolShowPlan,
  type CliPlan,
  type FormatterId,
  type JsonObject,
  type ValueCarrierFlags,
} from "./cli";
import { appleLeaseAnswer, appleLeaseNotAcquired } from "./cliAppleFormat";
import { formatAndroidSdkInstallLine, record, records } from "./cliAndroidFormat";

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
  "--color",
  "--data",
  "--direction",
  "--display-size",
  "--duration-ms",
  "--folder",
  "--hold-ms",
  "--holder",
  "--id",
  "--identifier",
  "--image",
  "--index",
  "--label",
  "--lane",
  "--latitude",
  "--layout-bounds",
  "--level",
  "--lighting",
  "--lines",
  "--longitude",
  "--max-seconds",
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

const ANDROID_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set(ANDROID_VALUE_FLAGS);
const ANDROID_SDK_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set(ANDROID_VALUE_FLAGS.filter((flag) => flag !== "--wait"));

/** The element query flags, `ade apple`'s (`--text` is the element's text). */
const ANDROID_QUERY_FLAGS = ["--ref", "--identifier", "--label", "--text", "--role", "--index"] as const;
const ANDROID_INSTALL_FLAGS = ["--apk", "--gradle", "--module", "--variant"] as const;
/** `ade android settings`: one setting per call; `--battery` and `--charging` together are one. */
const ANDROID_SETTINGS_FLAGS = [
  "--text-size", "--display-size", "--animations", "--show-taps", "--layout-bounds",
  "--battery", "--charging", "--wifi", "--data", "--airplane",
] as const;

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
  show: [],
  devices: ["--profiles"],
  "device-create": ["--profile", "--catalog", "--color", "--image", "--name", "--no-start"],
  "device-attach": ["--avd", "--no-start"],
  start: [],
  stop: [],
  "device-detach": ["--keep"],
  screenshot: ["--out", "--caption"],
  tap: ["--x", "--y"],
  swipe: ["--duration-ms"],
  button: ["--name"],
  rotate: [],
  type: ["--value"],
  // `ade apple render`'s spellings, so one render verb reads the same on both.
  render: ["--angles", "--angle", "--lighting", "--background", "--no-shadow", "--video", "--turntable", "--sheet", "--contact-sheet"],
  // P1 agent suite.
  apps: [],
  install: [...ANDROID_INSTALL_FLAGS],
  launch: ["--package", "--activity", ...ANDROID_INSTALL_FLAGS],
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
  "record-start": ["--label", "--max-seconds"],
  "record-stop": ["--discard"],
  "record-list": [],
  "record-delete": ["--id"],
  lease: ["--wait", "--ttl", "--holder", "--token"],
  location: ["--latitude", "--longitude"],
  appearance: [],
  settings: [...ANDROID_SETTINGS_FLAGS],
  permission: ["--package"],
  "proof-bundle": ["--out", "--caption", "--package", "--no-elements"],
  // P1 setup: each `sdk` verb's own flags are checked again below.
  sdk: ["--folder", "--with-cli", "--accept-license", "--wait", "--id", "--clear"],
};

/** `ade android sdk <verb>`: the only flags each takes. */
const ANDROID_SDK_VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  status: ["--folder", "--with-cli"],
  licenses: ["--folder", "--with-cli", "--id"],
  install: ["--folder", "--with-cli", "--accept-license", "--wait"],
  use: ["--clear"],
  cancel: [],
};

/** `ade apple`'s button names (hyphens), each to the service's key. */
const ANDROID_BUTTONS: ReadonlyMap<string, AndroidHardwareKey> = new Map(
  ANDROID_HARDWARE_KEYS.map((key) => [key.replace(/_/gu, "-"), key] as const),
);

/** The `--flag` names in `args`, skipping each value flag's value and everything after `--`. */
function androidFlagNames(args: readonly string[], carriers: ValueCarrierFlags = ANDROID_VALUE_CARRIER_FLAGS): string[] {
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
};

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
    return personOnly[1] === "setSdkPath"
      ? "Only the user picks this machine's Android SDK folder, in the ADE desktop app: Settings › Android devices. Ask the user."
      : "Only the user installs the Android SDK and accepts Google's licences, in the ADE desktop app: "
        + "the setup card in the Android tool, or Settings › Android devices. Ask the user.";
  }
  return ANDROID_ERROR_HINT_ENTRIES.find(([code]) => message.includes(`${code}:`))?.[1] ?? null;
}

/**
 * `--out` as an absolute path when the folder is this shell's: a relative path
 * means "from where this shell stands", as for any other command. It is sent
 * as typed when this shell has no lane, or with `--machine`, so a brain on
 * another machine resolves it against that lane's worktree (or the chat's
 * work copy there) instead of a folder that exists only here.
 */
function androidOutPath(value: string | null, remote: boolean): string | null {
  if (!value || path.isAbsolute(value) || remote) return value;
  return process.env.ADE_LANE_ID ? path.resolve(process.cwd(), value) : value;
}

function finiteNumber(raw: string | undefined, label: string, verb: string): number {
  const value = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(value)) {
    throw new CliUsageError(`android ${verb}: ${label} must be a number.`);
  }
  return value;
}

/** One point in device pixels: `--x`/`--y`, or `<x> <y>`. */
function readPoint(args: string[], rest: readonly string[], verb: string): { x: number; y: number } {
  const flagX = readNumberOption(args, ["--x"]);
  const flagY = readNumberOption(args, ["--y"]);
  return { x: flagX ?? finiteNumber(rest[0], "x", verb), y: flagY ?? finiteNumber(rest[1], "y", verb) };
}

/** A stroke in device pixels: `<x1> <y1> <x2> <y2>`. */
function readStroke(rest: readonly string[], verb: string): { fromX: number; fromY: number; toX: number; toY: number } {
  if (rest.length < 4) throw new CliUsageError(`android ${verb} needs <x1> <y1> <x2> <y2> (device pixels).`);
  const [fromX, fromY, toX, toY] = (["x1", "y1", "x2", "y2"] as const).map((label, index) => finiteNumber(rest[index], label, verb));
  return { fromX: fromX!, fromY: fromY!, toX: toX!, toY: toY! };
}

export function buildAndroidPlan(args: string[], options: { remote?: boolean } = {}): CliPlan {
  const sub = firstStandalonePositional(args, ANDROID_VALUE_CARRIER_FLAGS) ?? "status";
  // `sdk install --wait` is a switch, `lease --wait <s>` takes seconds.
  const carriers = sub === "sdk" ? ANDROID_SDK_VALUE_CARRIER_FLAGS : ANDROID_VALUE_CARRIER_FLAGS;
  const positionals = (): string[] => standalonePositionals(args, carriers);
  const verbFlags = ANDROID_VERB_FLAGS[sub];
  if (verbFlags) {
    const unknown = androidFlagNames(args, carriers).find((name) => name !== "--lane" && !verbFlags.includes(name));
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
    return {
      kind: "execute",
      label,
      formatter,
      steps: [actionStep("result", ANDROID_EMULATOR_DOMAIN, method, payload, callerRootArgs)],
      ...(minTimeoutMs > 30_000 ? { minTimeoutMs: minTimeoutMs + 15_000 } : {}),
      ...extra,
    };
  };
  const bootNotice = "Booting the lane's Android emulator; the first boot of a new AVD can take about a minute…";

  if (sub === "status")
    return androidAction("android status", "getStatus", laneClaim(), "android-status");
  // Same verb as `ade ui show android`, spelled where an agent driving the
  // emulator looks for it.
  if (sub === "show") return workToolShowPlan(claimArgs, "android");
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
  if (sub === "start")
    return androidAction("android start", "start", laneClaim(), "android-device", { progressNotice: bootNotice });
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
    return androidAction("android screenshot", "screenshot", {
      ...laneClaim(),
      ...(outPath ? { outPath } : {}),
      ...(caption ? { caption } : {}),
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
    const orientation = requireValue(positionals()[0] ?? null, "the orientation (portrait or landscape)").toLowerCase();
    if (!(ANDROID_ORIENTATIONS as readonly string[]).includes(orientation)) {
      throw new CliUsageError(`android rotate: unknown orientation '${orientation}'. Use ${ANDROID_ORIENTATIONS.join(" or ")}.`);
    }
    return androidAction("android rotate", "rotate", { ...laneClaim(), orientation }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "rotate", orientation }),
    });
  }
  if (sub === "type") {
    // Typed exactly as given: a leading or trailing space is part of the text.
    const text = requireTypedText(readValue(args, ["--value"]) ?? positionals()[0] ?? null, "text");
    return androidAction("android type", "sendText", { ...laneClaim(), text }, "android-action", {
      shapeResult: withAsked({ ...laneClaim(), action: "type", characters: text.length }),
    });
  }
  const suite = buildAndroidSuitePlan(sub, args, {
    remote,
    positionals,
    carriers,
    laneClaim,
    chatSessionId: claimArgs.chatSessionId ?? null,
    androidAction,
  });
  if (suite) return suite;
  throw new CliUsageError(`Unknown android subcommand '${sub}'. Run 'ade android --help'.`);
}

type AndroidActionBuilder = (
  label: string,
  method: string,
  payload: JsonObject,
  formatter: FormatterId,
  extra?: { shapeResult?: (values: JsonObject) => unknown; progressNotice?: string },
) => CliPlan & { kind: "execute" };

/** A local path as an absolute one; sent as typed with `--machine`, where the other machine resolves it. */
function localPath(value: string, remote: boolean): string {
  return remote || path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/**
 * The action's answer with what was asked, so `--json` and the text line both
 * have it. A void input action answers with this alone.
 */
function withAsked(asked: JsonObject) {
  return (values: JsonObject): unknown => {
    const result = record(values.result);
    return { ok: true, ...result, ...asked };
  };
}

/** P1 agent suite verbs and `sdk`. Null for a verb that is not one of them. */
function buildAndroidSuitePlan(
  sub: string,
  args: string[],
  ctx: {
    remote: boolean;
    positionals: () => string[];
    carriers: ValueCarrierFlags;
    laneClaim: () => JsonObject;
    chatSessionId: string | null;
    androidAction: AndroidActionBuilder;
  },
): CliPlan | null {
  const { remote, positionals, laneClaim, androidAction } = ctx;
  const usage = (message: string) => new CliUsageError(`android ${sub}: ${message}`);
  const readPackage = (required: boolean): string | null => {
    const value = readValue(args, ["--package"]);
    if (required && !value) throw usage("--package <name> is required (`ade android apps --text` lists them).");
    return value;
  };
  const readInstallSource = (required: boolean): JsonObject => {
    const apk = readValue(args, ["--apk"]);
    const gradle = readFlag(args, ["--gradle"]);
    const moduleName = readValue(args, ["--module"]);
    const variant = readValue(args, ["--variant"]);
    if (apk && gradle) throw usage("pass --apk <path> or --gradle, not both.");
    if ((moduleName || variant) && !gradle) throw usage("--module and --variant go with --gradle.");
    if (required && !apk && !gradle) throw usage("pass --apk <path>, or --gradle to build the lane's app (--module <name>, --variant <name>).");
    // Always from this shell's folder: the APK is a file here. With
    // `--machine` it is sent as a path inside this checkout (cliRemoteWork).
    if (apk) return { apkPath: path.resolve(process.cwd(), apk) };
    if (gradle) return { gradle: { ...(moduleName ? { module: moduleName } : {}), ...(variant ? { variant } : {}) } };
    return {};
  };
  const readQuery = (): JsonObject => {
    const query: JsonObject = {};
    for (const [flag, key] of [["--ref", "ref"], ["--identifier", "identifier"], ["--label", "label"], ["--text", "text"], ["--role", "role"]] as const) {
      const value = readValue(args, [flag]);
      if (value) query[key] = value;
    }
    if (Object.keys(query).length === 0) {
      throw usage("name the element with --ref, --identifier, --label, --text or --role (`ade android snapshot --text` lists them).");
    }
    const index = readNumberOption(args, ["--index"]);
    if (index != null) query.index = index;
    return query;
  };
  const elementResult = { exitCodeFromResult: (result: unknown) => (record(result).ok === false ? 1 : 0) };

  if (sub === "apps") return androidAction("android apps", "listApps", laneClaim(), "android-apps");
  if (sub === "install") {
    const source = readInstallSource(true);
    return androidAction("android install", "installApp", { ...laneClaim(), ...source }, "android-install",
      source.gradle ? { progressNotice: "Building the lane's app with Gradle and installing it; a first build can take a few minutes…" } : {});
  }
  if (sub === "launch") {
    const packageName = readPackage(false);
    const activity = readValue(args, ["--activity"]);
    const source = readInstallSource(false);
    if (!packageName && !source.apkPath && !source.gradle) {
      throw usage("pass --package <name>, or --gradle / --apk <path> to install the app and open it.");
    }
    return androidAction("android launch", "launchApp", {
      ...laneClaim(),
      ...source,
      ...(packageName ? { packageName } : {}),
      ...(activity ? { activity } : {}),
    }, "android-launch", source.gradle ? { progressNotice: "Building the lane's app with Gradle, then opening it…" } : {});
  }
  if (sub === "terminate" || sub === "uninstall") {
    const packageName = readPackage(true)!;
    return androidAction(`android ${sub}`, sub === "terminate" ? "terminateApp" : "uninstallApp", { ...laneClaim(), packageName }, "android-action", {
      shapeResult: withAsked({ action: sub, packageName }),
    });
  }
  if (sub === "open-url") {
    const url = requireValue(readValue(args, ["--url"]) ?? positionals()[0] ?? null, "the URL");
    return androidAction("android open-url", "openUrl", { ...laneClaim(), url }, "android-action", {
      shapeResult: withAsked({ action: "open-url", url }),
    });
  }
  if (sub === "long-press") {
    const { x, y } = readPoint(args, positionals(), sub);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android long-press", "longPress", {
      ...laneClaim(), x, y, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "long-press", x, y, ...(durationMs == null ? {} : { durationMs }) }) });
  }
  if (sub === "drag") {
    const stroke = readStroke(positionals(), sub);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android drag", "drag", {
      ...laneClaim(), ...stroke, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "drag", ...stroke }) });
  }
  if (sub === "scroll") {
    const direction = (readValue(args, ["--direction"]) ?? positionals()[0] ?? "").toLowerCase();
    if (!(ANDROID_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
      throw usage(`--direction must be ${ANDROID_SCROLL_DIRECTIONS.join(", ")}.`);
    }
    const amount = readNumberOption(args, ["--amount"]);
    const anchorX = readNumberOption(args, ["--anchor-x"]);
    const anchorY = readNumberOption(args, ["--anchor-y"]);
    return androidAction("android scroll", "scroll", {
      ...laneClaim(),
      direction,
      ...(amount == null ? {} : { amount }),
      ...(anchorX == null ? {} : { anchorX }),
      ...(anchorY == null ? {} : { anchorY }),
    }, "android-action", { shapeResult: withAsked({ action: "scroll", direction }) });
  }
  if (sub === "snapshot") {
    const fresh = readFlag(args, ["--fresh"]);
    return androidAction("android snapshot", "getScreenSnapshot", { ...laneClaim(), ...(fresh ? { fresh: true } : {}) }, "android-snapshot");
  }
  if (sub === "find-element") {
    return { ...androidAction("android find-element", "findElement", { ...laneClaim(), query: readQuery() }, "android-element"), ...elementResult };
  }
  if (sub === "tap-element") {
    const holdMs = readNumberOption(args, ["--hold-ms"]);
    return {
      ...androidAction("android tap-element", "tapElement", { ...laneClaim(), query: readQuery(), ...(holdMs == null ? {} : { holdMs }) }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "fill-element") {
    const noFocus = readFlag(args, ["--no-focus"]);
    // The query first: it claims `--text <value>`, and the value is `--value` or the positional.
    const query = readQuery();
    const text = requireTypedText(readValue(args, ["--value"]) ?? positionals()[0] ?? null, "the text to type (--value <text>)");
    return {
      ...androidAction("android fill-element", "fillElement", { ...laneClaim(), query, text, ...(noFocus ? { focusFirst: false } : {}) }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "wait-for-element") {
    const timeoutMs = readNumberOption(args, ["--timeout-ms"]);
    const gone = readFlag(args, ["--gone"]);
    return {
      ...androidAction("android wait-for-element", "waitForElement", {
        ...laneClaim(),
        query: readQuery(),
        ...(timeoutMs == null ? {} : { timeoutMs }),
        ...(gone ? { state: "gone" } : {}),
      }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "assert-visible") {
    return { ...androidAction("android assert-visible", "assertVisible", { ...laneClaim(), query: readQuery() }, "android-element"), ...elementResult };
  }
  if (sub === "log") {
    const packageName = readPackage(false);
    const level = readValue(args, ["--level"])?.toLowerCase() ?? null;
    if (level && !(ANDROID_LOG_LEVELS as readonly string[]).includes(level)) throw usage(`--level must be ${ANDROID_LOG_LEVELS.join(", ")}.`);
    const since = readValue(args, ["--since"]);
    const lines = readNumberOption(args, ["--lines"]);
    return androidAction("android log", "readLog", {
      ...laneClaim(),
      ...(packageName ? { packageName } : {}),
      ...(level ? { level } : {}),
      ...(since ? { since } : {}),
      ...(lines == null ? {} : { lines }),
    }, "android-log");
  }
  if (sub === "record-start") {
    const label = readValue(args, ["--label"]);
    const maxSeconds = readNumberOption(args, ["--max-seconds"]);
    if (maxSeconds != null && maxSeconds <= 0) throw usage("--max-seconds must be greater than 0.");
    return androidAction("android record-start", "recordStart", {
      ...laneClaim(),
      ...(label ? { label } : {}),
      ...(maxSeconds == null ? {} : { maxSeconds }),
    }, "android-recording");
  }
  if (sub === "record-stop") {
    const discard = readFlag(args, ["--discard"]);
    return androidAction("android record-stop", "recordStop", { ...laneClaim(), ...(discard ? { discard: true } : {}) }, "android-recording");
  }
  if (sub === "record-list") return androidAction("android record-list", "recordList", laneClaim(), "android-recordings");
  if (sub === "record-delete") {
    const id = requireValue(readValue(args, ["--id"]) ?? positionals()[0] ?? null, "--id <recording id>");
    return androidAction("android record-delete", "recordDelete", { ...laneClaim(), id }, "android-action", {
      shapeResult: withAsked({ action: "record-delete", id }),
    });
  }
  if (sub === "lease") return buildAndroidLeasePlan(args, ctx);
  if (sub === "location") {
    const latitudeFlag = readNumberOption(args, ["--latitude"]);
    const longitudeFlag = readNumberOption(args, ["--longitude"]);
    // A longitude is often negative, which the positional reader takes for a
    // flag. The number after `--latitude` or `--longitude` is that flag's, so
    // it never fills the other coordinate.
    const flagValueAt = new Set(
      args.flatMap((value, index) => (value === "--latitude" || value === "--longitude" ? [index + 1] : [])),
    );
    const signed = args.filter((value, index) => !flagValueAt.has(index) && /^-?\d+(\.\d+)?$/u.test(value));
    const latitude = latitudeFlag ?? finiteNumber(signed.shift(), "latitude", sub);
    const longitude = longitudeFlag ?? finiteNumber(signed.shift(), "longitude", sub);
    return androidAction("android location", "setLocation", { ...laneClaim(), latitude, longitude }, "android-action", {
      shapeResult: withAsked({ action: "location", latitude, longitude }),
    });
  }
  if (sub === "appearance") {
    const appearance = (positionals()[0] ?? "").toLowerCase();
    if (appearance !== "light" && appearance !== "dark") throw usage("say light or dark.");
    return androidAction("android appearance", "setAppearance", { ...laneClaim(), appearance }, "android-action", {
      shapeResult: withAsked({ action: "appearance", appearance }),
    });
  }
  if (sub === "settings") {
    const onOff = (flag: string): boolean | null => {
      const raw = readValue(args, [flag]);
      if (raw == null) return null;
      const value = raw.toLowerCase();
      if (value === "on" || value === "true") return true;
      if (value === "off" || value === "false") return false;
      throw usage(`${flag} takes on or off.`);
    };
    const oneOf = (flag: string, allowed: readonly string[]): string | null => {
      const raw = readValue(args, [flag]);
      if (raw == null) return null;
      if (!allowed.includes(raw)) throw usage(`${flag} takes ${allowed.join(", ")}.`);
      return raw;
    };
    const textSize = oneOf("--text-size", ANDROID_TEXT_SIZES.map((size) => size.value));
    const displaySize = oneOf("--display-size", ANDROID_DISPLAY_SIZES.map((size) => size.value));
    const animations = onOff("--animations");
    const showTaps = onOff("--show-taps");
    const layoutBounds = onOff("--layout-bounds");
    const batteryRaw = readNumberOption(args, ["--battery"]);
    const charging = onOff("--charging");
    const wifi = onOff("--wifi");
    const data = onOff("--data");
    const airplane = onOff("--airplane");
    const settings: JsonObject[] = [];
    if (textSize) settings.push({ kind: "text-size", value: textSize });
    if (displaySize) settings.push({ kind: "display-size", value: displaySize });
    if (animations !== null) settings.push({ kind: "animations", off: !animations });
    if (showTaps !== null) settings.push({ kind: "show-taps", on: showTaps });
    if (layoutBounds !== null) settings.push({ kind: "layout-bounds", on: layoutBounds });
    if (batteryRaw != null || charging !== null) {
      settings.push({ kind: "battery", ...(batteryRaw != null ? { level: batteryRaw } : {}), ...(charging !== null ? { charging } : {}) });
    }
    if (wifi !== null) settings.push({ kind: "wifi", on: wifi });
    if (data !== null) settings.push({ kind: "mobile-data", on: data });
    if (airplane !== null) settings.push({ kind: "airplane", on: airplane });
    if (settings.length > 1) throw usage("change one setting per call (--battery and --charging go together).");
    if (settings.length === 0) return androidAction("android settings", "getDeviceSettings", laneClaim(), "android-settings");
    const changed = ANDROID_SETTINGS_FLAGS
      .map((flag) => [flag, readValue(args, [flag])] as const)
      .filter(([, value]) => value != null)
      .map(([flag, value]) => `${flag.slice(2)} ${value}`)
      .join(", ");
    return androidAction("android settings", "setDeviceSetting", { ...laneClaim(), setting: settings[0]! }, "android-settings", {
      shapeResult: withAsked({ changed }),
    });
  }
  if (sub === "permission") {
    const [verb, permission] = positionals();
    if (verb !== "grant" && verb !== "revoke") throw usage("say grant or revoke, then the permission: ade android permission grant camera --package <name>.");
    if (!permission) {
      throw usage(`name the permission (${ANDROID_PERMISSIONS.map((entry) => entry.short).join(", ")}, or android.permission.<NAME>).`);
    }
    const packageName = readPackage(true)!;
    return androidAction("android permission", "setPermission", { ...laneClaim(), action: verb, packageName, permission }, "android-action", {
      shapeResult: withAsked({ action: "permission", grant: verb, packageName }),
    });
  }
  if (sub === "proof-bundle") {
    const out = readValue(args, ["--out"]);
    const caption = readValue(args, ["--caption"]);
    const packageName = readPackage(false);
    const noElements = readFlag(args, ["--no-elements"]);
    return androidAction("android proof-bundle", "captureProofBundle", {
      ...laneClaim(),
      ...(out ? { outDir: androidOutPath(out, remote) } : {}),
      ...(caption ? { caption } : {}),
      ...(packageName ? { packageName } : {}),
      ...(noElements ? { includeElements: false } : {}),
    }, "android-proof-bundle");
  }
  if (sub === "sdk") return buildAndroidSdkPlan(args, ctx);
  return null;
}

/**
 * `ade android lease [--wait <s>] [--ttl <s>] [--holder <name>]`, then
 * `lease release --token <t>`, `lease renew --token <t>`, `lease status`:
 * `ade apple lease`'s verbs. Leases live in the brain, so these never fall
 * back to an in-process runtime.
 */
function buildAndroidLeasePlan(
  args: string[],
  ctx: { positionals: () => string[]; laneClaim: () => JsonObject; chatSessionId: string | null; androidAction: AndroidActionBuilder },
): CliPlan {
  // Every flag first: a flag's value must not be read as the verb.
  const waitSeconds = readNumberOption(args, ["--wait"]);
  const ttlSeconds = readNumberOption(args, ["--ttl"]);
  // A shell with no chat is its own holder (its parent, the shell), so two
  // terminals queue instead of both renewing one anonymous lease.
  const holder = readValue(args, ["--holder"]) ?? (ctx.chatSessionId ? null : `shell ${process.ppid}`);
  const tokenFlag = readValue(args, ["--token"]);
  const [verbRaw, tokenPositional] = ctx.positionals();
  const verb = verbRaw ?? "acquire";
  const leasePlan = { needsLiveRuntime: "Android device leases" };
  const scope = ctx.laneClaim();
  if (verb === "status") {
    return { ...ctx.androidAction("android lease status", "deviceLeaseStatus", scope, "android-lease"), ...leasePlan };
  }
  if (verb === "release") {
    const token = requireValue(tokenFlag ?? tokenPositional ?? null, "--token");
    return {
      ...ctx.androidAction("android lease release", "deviceLeaseRelease", { ...scope, token }, "android-lease"),
      ...leasePlan,
      // A token that held nothing exits 1: the caller did not have the turn it thought it had.
      exitCodeFromResult: (result: unknown) => {
        const value = appleLeaseAnswer(result);
        return isRecord(value) && value.released === false ? 1 : 0;
      },
    };
  }
  if (verb !== "acquire" && verb !== "renew") {
    throw new CliUsageError(`android lease: unknown action '${verb}'. Use acquire (the default), renew, release or status.`);
  }
  if (verb === "renew" && !tokenFlag) throw new CliUsageError("android lease renew needs --token <t>, the token your lease printed.");
  const plan = ctx.androidAction("android lease", "deviceLease", {
    ...scope,
    ...(holder ? { holder } : {}),
    // A turn is its token: subagents of one chat share the chat's id, so only the token renews.
    distinct: true,
    ...(tokenFlag ? { token: tokenFlag } : {}),
    ...(waitSeconds != null ? { waitMs: Math.round(waitSeconds * 1000) } : {}),
    ...(ttlSeconds != null ? { ttlMs: Math.round(ttlSeconds * 1000) } : {}),
  }, "android-lease");
  return {
    ...plan,
    ...leasePlan,
    // The call outlives the wait, so the answer arrives even under a short --timeout-ms.
    ...(waitSeconds != null && waitSeconds > 0
      ? { minTimeoutMs: Math.max(plan.minTimeoutMs ?? 0, Math.round(Math.min(waitSeconds, 540) * 1000) + 60_000) }
      : {}),
    // A lease that was not granted (busy, or the wait ran out) exits 1, so
    // `lease --wait N && install` never installs over another holder's turn.
    exitCodeFromResult: (result: unknown) => (appleLeaseNotAcquired(result) ? 1 : 0),
  };
}

const SDK_TERMINAL_STATES = new Set(["idle", "done", "failed", "cancelled"]);

/**
 * `ade android sdk status | licenses | install | use | cancel`: the guided
 * SDK install the setup card runs. An agent may read the plan; only a person
 * accepts a licence (the brain refuses an agent's install).
 */
function buildAndroidSdkPlan(
  args: string[],
  ctx: { remote: boolean; positionals: () => string[]; carriers: ValueCarrierFlags; androidAction: AndroidActionBuilder },
): CliPlan {
  const [verbRaw, folderPositional] = ctx.positionals();
  const verb = verbRaw ?? "status";
  const allowed = ANDROID_SDK_VERB_FLAGS[verb];
  if (!allowed) throw new CliUsageError(`android sdk: unknown verb '${verb}'. Use status, licenses, install, use or cancel.`);
  const unknown = androidFlagNames(args, ctx.carriers).find((name) => name !== "--lane" && !allowed.includes(name));
  if (unknown) throw new CliUsageError(`android sdk ${verb} does not take ${unknown}. Run 'ade android --help'.`);
  const setupArgs = (): JsonObject => {
    const folder = readValue(args, ["--folder"]);
    const withCli = readFlag(args, ["--with-cli"]);
    return {
      ...(folder ? { sdkRoot: localPath(folder, ctx.remote) } : {}),
      ...(withCli ? { includeAndroidCli: true } : {}),
    };
  };
  if (verb === "status") return ctx.androidAction("android sdk status", "getSdkSetupPlan", setupArgs(), "android-sdk-status");
  if (verb === "licenses") {
    const id = readValue(args, ["--id"]);
    return ctx.androidAction("android sdk licenses", "getSdkSetupPlan", setupArgs(), "android-sdk-licenses", {
      shapeResult: (values) => {
        const licenses = records(record(values.result).licenses);
        if (!id) return { licenses };
        const picked = licenses.filter((license) => license.id === id);
        if (!picked.length) {
          throw new CliUsageError(`android sdk licenses: no licence '${id}'. This setup needs: ${licenses.map((license) => String(license.id)).join(", ") || "none"}.`);
        }
        return { licenses: picked };
      },
    });
  }
  if (verb === "install") {
    const accepted = readRepeatedValues(args, ["--accept-license"]).map((value) => value.trim()).filter(Boolean);
    const wait = readFlag(args, ["--wait"]);
    const payload = setupArgs();
    if (!accepted.length) {
      // ADE never accepts a licence for the caller: the person names each one.
      throw new CliUsageError(
        "android sdk install needs --accept-license <id> for each licence the parts need. "
          + "Run `ade android sdk status` to see them and `ade android sdk licenses` to read them.",
      );
    }
    const plan = ctx.androidAction("android sdk install", "installSdk", { ...payload, acceptedLicenseIds: accepted }, "android-sdk-install");
    if (!wait) return plan;
    const poll = ctx.androidAction("android sdk install state", "getSdkInstallState", {}, "android-sdk-install");
    return {
      ...plan,
      followResult: {
        plan: poll,
        intervalMs: 2_000,
        done: (result: unknown) => SDK_TERMINAL_STATES.has(asString(record(result).state) ?? "idle"),
        progress: (result: unknown) => formatAndroidSdkInstallLine(record(result)),
      },
      exitCodeFromResult: (result: unknown) => (record(result).state === "failed" ? 1 : 0),
    };
  }
  if (verb === "use") {
    const clear = readFlag(args, ["--clear"]);
    const folder = folderPositional ?? null;
    if (clear === Boolean(folder)) throw new CliUsageError("android sdk use takes a folder, or --clear to go back to the SDK ADE finds.");
    return ctx.androidAction("android sdk use", "setSdkPath", { path: folder ? localPath(folder, ctx.remote) : null }, "android-status");
  }
  return ctx.androidAction("android sdk cancel", "cancelSdkInstall", {}, "android-sdk-install");
}
