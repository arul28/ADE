/**
 * `ade android`: the plan builder, the text formatters
 * and the error hints for the lane's Android emulator.
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
  ANDROID_LOG_LEVELS,
  ANDROID_SCROLL_DIRECTIONS,
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
  ANDROID_SDK_LICENSE_NOT_ACCEPTED:
    "hint: Run `ade android sdk licenses` to read them, then pass --accept-license <id> for each.",
  ANDROID_SDK_NO_SPACE: "hint: Free space or pass --folder on another drive.",
  ANDROID_SDK_INSTALL_BUSY: "hint: Wait for it, or run `ade android sdk cancel`.",
  ANDROID_SDK_INSTALL_FAILED:
    "hint: Run `ade android sdk status` to see what is missing, then install again; finished parts stay.",
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

/** The SDK setup verbs only a person may run (the brain refuses an agent by caller shape). */
const ANDROID_PERSON_ONLY_SDK = /android_emulator\.(installSdk|cancelSdkInstall|setSdkPath)\b[^\n]*(?:not permitted|requires elevated role)/u;

/** The hint line for an `ANDROID_*: sentence` error, or null. */
export function androidEmulatorErrorHint(message: string): string | null {
  const personOnly = ANDROID_PERSON_ONLY_SDK.exec(message);
  if (personOnly) {
    return personOnly[1] === "installSdk"
      ? "Only a person can accept Google's licences. Ask the user to run this, or to use the setup card."
      : "Only a person can change this machine's Android SDK. Ask the user to run this, or to use the setup card.";
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
  /** A void input action answers with what it did, so `--json` has something to read. */
  const done = (summary: JsonObject) => (): unknown => ({ ok: true, ...laneClaim(), ...summary });
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
    const rest = positionals();
    const flagX = readNumberOption(args, ["--x"]);
    const flagY = readNumberOption(args, ["--y"]);
    const x = flagX ?? finiteNumber(rest[0], "x", "tap");
    const y = flagY ?? finiteNumber(rest[1], "y", "tap");
    return androidAction("android tap", "tap", { ...laneClaim(), x, y }, "android-action", {
      shapeResult: done({ action: "tap", x, y }),
    });
  }
  if (sub === "swipe") {
    const rest = positionals();
    if (rest.length < 4) {
      throw new CliUsageError("android swipe requires <x1> <y1> <x2> <y2> (device pixels).");
    }
    const [fromX, fromY, toX, toY] = rest.slice(0, 4).map((value, index) => finiteNumber(value, ["x1", "y1", "x2", "y2"][index]!, "swipe"));
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android swipe", "swipe", {
      ...laneClaim(),
      fromX: fromX!,
      fromY: fromY!,
      toX: toX!,
      toY: toY!,
      ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", {
      shapeResult: done({ action: "swipe", fromX: fromX!, fromY: fromY!, toX: toX!, toY: toY! }),
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
      shapeResult: done({ action: "button", button }),
    });
  }
  if (sub === "rotate") {
    const orientation = requireValue(positionals()[0] ?? null, "the orientation (portrait or landscape)").toLowerCase();
    if (!(ANDROID_ORIENTATIONS as readonly string[]).includes(orientation)) {
      throw new CliUsageError(`android rotate: unknown orientation '${orientation}'. Use ${ANDROID_ORIENTATIONS.join(" or ")}.`);
    }
    return androidAction("android rotate", "rotate", { ...laneClaim(), orientation }, "android-action", {
      shapeResult: done({ action: "rotate", orientation }),
    });
  }
  if (sub === "type") {
    // Typed exactly as given: a leading or trailing space is part of the text.
    const text = requireTypedText(readValue(args, ["--value"]) ?? positionals()[0] ?? null, "text");
    return androidAction("android type", "sendText", { ...laneClaim(), text }, "android-action", {
      shapeResult: done({ action: "type", characters: text.length }),
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

/** The action's answer with what was asked, so `--json` and the text line both have it. */
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
  const point = (rest: string[], offset: number, names: readonly string[]): number[] =>
    names.map((name, index) => finiteNumber(rest[offset + index], name, sub));
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
    const flagX = readNumberOption(args, ["--x"]);
    const flagY = readNumberOption(args, ["--y"]);
    const rest = positionals();
    const x = flagX ?? finiteNumber(rest[0], "x", sub);
    const y = flagY ?? finiteNumber(rest[1], "y", sub);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android long-press", "longPress", {
      ...laneClaim(), x, y, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "long-press", x, y, ...(durationMs == null ? {} : { durationMs }) }) });
  }
  if (sub === "drag") {
    const rest = positionals();
    if (rest.length < 4) throw usage("needs <x1> <y1> <x2> <y2> (device pixels).");
    const [fromX, fromY, toX, toY] = point(rest, 0, ["x1", "y1", "x2", "y2"]);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android drag", "drag", {
      ...laneClaim(), fromX: fromX!, fromY: fromY!, toX: toX!, toY: toY!, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "drag", fromX: fromX!, fromY: fromY!, toX: toX!, toY: toY! }) });
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
    // A longitude is often negative, which the positional reader takes for a flag.
    const signed = args.filter((value) => /^-?\d+(\.\d+)?$/u.test(value));
    const latitude = latitudeFlag ?? finiteNumber(signed[0], "latitude", sub);
    const longitude = longitudeFlag ?? finiteNumber(signed[latitudeFlag == null ? 1 : 0], "longitude", sub);
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
    const textSize = oneOf("--text-size", ["small", "default", "large", "largest"]);
    const displaySize = oneOf("--display-size", ["small", "default", "large", "larger"]);
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
    if (!permission) throw usage("name the permission (camera, location, microphone, contacts, notifications, or android.permission.<NAME>).");
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

