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
 * table and the flag list are built at module scope from the shared contract
 * only.
 */
import path from "node:path";
import {
  ANDROID_EMULATOR_DOMAIN,
  ANDROID_HARDWARE_KEYS,
  ANDROID_ORIENTATIONS,
  type AndroidEmulatorErrorCode,
} from "../../desktop/src/shared/types/androidEmulator";
import { localRuntimeActionTimeoutMs } from "../../desktop/src/main/services/localRuntime/localRuntimeTimeoutPolicy";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  collectGenericObjectArgs,
  firstStandalonePositional,
  isRecord,
  listActionsStep,
  proofCallerRootArgs,
  readFlag,
  readNumberOption,
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

/* ──────────────────────────────────────────────────────────────────────────
   ANDROID EMULATOR — `ade android`.

   One emulator per lane, on the machine that runs the lane's brain. One
   spelling per verb and flag: `ade apple`'s where the job is the same
   (`status`, `devices`, `start`, `stop`, `screenshot`, `tap`, `swipe`,
   `button`, `type`, `show`); the device verbs are `create`, `attach` and
   `release`.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * `ade android`'s own value-carrying flags. Only flags read with
 * `readValue`/`readNumberOption` belong here; a boolean (`--keep`,
 * `--no-start`, `--profiles`) must stay out, or the next positional is
 * swallowed as its value.
 */
export const ANDROID_VALUE_FLAGS: readonly string[] = [
  "--arg",
  "--arg-json",
  "--avd",
  "--duration-ms",
  "--image",
  "--input",
  "--input-json",
  "--json-input",
  "--lane",
  "--lane-id",
  "--name",
  "--out",
  "--profile",
  "--set",
  "--set-json",
  "--value",
  "--x",
  "--y",
];

const ANDROID_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set(ANDROID_VALUE_FLAGS);

/** The next step for each coded refusal. Keyed on the contract's codes, so a new code needs a line. */
const ANDROID_ERROR_HINTS: Record<AndroidEmulatorErrorCode, string> = {
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
    "hint: another lane holds that AVD. Pick a free one (`ade android devices --text`), or make one: `ade android create --profile <id>`.",
  ANDROID_LANE_HAS_DEVICE:
    "hint: this lane already holds an AVD. Use it (`ade android start`), or `ade android release` it before you create or attach another.",
  ANDROID_AVD_RUNNING:
    "hint: that AVD already runs outside this lane. Close that emulator first, or attach another AVD.",
  ANDROID_NO_FREE_PORT:
    "hint: every emulator port (5554-5682) is in use. Stop an emulator you do not need, then try again.",
  ANDROID_BOOT_TIMEOUT:
    "hint: the emulator did not finish booting in time. Read the log it names, then run `ade android start` again.",
  ANDROID_EMULATOR_EXITED:
    "hint: the emulator quit. Read the log it names (`ade android status --text` shows the path).",
  ANDROID_STREAM_FAILED:
    "hint: the live view failed. `tap`, `key`, `text` and `screenshot` do not need it.",
  ANDROID_PATH_OUTSIDE_LANE:
    "hint: --out must be inside the lane worktree. Pass a path there, or leave out --out for a file under ADE's data folder.",
  ANDROID_NOT_RUNNING:
    "hint: boot the lane's emulator first: `ade android start`, or `ade android create --profile <id>` when the lane has none.",
};

const ANDROID_ERROR_HINT_ENTRIES = Object.entries(ANDROID_ERROR_HINTS) as Array<[AndroidEmulatorErrorCode, string]>;

/** The hint line for an `ANDROID_*: sentence` error, or null. */
export function androidEmulatorErrorHint(message: string): string | null {
  return ANDROID_ERROR_HINT_ENTRIES.find(([code]) => message.includes(`${code}:`))?.[1] ?? null;
}

/**
 * `--out` as an absolute path when the folder is this shell's: a relative path
 * means "from where this shell stands", as for any other command. It is sent
 * as typed when this shell has no lane, so a brain on another machine resolves
 * it against that lane's worktree instead of a folder that exists only here.
 */
function androidOutPath(value: string | null): string | null {
  if (!value || path.isAbsolute(value)) return value;
  return process.env.ADE_LANE_ID ? path.resolve(process.cwd(), value) : value;
}

function finiteNumber(raw: string | undefined, label: string, verb: string): number {
  const value = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(value)) {
    throw new CliUsageError(`android ${verb}: ${label} must be a number.`);
  }
  return value;
}