/* ── Text output ──────────────────────────────────────────────────────────── */

function record(value: unknown): JsonObject {
  const unwrapped = unwrapActionEnvelope(value);
  return isRecord(unwrapped) ? unwrapped : {};
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function yesNo(value: unknown): string | null {
  return value === true ? "yes" : value === false ? "no" : null;
}

/** The lane device block, shared by `status` and the lifecycle verbs. */
function laneDeviceLines(lane: JsonObject): string[] {
  const device = isRecord(lane.device) ? lane.device : null;
  const avd = isRecord(lane.avd) ? lane.avd : null;
  const running = avd && isRecord(avd.running) ? avd.running : null;
  const error = isRecord(lane.error) ? lane.error : null;
  const lines = [
    renderKeyValues("ADE Android emulator (lane)", [
      ["lane", lane.laneId],
      ["state", lane.state],
      ["avd", device?.avdName ?? avd?.name ?? null],
      ["origin", device?.origin],
      ["profile", device?.profileId ?? avd?.profileId ?? null],
      ["image", device?.systemImage],
      ["api", avd?.apiLevel],
      ["screen", avd?.lcdWidth && avd?.lcdHeight ? `${avd.lcdWidth}x${avd.lcdHeight}` : null],
      ["serial", running?.serial],
      ["booted", yesNo(running?.booted)],
    ]),
  ];
  if (error) {
    lines.push("", `error: ${asString(error.code) ?? "?"}: ${asString(error.message) ?? ""}`.trimEnd());
    const logPath = asString(error.logPath);
    if (logPath) lines.push(`log: ${logPath}`);
  }
  if (!device) {
    lines.push("", "next: ade android device-create --profile <id> (ade android devices --profiles lists them), or ade android device-attach --avd <name>");
  } else if (lane.state === "off" || lane.state === "crashed") {
    lines.push("", "next: ade android start");
  }
  return lines;
}

export function formatAndroidStatus(value: unknown): string {
  const status = record(value);
  const sdk = isRecord(status.sdk) ? status.sdk : {};
  const acceleration = isRecord(sdk.acceleration) ? sdk.acceleration : {};
  const tools = records(sdk.tools);
  const lines = [
    renderKeyValues("ADE Android emulator", [
      ["supported", yesNo(status.platformSupported)],
      ["unsupported", status.unsupportedReason],
      ["sdk", sdk.found === true ? asString(sdk.root) ?? "found" : "not found"],
      ["sdk source", sdk.source],
      ["acceleration", acceleration.kind
        ? `${String(acceleration.kind)} (${acceleration.usable === true ? "usable" : "not usable"})`
        : acceleration.usable === true ? "usable" : "none"],
      ["acceleration detail", acceleration.detail],
      ["host abi", sdk.hostAbi],
      ["avd home", sdk.avdHome],
    ], ["unsupported", "acceleration detail"]),
  ];
  if (tools.length) {
    lines.push("", renderTable(
      ["tool", "available", "version", "path / detail"],
      tools.map((tool) => [
        tool.id,
        yesNo(tool.available),
        tool.version,
        tool.available === true ? tool.path : tool.detail ?? tool.path,
      ]),
      "No SDK tools reported.",
    ));
  }
  const capabilities = isRecord(status.capabilities) ? status.capabilities : null;
  if (capabilities) {
    const can = [
      capabilities.record === true ? "record" : null,
      capabilities.uiTree ? `ui tree (${String(capabilities.uiTree)})` : null,
      capabilities.logcat === true ? "logcat" : null,
      capabilities.gradle === true ? "gradle" : null,
    ].filter(Boolean);
    lines.push("", `can: ${can.length ? can.join(", ") : "nothing yet (set up the SDK: ade android sdk status --text)"}`);
    if ("jdk" in capabilities) {
      const jdk = isRecord(capabilities.jdk) ? capabilities.jdk : null;
      lines.push(jdk
        ? `jdk: ${asString(jdk.version) ?? "version unknown"} (${asString(jdk.source) ?? "found"}) ${asString(jdk.home) ?? ""}`.trimEnd()
        : "jdk: none found, so Gradle builds cannot run. Install Android Studio or a JDK 17+, or set JAVA_HOME for ADE.");
    }
  }
  if (isRecord(status.lane)) lines.push("", ...laneDeviceLines(status.lane));
  return lines.join("\n");
}

function formatAvdTable(avds: JsonObject[]): string {
  return renderTable(
    ["avd", "api", "abi", "profile", "running", "lane", "ade"],
    avds.map((avd) => {
      const running = isRecord(avd.running) ? avd.running : null;
      return [
        avd.name,
        avd.apiLevel,
        avd.abi,
        avd.profileId,
        running ? `${asString(running.serial) ?? "?"}${running.booted === true ? " (booted)" : " (booting)"}` : null,
        avd.heldByLaneId,
        yesNo(avd.adeCreated),
      ];
    }),
    "No AVDs on this machine. Make one: ade android device-create --profile <id>.",
    { fullColumns: ["avd", "lane"] },
  );
}

export function formatAndroidDevices(value: unknown, options: { profiles?: boolean } = {}): string {
  const inventory = record(value);
  const avds = records(inventory.avds);
  const profiles = records(inventory.profiles);
  const images = records(inventory.images);
  const lines = [`AVDs  ${avds.length}`, formatAvdTable(avds), "", `System images  ${images.length}`];
  lines.push(renderTable(
    ["package", "api", "tag", "abi"],
    images.map((image) => [image.packageId, image.apiLevel, image.tag, image.abi]),
    "No system images installed. Install one with sdkmanager.",
    { fullColumns: ["package"] },
  ));
  lines.push("");
  if (options.profiles) {
    lines.push(`Hardware profiles  ${profiles.length}`, renderTable(
      ["id", "name", "kind", "screen", "origin"],
      profiles.map((profile) => [
        profile.id,
        profile.name,
        profile.formFactor,
        profile.widthPx && profile.heightPx ? `${profile.widthPx}x${profile.heightPx}` : null,
        profile.origin,
      ]),
      "No hardware profiles reported.",
      { fullColumns: ["id"] },
    ));
  } else {
    lines.push(`Hardware profiles  ${profiles.length} (list them: ade android devices --profiles --text)`);
  }
  return lines.join("\n");
}

export function formatAndroidDevice(value: unknown): string {
  return laneDeviceLines(record(value)).join("\n");
}

export function formatAndroidRelease(value: unknown): string {
  const result = record(value);
  return renderKeyValues("ADE Android emulator release", [
    ["released", yesNo(result.released)],
    ["deleted avd", result.deletedAvd ?? (result.released === true ? "(kept)" : null)],
  ]);
}

export function formatAndroidScreenshot(value: unknown): string {
  const shot = record(value);
  const filePath = asString(shot.path);
  return [
    renderKeyValues("ADE Android screenshot", [
      ["size", shot.width && shot.height ? `${shot.width}x${shot.height}` : null],
      ["bytes", shot.bytes],
      ["captured", shot.capturedAt],
      ["caption", shot.caption],
      ["proof", asString(shot.proofArtifactId) ? "filed (ade proof list)" : null],
    ]),
    // Printed raw rather than as a table cell: agents Read this path back,
    // and the key/value renderer truncates long values.
    filePath ? `file: ${filePath}` : "",
  ].filter(Boolean).join("\n");
}

export function formatAndroidAction(value: unknown): string {
  const result = record(value);
  const action = asString(result.action) ?? "action";
  if (action === "uninstall" && result.uninstalled === false) return `android uninstall: ${String(result.packageName)} was not installed`;
  if (action === "record-delete" && result.deleted === false) return `android record-delete: no recording ${String(result.id)}`;
  const detail = action === "tap" || action === "long-press"
    ? `(${result.x}, ${result.y})${typeof result.durationMs === "number" ? ` for ${result.durationMs} ms` : ""}`
    : action === "swipe" || action === "drag"
      ? `(${result.fromX}, ${result.fromY}) -> (${result.toX}, ${result.toY})`
      : action === "button" || action === "rotate"
        ? String(action === "button" ? result.button : result.orientation)
        : action === "type"
          ? `${result.characters} characters`
          : action === "scroll"
            ? String(result.direction)
            : action === "terminate" || action === "uninstall"
              ? String(result.packageName)
              : action === "open-url"
                ? String(result.url)
                : action === "location"
                  ? `${result.latitude}, ${result.longitude}`
                  : action === "appearance"
                    ? String(result.appearance)
                    : action === "permission"
                      ? `${String(result.grant)} ${String(result.permission ?? "")} for ${String(result.packageName)}`
                      : action === "record-delete"
                        ? String(result.id)
                        : "";
  return `android ${action} ${detail}`.trimEnd() + " done";
}

/** `settings`: what the emulator reports after the read or the change. */
export function formatAndroidSettings(value: unknown): string {
  const settings = record(value);
  const battery = record(settings.battery);
  const network = record(settings.network);
  const density = record(settings.density);
  const onOff = (flag: unknown) => (flag === true ? "on" : flag === false ? "off" : null);
  return renderKeyValues("ADE Android emulator settings", [
    ["changed", settings.changed],
    ["appearance", settings.appearance],
    ["text size", settings.textSize ?? (typeof settings.fontScale === "number" ? `${settings.fontScale}x` : null)],
    ["display size", settings.displaySize ?? (typeof density.override === "number" ? `${density.override} dpi` : null)],
    ["animations", settings.animationsOff === true ? "off" : settings.animationsOff === false ? "on" : null],
    ["show taps", onOff(settings.showTaps)],
    ["layout bounds", onOff(settings.layoutBounds)],
    ["battery", typeof battery.level === "number" ? `${battery.level}%${battery.charging === true ? ", charging" : battery.charging === false ? ", on battery" : ""}` : null],
    ["wifi", onOff(network.wifi)],
    ["mobile data", onOff(network.mobileData)],
    ["airplane", onOff(network.airplane)],
    ["in front", settings.foregroundPackage ?? "home screen"],
  ]);
}

/** `render`: how many files, where they went, and a citation per proof row. */
export function formatAndroidRender(value: unknown): string {
  const result = record(value);
  const ids = Array.isArray(result.proofArtifactIds)
    ? result.proofArtifactIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const paths = Array.isArray(result.paths) ? result.paths.filter((entry): entry is string => typeof entry === "string") : [];
  return [
    renderKeyValues("ADE Android device render", [
      ["filed", result.filed],
      ["error", result.error],
      ["proof", ids.length ? `${ids.length} row${ids.length === 1 ? "" : "s"} (ade proof list)` : null],
    ]),
    ...paths.map((entry) => `file: ${entry}`),
  ].join("\n");
}

/* ── P1 agent suite text output ───────────────────────────────────────────── */

function seconds(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.round(ms / 100) / 10} s` : null;
}

function formatBytes(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatAndroidApps(value: unknown): string {
  const apps = records(record(value).apps);
  return renderTable(
    ["package", "launch activity", "ade installed"],
    apps.map((app) => [app.packageName, app.launchActivity, yesNo(app.adeInstalled)]),
    "No apps found on the emulator.",
    { fullColumns: ["package", "launch activity"] },
  );
}

function installLine(install: JsonObject): string {
  const how = install.method === "gradle" ? `Gradle ${asString(install.gradleTask) ?? ""}`.trimEnd() : `APK ${asString(install.apkPath) ?? ""}`.trimEnd();
  return `Installed ${asString(install.packageName) ?? "the app"} (${how}) in ${seconds(install.durationMs) ?? "?"}.`;
}

export function formatAndroidInstall(value: unknown): string {
  const install = record(value);
  return [
    installLine(install),
    `Open it: ade android launch --package ${asString(install.packageName) ?? "<name>"} --text`,
  ].join("\n");
}

export function formatAndroidLaunch(value: unknown): string {
  const launch = record(value);
  const install = isRecord(launch.install) ? launch.install : null;
  return [
    ...(install ? [installLine(install)] : []),
    // `activity` is the component (`pkg/.Main`) when the app's launcher named it.
    `Opened ${asString(launch.activity)?.includes("/") ? asString(launch.activity) : `${asString(launch.packageName) ?? "?"}/${asString(launch.activity) ?? "?"}`}`
      + `${typeof launch.totalTimeMs === "number" ? ` (started in ${launch.totalTimeMs} ms)` : ""}.`,
    "Check the screen: ade android snapshot --text",
  ].join("\n");
}

/** The element's name for a reader: its label, text or id. */
function elementName(element: JsonObject): string {
  const name = asString(element.label) ?? asString(element.text) ?? asString(element.identifier);
  return name ? JSON.stringify(name.length > 60 ? `${name.slice(0, 57)}...` : name) : "";
}

function elementFlags(element: JsonObject): string {
  return [
    element.clickable === true ? "tap" : null,
    element.longClickable === true ? "long-press" : null,
    element.scrollable === true ? "scroll" : null,
    element.focused === true ? "focused" : null,
    element.checked === true ? "checked" : null,
    element.selected === true ? "selected" : null,
    element.enabled === false ? "disabled" : null,
  ].filter(Boolean).join(",");
}

/**
 * `snapshot`: one row per element worth aiming at (named, or one that takes a
 * tap or a scroll). Layout-only containers are counted, not listed; `--json`
 * has them all.
 */
export function formatAndroidSnapshot(value: unknown): string {
  const snapshot = record(value);
  const elements = records(snapshot.elements);
  const shown = elements.filter((element) =>
    elementName(element) || element.clickable === true || element.scrollable === true || element.longClickable === true);
  const center = (element: JsonObject) => (isRecord(element.center) ? `${element.center.x},${element.center.y}` : null);
  const lines = [
    `${elements.length} elements on screen${asString(snapshot.foregroundPackage) ? ` (${asString(snapshot.foregroundPackage)})` : ""}, `
      + `read by ${asString(snapshot.source) ?? "?"} in ${snapshot.durationMs ?? "?"} ms${snapshot.cached === true ? " (cached; --fresh reads again)" : ""}.`,
    renderTable(
      ["ref", "role", "name", "center", "does"],
      shown.map((element) => [element.ref, element.role, elementName(element), center(element), elementFlags(element)]),
      "No elements to aim at.",
      { fullColumns: ["ref", "name"] },
    ),
  ];
  if (shown.length < elements.length) lines.push(`${elements.length - shown.length} layout elements with no name are not listed (--json lists every element).`);
  lines.push("Aim with --ref <ref> (or --label, --text, --identifier): ade android tap-element --ref <ref> --text");
  return lines.join("\n");
}

export function formatAndroidElement(value: unknown): string {
  const result = record(value);
  const match = isRecord(result.match) ? result.match : null;
  const element = match && isRecord(match.element) ? match.element : {};
  const where = isRecord(element.center) ? ` at (${element.center.x}, ${element.center.y})` : "";
  const ref = asString(match?.ref) ?? "?";
  const named = `${ref}${elementName(element) ? ` ${elementName(element)}` : ""}`;
  const action = asString(result.action) ?? "find";
  const lines: string[] = [];
  if (action === "tap") lines.push(`Tapped ${named}${where}.`);
  else if (action === "fill") {
    const typed = asString(result.typed);
    lines.push(`Filled ${named}: ${typed === "verified" ? "the field shows the text" : typed === "not-seen" ? "the field does NOT show the text" : "could not check the field"}.`);
    if (asString(result.typedDetail)) lines.push(asString(result.typedDetail)!);
  } else if (action === "wait") {
    lines.push(match ? `${named} is on screen${where} (waited ${seconds(result.waitedMs) ?? "?"}).` : `Gone from the screen (waited ${seconds(result.waitedMs) ?? "?"}).`);
  } else if (action === "assert") lines.push(`Visible: ${named}${where}.`);
  else lines.push(`Found ${named}${where}.`);
  if (typeof result.matchCount === "number" && result.matchCount > 1) {
    const others = records(result.others).map((other) => `${String(other.ref)} (--index ${String(other.index)})`);
    lines.push(`${result.matchCount} elements match; this is the first.${others.length ? ` Others: ${others.join(", ")}.` : ""}`);
  }
  if (asString(result.message)) lines.push(asString(result.message)!);
  return lines.join("\n");
}

export function formatAndroidLog(value: unknown): string {
  const log = record(value);
  // logcat's epoch seconds, read as the local time of day; the cursor stays epoch.
  const clock = (time: unknown): string => {
    const seconds = Number(time);
    if (!Number.isFinite(seconds)) return String(time);
    const date = new Date(seconds * 1000);
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  };
  const lines = records(log.lines).map((line) =>
    `${clock(line.time)} ${String(line.level)} ${String(line.tag)}(${String(line.pid)}): ${String(line.message)}`);
  return [
    ...(lines.length ? lines : [`No log lines${asString(log.packageName) ? ` from ${asString(log.packageName)}` : ""}.`]),
    ...(log.truncated === true ? ["(older lines left out; --lines <n> reads more)"] : []),
    ...(asString(log.cursor) ? [`next: ade android log --since ${asString(log.cursor)}${asString(log.packageName) ? ` --package ${asString(log.packageName)}` : ""} --text reads only newer lines`] : []),
  ].join("\n");
}

export function formatAndroidRecording(value: unknown): string {
  const recording = record(value);
  if (recording.active === true) {
    return [
      `Recording ${String(recording.id)} started${asString(recording.label) ? ` (${asString(recording.label)})` : ""}.`,
      "Stop it, and file it as proof: ade android record-stop --text",
    ].join("\n");
  }
  const segments = records(recording.segments);
  const ids = Array.isArray(recording.proofArtifactIds) ? recording.proofArtifactIds.filter((id) => typeof id === "string") : [];
  return [
    renderKeyValues("ADE Android recording", [
      ["id", recording.id],
      ["label", recording.label],
      ["length", seconds(recording.durationMs)],
      ["size", formatBytes(recording.bytes)],
      ["parts", segments.length > 1 ? `${segments.length} (the screen turned)` : null],
      ["stopped by", recording.stopReason === "requested" ? null : recording.stopReason],
      ["proof", ids.length ? `${ids.length} row${ids.length === 1 ? "" : "s"}` : null],
      ["error", recording.lastError],
    ]),
    // Printed raw: agents read these paths back, and the table shortens long values.
    ...segments.map((segment) => `file: ${String(segment.path)}`),
  ].join("\n");
}

export function formatAndroidRecordings(value: unknown): string {
  const recordings = records(record(value).recordings);
  return renderTable(
    ["id", "started", "length", "parts", "active", "label"],
    recordings.map((entry) => [
      entry.id,
      entry.startedAt,
      seconds(entry.durationMs),
      records(entry.segments).length || null,
      yesNo(entry.active),
      entry.label,
    ]),
    "No recordings in this lane. Start one: ade android record-start --text",
    { fullColumns: ["id"] },
  );
}

export function formatAndroidProofBundle(value: unknown): string {
  const bundle = record(value);
  return [
    `Proof bundle in ${String(bundle.dir)}${asString(bundle.proofArtifactId) ? ", filed as proof" : ""}.`,
    ...[bundle.screenshotPath, bundle.elementsPath, bundle.logPath, bundle.metaPath]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => `file: ${entry}`),
  ].join("\n");
}

/** `lease`: the token to keep (it alone renews and releases), or who has the device. */
export function formatAndroidLease(value: unknown): string {
  const result = record(appleLeaseAnswer(value));
  const device = isRecord(result.device) ? result.device : {};
  const name = asString(device.avdName) ? `the emulator ${asString(device.avdName)}` : "the lane's emulator";
  if (typeof result.released === "boolean") {
    return result.released
      ? `Released the lease on ${name}. The next agent in line, if any, has it now.`
      : asString(result.reason) ?? "Nothing was released: this token holds no lease (released already, lapsed, or not this lane's).";
  }
  if (typeof result.held === "boolean") {
    const current = isRecord(result.current) ? result.current : {};
    return result.held
      ? `${name[0]!.toUpperCase()}${name.slice(1)} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${String(result.queued ?? 0)} waiting.`
      : `${name[0]!.toUpperCase()}${name.slice(1)} is free: nobody holds its lease.`;
  }
  if (result.acquired === true) {
    const token = asString(result.token) ?? "<token>";
    return [
      `${result.renewed === true ? "Renewed" : "Got"} the lease on ${name} until ${asString(result.expiresAt) ?? "?"}.`,
      `token: ${token}`,
      `Keep the token. Renew: ade android lease renew --token ${token}. Release: ade android lease release --token ${token}.`,
    ].join("\n");
  }
  const current = isRecord(result.current) ? result.current : {};
  return result.sameHolder === true
    ? `Not granted: ${name} is leased under your own name (another agent of this chat, or a turn whose token you lost). Wait for it with --wait <seconds>.`
    : `Not granted: ${name} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${String(result.queued ?? 0)} waiting. Wait for it with --wait <seconds>.`;
}

/* ── P1 setup text output ─────────────────────────────────────────────────── */

/** One line for a running install, for `sdk install --wait` and `sdk cancel`. */
export function formatAndroidSdkInstallLine(state: JsonObject): string | null {
  if (state.state !== "running") return null;
  const done = typeof state.overallDone === "number" ? state.overallDone : 0;
  const total = typeof state.overallTotal === "number" && state.overallTotal > 0 ? state.overallTotal : null;
  const percent = total ? `${Math.floor((done / total) * 100)}%` : "?";
  const eta = typeof state.etaSeconds === "number" ? `, about ${Math.max(1, Math.round(state.etaSeconds))} s left` : "";
  const partNumber = typeof state.partIndex === "number" ? state.partIndex + 1 : "?";
  return `${state.cancelling === true ? "cancelling: " : ""}${percent} · ${String(state.partLabel)} (${partNumber} of ${String(state.partCount)}): ${String(state.step)} `
    + `${formatBytes(state.bytesDone) ?? "?"} of ${formatBytes(state.bytesTotal) ?? "?"}${eta}`;
}

export function formatAndroidSdkInstall(value: unknown): string {
  const state = record(value);
  const installed = Array.isArray(state.installed) && state.installed.length ? state.installed.join(", ") : "none";
  switch (state.state) {
    case "running":
      return [
        formatAndroidSdkInstallLine(state) ?? "Installing.",
        `Into ${String(state.sdkRoot)}. Follow it: ade android sdk status --text. Stop it: ade android sdk cancel.`,
      ].join("\n");
    case "done":
      return `Installed ${installed} into ${String(state.sdkRoot)}.\nnext: ade android status --text`;
    case "failed": {
      const error = isRecord(state.error) ? state.error : {};
      return `The install failed${asString(state.partId) ? ` at ${asString(state.partId)}` : ""}: ${String(error.code ?? "?")}: ${String(error.message ?? "")}\n`
        + `Finished parts stay: ${installed}. Run ade android sdk status --text, then install again.`;
    }
    case "cancelled":
      return `The install was cancelled. Finished parts stay: ${installed}.`;
    default:
      return "No Android SDK install runs on this machine.";
  }
}

export function formatAndroidSdkStatus(value: unknown): string {
  const plan = record(value);
  if (plan.hostSupported === false) return `This machine cannot run the Android emulator: ${asString(plan.unsupportedReason) ?? "unsupported"}.`;
  const parts = records(plan.parts);
  const missing = parts.filter((part) => part.missing === true);
  const missingIds = new Set(missing.map((part) => String(part.id)));
  const acceleration = isRecord(plan.acceleration) ? plan.acceleration : {};
  const lines = [
    renderTable(
      ["part", "found", "id"],
      parts.map((part) => [
        `${String(part.label)}${part.optional === true ? " (optional)" : ""}`,
        part.missing === true
          ? `missing · ${formatBytes(part.downloadBytes) ?? "?"}`
          : asString(part.installedVersion)
            ?? (part.optional === true ? "not asked for (--with-cli)" : "found"),
        part.id,
      ]),
      "No parts reported.",
      { fullColumns: ["part", "found"] },
    ),
    "",
    `install folder: ${String(plan.sdkRoot)} (${String(plan.sdkRootSource)})${plan.writable === false ? ` — not writable: ${asString(plan.writableDetail) ?? ""}` : ""}`,
    `space: needs ${formatBytes(plan.diskBytesNeeded) ?? "?"}, free ${formatBytes(plan.diskBytesFree) ?? "unknown"}`,
    `avd folder: ${asString(plan.avdHome) ?? "?"}${plan.avdHomeFreeBytes != null ? ` (free ${formatBytes(plan.avdHomeFreeBytes)})` : ""}`,
    `acceleration: ${acceleration.kind ? `${String(acceleration.kind)} (${acceleration.usable === true ? "usable" : "not usable"})` : acceleration.usable === true ? "usable" : "none"}`
      + `${asString(acceleration.detail) && acceleration.usable !== true ? ` — ${asString(acceleration.detail)}` : ""}`,
  ];
  if (asString(plan.repositoryError)) lines.push(`repository: ${asString(plan.repositoryError)} (sizes and versions may be missing)`);
  const licenses = records(plan.licenses).filter((license) =>
    Array.isArray(license.partIds) && license.partIds.some((id) => missingIds.has(String(id))));
  if (!missing.length) {
    lines.push("", "Every part is installed. Nothing to install.");
  } else {
    lines.push("", "licences the missing parts need:");
    lines.push(...(licenses.length
      ? licenses.map((license) => `  ${String(license.id)}  ${String(license.title)}${license.accepted === true ? "  (accepted before)" : ""}`)
      : ["  none"]));
    lines.push(
      "",
      "Read them: ade android sdk licenses --text. A person installs with: ade android sdk install "
        + [
          ...licenses.map((license) => `--accept-license ${String(license.id)}`),
          ...(plan.sdkRootSource === "chosen" ? [`--folder ${JSON.stringify(String(plan.sdkRoot))}`] : []),
          "--wait",
        ].join(" "),
    );
  }
  const install = isRecord(plan.install) ? plan.install : null;
  if (install && install.state === "running") lines.push("", `install running: ${formatAndroidSdkInstallLine(install) ?? ""}`);
  return lines.join("\n");
}

export function formatAndroidSdkLicenses(value: unknown): string {
  const licenses = records(record(value).licenses);
  if (!licenses.length) return "This setup needs no licences.";
  return licenses
    .map((license) => [
      `== ${String(license.id)}: ${String(license.title)}${license.accepted === true ? " (accepted before)" : ""} ==`,
      String(license.text ?? ""),
    ].join("\n"))
    .join("\n\n");
}