export function buildAndroidPlan(args: string[]): CliPlan {
  const sub = firstStandalonePositional(args, ANDROID_VALUE_CARRIER_FLAGS) ?? "status";
  const positionals = (): string[] => standalonePositionals(args, ANDROID_VALUE_CARRIER_FLAGS);
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
  ): CliPlan => {
    // Read before the step is built, so a timeout added to the shared table
    // reaches the CLI without a second edit.
    const minTimeoutMs = localRuntimeActionTimeoutMs(ANDROID_EMULATOR_DOMAIN, method);
    return {
      kind: "execute",
      label,
      formatter,
      steps: [actionStep("result", ANDROID_EMULATOR_DOMAIN, method, collectGenericObjectArgs(args, payload), callerRootArgs)],
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
  if (sub === "create") {
    const profileId = requireValue(readValue(args, ["--profile"]) ?? positionals()[0] ?? null, "--profile <hardware profile id>");
    const systemImage = readValue(args, ["--image"]);
    const displayName = readValue(args, ["--name"]);
    const noStart = readFlag(args, ["--no-start"]);
    return androidAction("android create", "createDevice", {
      ...laneClaim(),
      profileId,
      ...(systemImage ? { systemImage } : {}),
      ...(displayName ? { displayName } : {}),
      ...(noStart ? { start: false } : {}),
    }, "android-device", noStart ? {} : { progressNotice: bootNotice });
  }
  if (sub === "attach") {
    const avdName = requireValue(readValue(args, ["--avd"]) ?? positionals()[0] ?? null, "AVD name");
    const noStart = readFlag(args, ["--no-start"]);
    return androidAction("android attach", "attachDevice", {
      ...laneClaim(),
      avdName,
      ...(noStart ? { start: false } : {}),
    }, "android-device", noStart ? {} : { progressNotice: bootNotice });
  }
  if (sub === "start")
    return androidAction("android start", "start", laneClaim(), "android-device", { progressNotice: bootNotice });
  if (sub === "stop")
    return androidAction("android stop", "stop", laneClaim(), "android-device");
  if (sub === "release") {
    // An AVD ADE made for the lane is deleted on release; --keep keeps it on
    // disk. The user's own AVD is never deleted either way.
    const keep = readFlag(args, ["--keep"]);
    return androidAction("android release", "releaseDevice", {
      ...laneClaim(),
      ...(keep ? { deleteCreated: false } : {}),
    }, "android-release");
  }
  if (sub === "screenshot") {
    const outPath = androidOutPath(readValue(args, ["--out"]) ?? positionals()[0] ?? null);
    return androidAction("android screenshot", "screenshot", {
      ...laneClaim(),
      ...(outPath ? { outPath } : {}),
    }, "android-screenshot");
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
    const key = requireValue(readValue(args, ["--name"]) ?? positionals()[0] ?? null, "the button").toLowerCase();
    if (!(ANDROID_HARDWARE_KEYS as readonly string[]).includes(key)) {
      throw new CliUsageError(`android button: unknown button '${key}'. Valid buttons: ${ANDROID_HARDWARE_KEYS.join(", ")}.`);
    }
    return androidAction("android button", "sendKey", { ...laneClaim(), key }, "android-action", {
      shapeResult: done({ action: "button", key }),
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
  throw new CliUsageError(`Unknown android subcommand '${sub}'. Run 'ade android --help'.`);
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
    lines.push("", "next: ade android create --profile <id> (ade android devices --profiles lists them), or ade android attach <avd>");
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
    "No AVDs on this machine. Make one: ade android create --profile <id>.",
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
    ]),
    // Printed raw rather than as a table cell: agents Read this path back,
    // and the key/value renderer truncates long values.
    filePath ? `file: ${filePath}` : "",
  ].filter(Boolean).join("\n");
}

export function formatAndroidAction(value: unknown): string {
  const result = record(value);
  const action = asString(result.action) ?? "action";
  const detail = action === "tap"
    ? `(${result.x}, ${result.y})`
    : action === "swipe"
      ? `(${result.fromX}, ${result.fromY}) -> (${result.toX}, ${result.toY})`
      : action === "button" || action === "rotate"
        ? String(action === "button" ? result.key : result.orientation)
        : action === "type"
          ? `${result.characters} characters`
          : "";
  return `android ${action} ${detail}`.trimEnd() + " done";
}
