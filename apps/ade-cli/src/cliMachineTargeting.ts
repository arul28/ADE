import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatLaunchStatusLine } from "../../desktop/src/shared/chatLaunch";
import { CLOUD_LANE_MACHINE, followCloudLaneLaunch } from "../../desktop/src/shared/cloudLaneLaunch";
import { CLOUD_TIER_IDS, isCloudTierId } from "../../desktop/src/shared/cloudTiers";
import { parseLaneLinearIssueValue } from "../../desktop/src/shared/laneLinearIssue";
import { pullFileFromWorkCopy, pushFileToWorkCopy, withRemoteAndroidArgs, withRemoteAppleArgs, withRemoteShellArgs } from "./cliRemoteWork";
import { THIS_MACHINE_NAME } from "../../desktop/src/shared/machineIdentity";
import { pickLiveCheckout } from "../../desktop/src/shared/crossMachineHandoff";
import { gitRemoteIdentity } from "../../desktop/src/main/services/github/githubSshAlias";
import { samePathOnPlatform } from "../../desktop/src/shared/pathContainment";
import { PROOF_DUPLICATE_CODE } from "../../desktop/src/shared/proofProvenance";
import { androidStoreShotCaption } from "../../desktop/src/shared/androidDevicePresentation";
import {
  CLI_COMMAND_ALIASES,
  CliExecutionError,
  CliToolError,
  CliUsageError,
  VALUE_CARRIER_FLAGS,
  asString,
  automaticProjectRegistrationParams,
  connectMachineRuntimeDaemon,
  executePlan,
  firstStandalonePositional,
  formatChatLaunch,
  firstArray,
  getGitRemote,
  isMachineRuntimeScopedMethod,
  isRecord,
  renderTable,
  resolveMachineRuntimeSocketPath,
  resolveRoots,
  sessionIdFromCreateChatValue,
  unwrapToolResult,
  withProjectId,
  type CloudLaneLaunchDraft,
  type CliConnection,
  type CliPlan,
  type GlobalOptions,
  type JsonObject,
  type ParsedCli,
  type SocketJsonRpcClient,
} from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   OTHER MACHINES — `--machine`, `--all-machines`, `--machine a,b`.

   Every plan builder stays unaware of machines. The flags are read out of a
   supported command's arguments into the global options, and the connection
   layer sends each request to THIS machine's brain wrapped in `machines.call`;
   the brain forwards it over the agents' own paired connection. A list plan
   that declares `machineList` can be merged across every machine; a create
   plan that declares `machineFanOut` can run on several at once.
   See docs/features/sync-and-multi-device/cross-machine-agents.md.
   ────────────────────────────────────────────────────────────────────────── */

/** `ade apple` verbs that build the app: with --machine and no --lane they sync the work copy first. */
const APPLE_BUILD_VERBS: ReadonlySet<string> = new Set(["launch", "open", "install", "install-app", "test", "tests"]);

/** Commands that can run on another machine with `--machine`. */
const MACHINE_TARGETABLE_PRIMARIES: ReadonlySet<string> = new Set([
  "chat",
  "new",
  "lanes",
  "lane",
  "shell",
  "terminal",
  "projects",
  "apple",
  "mac-desktop",
  // `screen` and its Windows spellings run the same plan as `mac-desktop`.
  "screen",
  "windows-desktop",
  "windows-desk",
  "app-control",
  // The lane's Android emulator runs where that machine's brain runs.
  "android",
  "usage",
  // Only `ade files push|pull` (this chat's work copy there); see below.
  "files",
]);
/**
 * Commands whose own `--machine` flag means something else (a draft's sending
 * machine, the machine `ade machines` acts on). They keep the flag.
 */
const OWN_MACHINE_FLAG_PRIMARIES: ReadonlySet<string> = new Set(["drafts", "machines", "help"]);
/** Where `--project` means "the project on that machine" (apple uses it for an Xcode project). */
const MACHINE_PROJECT_ALIAS_PRIMARIES: ReadonlySet<string> = new Set(["chat", "lanes", "lane"]);
/** Flags whose value is free text that may itself look like a flag. */
export const FREE_TEXT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--text", "--prompt", "--message", "--note", "--title", "--reason"]);

/**
 * The flag names in `args`, skipping each value-carrying flag's value: in
 * `--prompt --cancel` the prompt is the text "--cancel", not a flag, and a
 * secret passed as `--value --machine` is a value too, not machine targeting.
 */
export function flagNamesOutsideFreeText(args: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    const name = token.split("=")[0]!;
    flags.add(name);
    // `--flag=value` carries its value inline; only a bare flag owns the next
    // token.
    if (!token.includes("=") && (FREE_TEXT_VALUE_FLAGS.has(name) || VALUE_CARRIER_FLAGS.has(name))) {
      index += 1;
    }
  }
  return flags;
}

/**
 * Pull `--machine <name>`, `--all-machines`, `--machine-project <sel>`,
 * `--clone` and (for chat and lanes, while targeting a machine)
 * `--project <sel>` out of a supported command's own arguments into the
 * global options. Unsupported commands keep their flags and fail as before.
 */
export function extractMachineTargeting(parsed: ParsedCli): ParsedCli {
  const typed = parsed.command[0]?.toLowerCase() ?? "";
  const primary = CLI_COMMAND_ALIASES[typed] ?? typed;
  if (!MACHINE_TARGETABLE_PRIMARIES.has(primary)) {
    // Left in place, the flag would be ignored and the command would quietly
    // answer for THIS machine, which reads as the other machine's answer.
    const flags = flagNamesOutsideFreeText(parsed.command);
    if (!OWN_MACHINE_FLAG_PRIMARIES.has(primary) && (flags.has("--machine") || flags.has("--all-machines"))) {
      if (typed.startsWith("-")) {
        throw new CliUsageError("Put --machine or --all-machines after the command: ade chat list --machine <name>.");
      }
      throw new CliUsageError(
        `ade ${typed} runs on this machine only; --machine and --all-machines don't apply to it. `
        + "Commands that run on another machine: chat, lanes, shell, terminal, projects, usage, apple, android, screen (mac-desktop, windows-desktop), app-control, files push|pull.",
      );
    }
    return parsed;
  }
  // `ade chat handoff <session> --machine X` moves a chat FROM here TO X: the
  // flag names the destination, so the command runs on this machine and is
  // never forwarded. The other handoff forms act on this machine's own move,
  // so --machine with them is a mistake, not a target.
  if (primary === "chat" && parsed.command[1]?.toLowerCase() === "handoff") {
    const flags = flagNamesOutsideFreeText(parsed.command);
    if (flags.has("--machine") && ["--cancel", "--retry", "--options"].some((flag) => flags.has(flag))) {
      throw new CliUsageError("--machine names the destination of a move; drop it for --cancel/--retry/--options.");
    }
    return parsed;
  }
  if (primary === "files") {
    // The other `ade files` verbs act on a workspace (a lane) here; with
    // --machine they would name a lane the other machine has never heard of.
    const flags = flagNamesOutsideFreeText(parsed.command);
    const verb = firstStandalonePositional(parsed.command.slice(1))?.toLowerCase() ?? "";
    if ((flags.has("--machine") || flags.has("--all-machines")) && verb !== "push" && verb !== "pull") {
      throw new CliUsageError(
        "On another machine, ade files only copies files: ade files push --machine <name> <local> <remote>, "
        + "or ade files pull --machine <name> <remote> <local>. Other file commands run on this machine.",
      );
    }
    if (flags.has("--all-machines")) throw new CliUsageError("ade files push and pull copy to one machine: use --machine <name>.");
  }
  const kept: string[] = [];
  let machine: string | null = null;
  let allMachines = false;
  let machineProject: string | null = null;
  let projectAlias: string | null = null;
  let machineClone = false;
  let cloudSize: string | null = null;
  let workCopySync: "none" | "discard" | null = null;
  let terminatorArgs: string[] | null = null;
  const command = parsed.command;
  // A shell start or an Apple build with --machine runs in this chat's work
  // copy there unless --lane names a lane there; only those take --no-sync
  // and --discard (`ade apple record-stop --discard` keeps its own meaning).
  const commandFlags = flagNamesOutsideFreeText(command);
  // The subcommand wherever it sits (`ade shell --machine m start …`).
  const subcommand = firstStandalonePositional(command.slice(1))?.toLowerCase() ?? "";
  const workCopyVerb = commandFlags.has("--machine")
    && ((primary === "shell" && (subcommand === "start" || subcommand === "create"))
      || (primary === "apple" && APPLE_BUILD_VERBS.has(subcommand)));
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (token === "--") {
      terminatorArgs = command.slice(index + 1);
      kept.push(...command.slice(index));
      break;
    }
    if (FREE_TEXT_VALUE_FLAGS.has(token) && index + 1 < command.length) {
      kept.push(token, command[index + 1]!);
      index += 1;
      continue;
    }
    const [flag, inline] = token.startsWith("--") && token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, null];
    const takeValue = (): string => {
      const value = inline ?? command[index + 1];
      if (inline == null) index += 1;
      if (!value?.trim() || (inline == null && value.startsWith("--"))) {
        throw new CliUsageError(`${flag} requires a value.`);
      }
      return value.trim();
    };
    if (flag === "--machine") { machine = takeValue(); continue; }
    if (flag === "--machine-project") { machineProject = takeValue(); continue; }
    if (flag === "--all-machines" && inline == null) { allMachines = true; continue; }
    if (flag === "--clone" && inline == null && primary === "chat") { machineClone = true; continue; }
    // The size of a new ADE Cloud computer (`--machine cloud`); no chat or lane verb has a --size of its own.
    if (flag === "--size" && MACHINE_PROJECT_ALIAS_PRIMARIES.has(primary)) { cloudSize = takeValue(); continue; }
    if ((flag === "--no-sync" || flag === "--discard") && inline == null && workCopyVerb) {
      if (workCopySync) throw new CliUsageError("Use --no-sync or --discard, not both.");
      workCopySync = flag === "--no-sync" ? "none" : "discard";
      continue;
    }
    if (flag === "--project" && MACHINE_PROJECT_ALIAS_PRIMARIES.has(primary)) {
      projectAlias = takeValue();
      continue;
    }
    kept.push(token);
  }
  if (projectAlias && !machine && !allMachines) {
    throw new CliUsageError("--project picks the project on another machine; add --machine <name>, or use --project-root here.");
  }
  if (machine && allMachines) throw new CliUsageError("Use --machine <name> or --all-machines, not both.");
  if (machineClone && !machine) throw new CliUsageError("--clone sets the repository up on another machine; add --machine <name>.");
  const usesWorkCopy = workCopyVerb && !commandFlags.has("--lane") && !commandFlags.has("--lane-id");
  if (workCopySync && !usesWorkCopy) {
    throw new CliUsageError("--no-sync and --discard are for this chat's work copy there; leave out --lane to use it.");
  }
  if (machineProject && !machine && !allMachines) throw new CliUsageError("--machine-project needs --machine <name>.");
  const cloudLane = isCloudLaneMachineSelector(machine);
  if (cloudSize !== null && !cloudLane) {
    throw new CliUsageError("--size picks the size of a new ADE Cloud computer: add --machine cloud.");
  }
  const sizeId = cloudSize === null ? null : cloudSize.toLowerCase().replace(/[\s-]+/g, "");
  if (sizeId !== null && !isCloudTierId(sizeId)) {
    throw new CliUsageError(`--size must be one of: ${CLOUD_TIER_IDS.join(", ")}.`);
  }
  if (cloudLane && (machineProject || projectAlias)) {
    throw new CliUsageError("--machine cloud makes a new lane for this project on its own computer: leave out --project and --machine-project.");
  }
  if (cloudLane && machineClone) {
    throw new CliUsageError("--machine cloud always gets the repository on the new computer: leave out --clone.");
  }
  if (machine && !cloudLane && machine.split(",").some((entry) => isCloudLaneMachineSelector(entry))) {
    throw new CliUsageError("--machine cloud makes one new computer for one lane: don't list other machines with it.");
  }
  if (!machine && primary === "shell") {
    const flags = flagNamesOutsideFreeText(parsed.command);
    if (subcommand === "clean") {
      throw new CliUsageError("ade shell clean deletes this chat's work copy on another machine: add --machine <name>.");
    }
    const workCopyFlag = ["--no-sync", "--discard", "--wait"].find((flag) => flags.has(flag));
    if (workCopyFlag) {
      throw new CliUsageError(`${workCopyFlag} is for a command on another machine: add --machine <name>. Here, run the command in your own shell.`);
    }
  }
  if (!machine && !allMachines) return parsed;
  return {
    command: kept,
    options: {
      ...parsed.options,
      machine,
      allMachines,
      machineProject: machineProject ?? projectAlias,
      machineClone,
      // No --size stays null: the brain picks the person's saved size for new lanes.
      ...(cloudLane ? { cloudSize: sizeId } : {}),
      ...(usesWorkCopy
        ? {
            machineWorkCopy: {
              sync: workCopySync,
              // A shell command's argv (after `--`), sent as argv so the other
              // machine renders it for its own shell.
              argv: primary === "shell" ? terminatorArgs : null,
            },
          }
        : {}),
    },
  };
}

/**
 * Where a request runs on the other machine. Personal-chat methods go to its
 * projectless scope, `projects.*` to the machine itself, and everything else to
 * a project there: the one named with `--project`, or by default the checkout
 * of this repository (matched by normalized git origin).
 */
function machineCallScopeFor(
  method: string,
  params: JsonObject | undefined,
  options: GlobalOptions,
  localOriginUrl: () => string | null,
): JsonObject {
  if (method.startsWith("personalChats.")) return { kind: "personal" };
  if (method.startsWith("projects.")) return { kind: "machine" };
  const selector = options.machineProject?.trim();
  if (selector) return { kind: "project", selector };
  if (isMachineWideAction(method, params)) {
    // The machine's quota is the same from every project there, so a machine
    // without this repository can still answer. Sent as a `repo` scope that
    // allows any project: a brain older than `anyProject` still reads the repo
    // part instead of refusing the whole scope.
    const originUrl = localOriginUrl();
    return originUrl ? { kind: "repo", originUrl, orAnyProject: true } : { kind: "anyProject", originUrl: null };
  }
  const originUrl = localOriginUrl();
  if (!originUrl) {
    throw new CliUsageError(
      "This directory has no git origin, so ADE can't tell which project to use on the other machine. Pass --project <name|path|id>.",
    );
  }
  return { kind: "repo", originUrl };
}

/**
 * Actions that answer for the whole machine (its provider quota), whichever of
 * its projects they run in.
 */
const MACHINE_WIDE_ACTIONS: ReadonlySet<string> = new Set(["usage.getUsageLimits", "usage.getUsageSnapshot"]);

function isMachineWideAction(method: string, params: JsonObject | undefined): boolean {
  if (method !== "ade/actions/call" || !params || params.name !== "run_ade_action" || !isRecord(params.arguments)) return false;
  const { domain, action } = params.arguments;
  return typeof domain === "string" && typeof action === "string" && MACHINE_WIDE_ACTIONS.has(`${domain}.${action}`);
}

/** The most a proof command reads back from another machine for one capture. */
const MAX_REMOTE_CAPTURE_BYTES = 512 * 1024 * 1024;

/** Paths that name THIS machine's checkout mean nothing over there. */
const LOCAL_PATH_KEYS = ["projectRoot", "workspaceRoot", "callerRoot", "callerRootSource"];

function withoutLocalPaths(params: JsonObject | undefined): JsonObject {
  if (!params) return {};
  const strip = (record: JsonObject): JsonObject => {
    const copy: JsonObject = { ...record };
    for (const key of LOCAL_PATH_KEYS) delete copy[key];
    return copy;
  };
  if (!isRecord(params.arguments)) return strip(params);
  const toolArgs = strip(params.arguments);
  if (isRecord(toolArgs.args)) toolArgs.args = strip(toolArgs.args);
  return { ...params, arguments: toolArgs };
}

/**
 * A connection whose every request runs on another machine on the account.
 *
 * It talks only to THIS machine's brain, which owns the agents' paired
 * connections: each request is wrapped in `machines.call` and forwarded
 * unchanged. Nothing is registered here, except when a proof command files
 * its capture: that runs over there, its bytes are read back, and the proof
 * is filed in THIS chat's drawer.
 */
export async function createMachineRemoteConnection(
  options: GlobalOptions,
  machine: string,
): Promise<CliConnection> {
  if (options.headless) {
    throw new CliUsageError("--machine needs this machine's ADE brain; remove --headless.");
  }
  const roots = resolveRoots(options);
  const socketPathOverride = options.socketPath?.trim() || null;
  const socketPath = await resolveMachineRuntimeSocketPath(socketPathOverride);
  const socketClient = await connectMachineRuntimeDaemon(options, socketPathOverride);
  let originCache: { value: string | null } | null = null;
  const localOriginUrl = (): string | null => {
    originCache ??= { value: getGitRemote(roots.projectRoot) };
    return originCache.value;
  };

  /** The other machine's answer, and its display name when the brain says it. */
  const callRemoteAnswer = async (method: string, params?: JsonObject): Promise<{ result: unknown; machineName: string | null }> => {
    const answer = await socketClient.request("machines.call", {
      machine,
      scope: machineCallScopeFor(method, params, options, localOriginUrl),
      request: { method, params: withoutLocalPaths(params) },
      timeoutMs: options.timeoutMs,
      ...(options.machineClone ? { clone: true } : {}),
    });
    const machineName = isRecord(answer) && isRecord(answer.machine) ? asString(answer.machine.name) : null;
    return { result: isRecord(answer) && "result" in answer ? answer.result : answer, machineName };
  };
  const callRemote = async (method: string, params?: JsonObject): Promise<unknown> =>
    (await callRemoteAnswer(method, params)).result;

  /** The primary lane of the project there (cloned first under --clone, like any call). */
  const remotePrimaryLaneId = async (): Promise<string> => {
    const listed = unwrapToolResult(await callRemote("ade/actions/call", { name: "list_lanes", arguments: {} }));
    const lanes = isRecord(listed) && Array.isArray(listed.lanes) ? listed.lanes : listed;
    const primary = Array.isArray(lanes) ? lanes.find((lane) => isRecord(lane) && lane.laneType === "primary") : null;
    const laneId = isRecord(primary) ? asString(primary.id) : null;
    if (!laneId) {
      throw new CliUsageError(
        `The project on ${machine} has no primary lane to start the chat in. Pass --lane <lane there> (see \`ade lanes list --machine ${JSON.stringify(machine)}\`).`,
      );
    }
    return laneId;
  };

  let localProjectId: string | null = null;
  const callLocalProject = async (method: string, params: JsonObject): Promise<unknown> => {
    if (!localProjectId) {
      const registered = await socketClient.request(
        "projects.add",
        automaticProjectRegistrationParams(roots.projectRoot),
      );
      localProjectId = isRecord(registered) ? asString(registered.projectId) : null;
      if (!localProjectId) throw new Error("This machine's brain did not register the project to file proof in.");
    }
    return await socketClient.request(method, withProjectId(params, localProjectId));
  };

  const fetchRemoteCapture = async (remotePath: string, tempDir: string, index: number): Promise<string> => {
    // The name only (the path is the other machine's, in its own separator),
    // numbered so two captures with one name cannot overwrite each other.
    const localPath = path.join(tempDir, `${index}-${path.basename(remotePath.replace(/\\/g, "/"))}`);
    const handle = fs.openSync(localPath, "w");
    try {
      let offset = 0;
      for (;;) {
        const chunk = unwrapToolResult(await callRemote("ade/actions/call", {
          name: "read_remote_caller_capture",
          arguments: { path: remotePath, offset },
        }));
        if (!isRecord(chunk) || typeof chunk.dataBase64 !== "string" || chunk.offset !== offset) {
          throw new Error(`${machine} did not return the capture at ${remotePath}.`);
        }
        const bytes = Buffer.from(chunk.dataBase64, "base64");
        if (offset + bytes.length > MAX_REMOTE_CAPTURE_BYTES) {
          throw new Error(`${machine}'s capture at ${remotePath} is over ${MAX_REMOTE_CAPTURE_BYTES / (1024 * 1024)} MiB; it stays there.`);
        }
        fs.writeSync(handle, bytes, 0, bytes.length, offset);
        offset += bytes.length;
        if (chunk.done === true || bytes.length === 0) break;
      }
    } finally {
      fs.closeSync(handle);
    }
    return localPath;
  };

  const fileRemoteCapturesHere = async (params: JsonObject): Promise<unknown> => {
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    const inputs = Array.isArray(toolArgs.inputs) ? toolArgs.inputs.filter(isRecord) : [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-proof-"));
    try {
      const localInputs: JsonObject[] = [];
      for (const [index, input] of inputs.entries()) {
        const remotePath = asString(input.path);
        if (!remotePath) {
          localInputs.push(input);
          continue;
        }
        localInputs.push({
          ...input,
          path: await fetchRemoteCapture(remotePath, tempDir, index),
          metadata: { ...(isRecord(input.metadata) ? input.metadata : {}), capturedOnMachine: machine },
        });
      }
      return await callLocalProject("ade/actions/call", {
        ...params,
        arguments: { ...toolArgs, inputs: localInputs, callerRoot: process.cwd() },
      });
    } finally {
      // The proof is filed (copied into the store) or it failed; either way the
      // copies are scratch. A scanner holding one on Windows must not turn a
      // filed proof into an error.
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Left in the OS temp dir, which the OS reclaims.
      }
    }
  };

  /**
   * App Control files its proof where it runs (`captureProof`), which on
   * another machine is that machine's drawer. Instead, observe the app there
   * (a capture registered to this caller), read the frame back, and file it
   * here like any other remote capture. This lives in the connection rather
   * than the `app-control proof` plan because plan builders are deliberately
   * unaware of machines: the same plan runs here or anywhere.
   */
  const fileRemoteAppControlProofHere = async (params: JsonObject): Promise<unknown> => {
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    const proofArgs = isRecord(toolArgs.args) ? toolArgs.args : {};
    const caption = asString(proofArgs.caption);
    const { caption: _caption, ...observeArgs } = proofArgs;
    const observed = unwrapToolResult(await callRemote("ade/actions/call", {
      name: "run_ade_action",
      arguments: {
        ...toolArgs,
        action: "observe",
        args: { ...observeArgs, includeDom: false, includeDiagnostics: false },
      },
    }));
    const shot = isRecord(observed) && isRecord(observed.result) ? observed.result : observed;
    const filePath = isRecord(shot) ? asString(shot.filePath) : null;
    if (!filePath) throw new Error(`${machine} took no App Control screenshot to file.`);
    const title = caption ?? `App Control screenshot · ${asString(isRecord(shot) ? shot.title : null) ?? machine}`;
    return await fileRemoteCapturesHere({
      name: "ingest_computer_use_artifacts",
      arguments: {
        backendStyle: "manual",
        backendName: "ade-app-control",
        toolName: "app-control proof",
        inputs: [{ kind: "screenshot", title, description: title, path: filePath }],
      },
    });
  };

  /**
   * The Apple verbs that file proof (`screenshot`, `captureProofBundle`,
   * `duoAppStoreScreenshots`, `recordStop`) file it where they run, which on
   * another machine is that machine's drawer: the chat would cite an id its
   * own machine has never heard of. So the verb runs there with `proof: false`,
   * the files it made are read back, and each is filed in THIS chat's drawer;
   * the answer carries the ids filed here.
   */
  const fileOneRemoteAppleCaptureHere = async (
    where: string,
    input: { kind: "screenshot" | "video_recording"; title: string; description: string; path: string; mimeType: string; metadata: JsonObject },
    toolName: string,
  ): Promise<string | null> => {
    try {
      const filed = unwrapToolResult(await fileRemoteCapturesHere({
        name: "ingest_computer_use_artifacts",
        arguments: { backendStyle: "manual", backendName: "ade-ios-simulator", toolName, inputs: [input] },
      }));
      return firstFiledArtifactId(filed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Bytes read back are filed as an attach, so a screen that has not
      // changed since the last shot is refused as a duplicate; that earlier
      // proof shows exactly these pixels, so it is the one to cite.
      const duplicateOf = message.includes(PROOF_DUPLICATE_CODE)
        ? /ade-proof:\/\/([0-9a-f-]{36})/iu.exec(message)?.[1] ?? null
        : null;
      // The capture is what was asked for; a drawer that refused it is said, not thrown.
      if (!duplicateOf) process.stderr.write(`Could not file the ${toolName} capture from ${where} as proof here: ${message}\n`);
      return duplicateOf;
    }
  };

  const fileRemoteAppleProofHere = async (params: JsonObject, action: AppleProofAction): Promise<unknown> => {
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    const actionArgs = isRecord(toolArgs.args) ? toolArgs.args : {};
    const { result: answer, machineName } = await callRemoteAnswer("ade/actions/call", {
      ...params,
      arguments: { ...toolArgs, args: { ...actionArgs, proof: false } },
    });
    if (isRecord(answer) && (answer.isError === true || answer.ok === false)) return answer;
    const record = appleActionResult(answer);
    if (!record) return answer;
    const where = machineName ?? machine;
    const capturedAt = asString(record.capturedAt);
    const caption = asString(actionArgs.caption);
    const stillInput = (filePath: string, title: string, metadata: JsonObject) => ({
      kind: "screenshot" as const,
      title,
      description: `Screen of the Apple device on ${where}${capturedAt ? ` at ${capturedAt}` : ""}.`,
      path: filePath,
      mimeType: "image/png",
      metadata,
    });

    if (action === "screenshot" || action === "captureProofBundle") {
      const filePath = asString(action === "screenshot" ? record.filePath : record.screenshotPath);
      if (!filePath) return answer;
      const title = caption ?? `${action === "screenshot" ? "Simulator screenshot" : "Simulator proof bundle"} · ${where}`;
      const proofArtifactId = await fileOneRemoteAppleCaptureHere(where, stillInput(filePath, title, {
        udid: asString(record.deviceUdid),
        width: typeof record.width === "number" ? record.width : null,
        height: typeof record.height === "number" ? record.height : null,
        capturedAt,
        ...(action === "captureProofBundle" && asString(record.dir) ? { bundleDir: asString(record.dir) } : {}),
      }), action === "screenshot" ? "apple screenshot" : "apple proof-bundle");
      return withAppleActionResult(answer, { ...record, proofArtifactId });
    }

    if (action === "duoAppStoreScreenshots") {
      const shots = Array.isArray(record.shots) ? record.shots.filter(isRecord) : [];
      const filedShots: JsonObject[] = [];
      for (const shot of shots) {
        const filePath = asString(shot.filePath);
        const display = asString(shot.display) ?? "panel";
        const width = typeof shot.width === "number" ? shot.width : 0;
        const height = typeof shot.height === "number" ? shot.height : 0;
        const proofArtifactId = filePath
          ? await fileOneRemoteAppleCaptureHere(where, stillInput(filePath, `App Store · iPhone Duo ${display} display ${width}×${height} · ${where}`, { display, width, height }), "apple app-store-shots")
          : null;
        filedShots.push({ ...shot, proofArtifactId });
      }
      return withAppleActionResult(answer, { ...record, shots: filedShots });
    }

    // recordStop: a discarded or failed recording has no file to file.
    const videoPath = asString(record.path);
    if (!videoPath || actionArgs.discard === true || asString(record.lastError)) return answer;
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : null;
    const proofArtifactId = await fileOneRemoteAppleCaptureHere(where, {
      kind: "video_recording",
      title: asString(record.label) ?? `Simulator recording · ${where}`,
      description: `Screen recording of the Apple device on ${where}.`,
      path: videoPath,
      mimeType: "video/mp4",
      metadata: { udid: asString(record.udid), durationMs, recordingId: asString(record.id) },
    }, "apple record-stop");
    return withAppleActionResult(answer, { ...record, proof: proofArtifactId != null, proofArtifactId });
  };

  /**
   * The Android verbs that file proof (`screenshot`, `captureProofBundle`,
   * `recordStop`, `requestRender`, `renderComposePreviews`), on the Apple rule above: run there with
   * `proof: false`, read each file back, file it in THIS chat's drawer, and
   * answer the ids filed here.
   */
  const fileRemoteAndroidProofHere = async (params: JsonObject, action: AndroidProofAction): Promise<unknown> => {
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    const actionArgs = isRecord(toolArgs.args) ? toolArgs.args : {};
    const { result: answer, machineName } = await callRemoteAnswer("ade/actions/call", {
      ...params,
      arguments: { ...toolArgs, args: { ...actionArgs, proof: false } },
    });
    if (isRecord(answer) && (answer.isError === true || answer.ok === false)) return answer;
    const record = appleActionResult(answer);
    if (!record) return answer;
    const where = machineName ?? machine;
    const caption = asString(actionArgs.caption);
    const fileOne = async (input: { kind: "screenshot" | "video_recording"; title: string; description: string; path: string; mimeType: string; metadata: JsonObject }, toolName: string) => {
      try {
        const filed = unwrapToolResult(await fileRemoteCapturesHere({
          name: "ingest_computer_use_artifacts",
          arguments: { backendStyle: "manual", backendName: "android-emulator", toolName, inputs: [input] },
        }));
        return firstFiledArtifactId(filed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const duplicateOf = message.includes(PROOF_DUPLICATE_CODE)
          ? /ade-proof:\/\/([0-9a-f-]{36})/iu.exec(message)?.[1] ?? null
          : null;
        if (!duplicateOf) process.stderr.write(`Could not file the ${toolName} capture from ${where} as proof here: ${message}\n`);
        return duplicateOf;
      }
    };
    if (action === "screenshot" || action === "captureProofBundle") {
      const filePath = asString(action === "screenshot" ? record.path : record.screenshotPath);
      if (!filePath) return answer;
      const capturedAt = asString(record.capturedAt);
      const proofArtifactId = await fileOne({
        kind: "screenshot",
        title: caption ?? `${action === "screenshot" ? "Android emulator screenshot" : "Android emulator proof bundle"} · ${where}`,
        description: `Screen of the Android emulator on ${where}${capturedAt ? ` at ${capturedAt}` : ""}.`,
        path: filePath,
        mimeType: "image/png",
        metadata: {
          width: typeof record.width === "number" ? record.width : null,
          height: typeof record.height === "number" ? record.height : null,
          capturedAt,
          ...(action === "captureProofBundle" && asString(record.dir) ? { bundleDir: asString(record.dir) } : {}),
        },
      }, action === "screenshot" ? "android screenshot" : "android proof-bundle");
      return withAppleActionResult(answer, { ...record, proofArtifactId });
    }
    if (action === "requestRender") {
      const paths = Array.isArray(record.paths) ? record.paths.map(asString).filter((entry): entry is string => entry != null) : [];
      const ids: string[] = [];
      for (const filePath of paths) {
        const video = /\.(mp4|webm|mov)$/iu.test(filePath);
        const id = await fileOne({
          kind: video ? "video_recording" : "screenshot",
          title: `Android device render · ${where}`,
          description: `3D render of the lane's Android device on ${where}.`,
          path: filePath,
          mimeType: video ? (filePath.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4") : "image/png",
          metadata: {},
        }, "android render");
        if (id) ids.push(id);
      }
      return withAppleActionResult(answer, { ...record, filed: ids.length, proofArtifactIds: ids });
    }
    if (action === "storeScreenshots") {
      // Parity: each Play Store screenshot made there is one still here.
      const shots = Array.isArray(record.shots) ? record.shots.filter(isRecord) : [];
      const filed = [];
      for (const shot of shots) {
        const shotPath = asString(shot.filePath);
        const display = asString(shot.display);
        const proofArtifactId = shotPath
          ? await fileOne({
            kind: "screenshot",
            title: `${androidStoreShotCaption(asString(shot.slot), display, shot.width, shot.height)} · ${where}`,
            description: `Play Store screenshot of the Android emulator on ${where}.`,
            path: shotPath,
            mimeType: "image/png",
            metadata: { width: shot.width ?? null, height: shot.height ?? null, slot: asString(shot.slot), display },
          }, "android play-store-shots")
          : null;
        filed.push({ ...shot, proofArtifactId });
      }
      return withAppleActionResult(answer, { ...record, shots: filed });
    }
    if (action === "renderComposePreviews") {
      // P3: each Compose preview the CLI drew there is one still here.
      const module = asString(record.module);
      const images = Array.isArray(record.images) ? record.images.filter(isRecord) : [];
      const filed = [];
      for (const image of images) {
        const imagePath = asString(image.path);
        const fqn = asString(image.fqn) ?? "";
        const proofArtifactId = imagePath
          ? await fileOne({
            kind: "screenshot",
            title: `Compose preview: ${asString(image.name) ?? fqn.split(".").pop() ?? "preview"} · ${where}`,
            description: `${fqn}, rendered from ${module ?? "the lane's module"} on ${where} with no emulator.`,
            path: imagePath,
            mimeType: "image/png",
            metadata: { fqn, module },
          }, "android preview")
          : null;
        filed.push({ ...image, proofArtifactId });
      }
      return withAppleActionResult(answer, { ...record, images: filed });
    }
    // recordStop: a discarded or failed recording has no file to file; each part is one video.
    const segments = Array.isArray(record.segments) ? record.segments.filter(isRecord) : [];
    if (actionArgs.discard === true || segments.length === 0) return answer;
    const ids: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const videoPath = asString(segment.path);
      if (!videoPath) continue;
      const part = segments.length > 1 ? ` (part ${index + 1} of ${segments.length})` : "";
      const id = await fileOne({
        kind: "video_recording",
        title: `${asString(record.label) ?? `Android emulator recording · ${where}`}${part}`,
        description: `Screen recording of the Android emulator on ${where}.`,
        path: videoPath,
        mimeType: "video/mp4",
        metadata: {
          recordingId: asString(record.id),
          durationMs: typeof record.durationMs === "number" ? record.durationMs : typeof segment.durationMs === "number" ? segment.durationMs : null,
          ...(typeof record.wallDurationMs === "number" ? { wallDurationMs: record.wallDurationMs } : {}),
          ...(typeof record.idleCutMs === "number" ? { idleCutMs: record.idleCutMs } : {}),
          // The demo's chapters and how it was made, as a local stop files them.
          ...(isRecord(record.demo) ? { demo: record.demo } : {}),
          ...(segments.length > 1 ? { part: index + 1 } : {}),
        },
      }, "android record-stop");
      if (id) ids.push(id);
    }
    return withAppleActionResult(answer, { ...record, proofArtifactIds: ids });
  };

  return {
    mode: "runtime-socket",
    projectRoot: roots.projectRoot,
    workspaceRoot: roots.workspaceRoot,
    socketPath,
    request: async (method, params) => {
      if (isMachineRuntimeScopedMethod(method) && !method.startsWith("projects.") && !method.startsWith("personalChats.")) {
        // Connection housekeeping (`ade/initialize`, `ping`, …) is this
        // brain's business, not the other machine's.
        return await socketClient.request(method, params);
      }
      if (method === "ade/actions/call" && params?.name === "ingest_computer_use_artifacts") {
        return await fileRemoteCapturesHere(params);
      }
      if (method === "ade/actions/call" && params && isAppControlCaptureProof(params)) {
        return await fileRemoteAppControlProofHere(params);
      }
      if (method === "ade/actions/call" && params?.name === "work_copy_file" && isRecord(params.arguments)
        && (params.arguments.op === "push" || params.arguments.op === "pull")) {
        // `ade files push|pull`: run here as a series of chunk steps there.
        const transfer = params.arguments;
        let machineName: string | null = null;
        const call = async (args: JsonObject): Promise<unknown> => {
          const answer = await callRemoteAnswer(method, { name: "work_copy_file", arguments: args });
          machineName ??= answer.machineName;
          return unwrapToolResult(answer.result);
        };
        try {
          const result = transfer.op === "push"
            ? await pushFileToWorkCopy(call, {
              localPath: asString(transfer.localPath) ?? "",
              remotePath: asString(transfer.remotePath) ?? "",
              // The checkout whose commit makes the copy there, as for a shell.
              checkout: roots.workspaceRoot,
            })
            : await pullFileFromWorkCopy(call, {
              remotePath: asString(transfer.remotePath) ?? "",
              localPath: asString(transfer.localPath) ?? "",
            });
          return { ...result, machine: machineName ?? machine };
        } catch (error) {
          if (error instanceof CliUsageError || error instanceof CliToolError) throw error;
          throw new CliToolError(error instanceof Error ? error.message : String(error), { machine });
        }
      }
      if (method === "ade/actions/call" && params && isShellOrTerminalAction(params)) {
        // The checkout the command runs from: the lane worktree, or the project
        // --project-root names (whose remote picked the project there).
        const shellParams = withRemoteShellArgs(params, roots.workspaceRoot, options.machineWorkCopy ?? null);
        try {
          return await callRemote(method, shellParams);
        } catch (error) {
          // The other machine said no (busy copy, unpushed work there, low
          // disk): its sentence is the whole answer, not a connection problem.
          throw new CliToolError(error instanceof Error ? error.message : String(error), { machine });
        }
      }
      if (method === "ade/actions/call" && params?.name === "run_ade_action" && isRecord(params.arguments) && params.arguments.domain === "ios_simulator") {
        const appleParams = withRemoteAppleArgs(params, roots.workspaceRoot, options.machineWorkCopy ?? null);
        const proofAction = appleActionFiledAsProof(appleParams);
        if (proofAction) return await fileRemoteAppleProofHere(appleParams, proofAction);
        return await callRemote(method, appleParams);
      }
      if (method === "ade/actions/call" && params?.name === "run_ade_action" && isRecord(params.arguments) && params.arguments.domain === "android_emulator") {
        const androidParams = withRemoteAndroidArgs(params, roots.workspaceRoot);
        const proofAction = androidActionFiledAsProof(androidParams);
        if (proofAction) return await fileRemoteAndroidProofHere(androidParams, proofAction);
        return await callRemote(method, androidParams);
      }
      if (method === "ade/actions/call" && (params?.name === "list_computer_use_artifacts" || params?.name === "review_computer_use_artifact")) {
        // A proof command's verify step checks the drawer it filed into, and a
        // review reads proof from it: this one.
        return await callLocalProject(method, params);
      }
      if (method === "ade/actions/call" && params && chatCreateCallWithoutLane(params)) {
        // Lane ids are per machine, so a chat create that names none starts
        // in the primary lane there: the project's main checkout.
        return await callRemote(method, withChatCreateLane(params, await remotePrimaryLaneId()));
      }
      return await callRemote(method, params);
    },
    close: () => socketClient.close(),
  };
}

function isShellOrTerminalAction(params: JsonObject): boolean {
  const toolArgs = isRecord(params.arguments) ? params.arguments : null;
  return params.name === "run_ade_action" && (toolArgs?.domain === "pty" || toolArgs?.domain === "terminal");
}

const APPLE_PROOF_ACTIONS = ["screenshot", "captureProofBundle", "duoAppStoreScreenshots", "recordStop"] as const;
type AppleProofAction = (typeof APPLE_PROOF_ACTIONS)[number];

/**
 * An Apple action the device's machine would file as proof, so a `--machine`
 * call files it here instead. A caller that already sent `proof: false` (the
 * `proof` plan's own screenshot step, `--no-proof`) files nothing at all.
 */
function appleActionFiledAsProof(params: JsonObject): AppleProofAction | null {
  const toolArgs = isRecord(params.arguments) ? params.arguments : null;
  const args = toolArgs && isRecord(toolArgs.args) ? toolArgs.args : null;
  if (params.name !== "run_ade_action" || toolArgs?.domain !== "ios_simulator" || args?.proof === false) return null;
  const action = asString(toolArgs.action);
  return (APPLE_PROOF_ACTIONS as readonly string[]).includes(action ?? "") ? action as AppleProofAction : null;
}

const ANDROID_PROOF_ACTIONS = ["screenshot", "captureProofBundle", "recordStop", "requestRender", "renderComposePreviews", "storeScreenshots"] as const;
type AndroidProofAction = (typeof ANDROID_PROOF_ACTIONS)[number];

/** An Android action the emulator's machine would file as proof; `proof: false` files nothing at all. */
function androidActionFiledAsProof(params: JsonObject): AndroidProofAction | null {
  const toolArgs = isRecord(params.arguments) ? params.arguments : null;
  const args = toolArgs && isRecord(toolArgs.args) ? toolArgs.args : null;
  if (params.name !== "run_ade_action" || toolArgs?.domain !== "android_emulator" || args?.proof === false) return null;
  const action = asString(toolArgs.action);
  return (ANDROID_PROOF_ACTIONS as readonly string[]).includes(action ?? "") ? action as AndroidProofAction : null;
}

/** The action's own record in an `ade/actions/call` answer: `{ structuredContent: { domain, action, result } }` or a bare one. */
function appleActionResult(answer: unknown): JsonObject | null {
  let value: unknown = answer;
  if (isRecord(value) && "structuredContent" in value) value = value.structuredContent;
  if (isRecord(value) && "result" in value && (asString(value.domain) || asString(value.action))) value = value.result;
  return isRecord(value) ? value : null;
}

/** The same answer with the action's record replaced. */
function withAppleActionResult(answer: unknown, next: JsonObject): unknown {
  const replaceIn = (value: unknown): unknown =>
    isRecord(value) && "result" in value && (asString(value.domain) || asString(value.action))
      ? { ...value, result: next }
      : next;
  if (isRecord(answer) && "structuredContent" in answer) {
    return { ...answer, structuredContent: replaceIn(answer.structuredContent) };
  }
  return replaceIn(answer);
}

/** The id of the first artifact an ingest filed. */
function firstFiledArtifactId(value: unknown): string | null {
  const record = appleActionResult(value);
  const artifacts = record && Array.isArray(record.artifacts) ? record.artifacts : [];
  const first = artifacts.find(isRecord);
  return first ? asString(first.artifactId) ?? asString(first.id) : null;
}

function isAppControlCaptureProof(params: JsonObject | undefined): boolean {
  const toolArgs = params && isRecord(params.arguments) ? params.arguments : null;
  return params?.name === "run_ade_action"
    && toolArgs?.domain === "app_control"
    && toolArgs.action === "captureProof";
}

/** Rows from another machine carry where they came from, for the merged table. */
export const MACHINE_ROW_KEY = "machine";
const MACHINE_PROJECT_ROW_KEY = "machineProject";

export type MachineListKind = "chats" | "inbox" | "projects" | "lanes" | "usageLimits";

function rowsOfListValue(kind: MachineListKind, value: unknown): JsonObject[] {
  if (kind === "chats") return firstArray(value, ["sessions", "chats", "items"]);
  if (kind === "inbox") return firstArray(value, ["items"]);
  if (kind === "usageLimits") return firstArray(value, ["accounts"]);
  if (kind === "projects") return firstArray(value, ["projects", "items"]);
  return firstArray(value, ["lanes", "items", "result"]);
}

/** What went wrong, in the words of whatever actually failed. */
function failureCause(error: unknown): string {
  if (error instanceof CliExecutionError && typeof error.details.cause === "string") return error.details.cause;
  return error instanceof Error ? error.message : String(error);
}

/** One short-lived connection to this machine's brain, for machine-level calls. */
async function withMachineBrain<T>(
  options: GlobalOptions,
  run: (client: SocketJsonRpcClient) => Promise<T>,
): Promise<T> {
  const client = await connectMachineRuntimeDaemon(options, options.socketPath?.trim() || null);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/**
 * `--all-machines`: run one list command on this machine and on every online
 * machine on the account, and merge the rows into one list with machine and
 * project columns. An offline or failing machine is one row saying so, never a
 * failed command: the point is a picture of everything, and one dark laptop
 * must not blank it.
 */
async function executePlanOnAllMachines(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
): Promise<unknown> {
  const kind = plan.machineList ?? null;
  if (!kind) {
    throw new CliUsageError(
      "--all-machines works with `chat list`, `chat inbox`, `lanes list`, `projects list` and `usage limits`. Use --machine <name> for one machine.",
    );
  }
  const single: GlobalOptions = { ...options, allMachines: false, machine: null };
  const perProject = kind === "chats" || kind === "inbox" || kind === "lanes";
  const [roster, localProjects] = await withMachineBrain(options, async (client) => [
    await client.request("machines.list", { includeProjects: perProject }),
    perProject ? await client.request("projects.list", {}).catch(() => []) : [],
  ] as const);
  const machines = isRecord(roster) && Array.isArray(roster.machines) ? roster.machines.filter(isRecord) : [];
  if (isRecord(roster) && roster.state !== "ok") {
    process.stderr.write(`ade: ${String(roster.message ?? "Other machines are unavailable.")} Showing this machine only.\n`);
  }
  const roots = resolveRoots(options);
  const localIdentity = gitRemoteIdentity(getGitRemote(roots.projectRoot));
  // The project a row came from, as that machine names it. A projects list is
  // its own project column.
  const projectNameOn = (machine: JsonObject | null): string | null => {
    if (kind === "projects" || kind === "usageLimits") return null;
    if (options.machineProject) return options.machineProject;
    if (!machine) {
      // This machine's row names its project the way every other row does:
      // by the registry's display name.
      const local = Array.isArray(localProjects)
        ? localProjects.filter(isRecord).find((project) =>
          typeof project.rootPath === "string" && samePathOnPlatform(project.rootPath, roots.projectRoot))
        : undefined;
      return asString(local?.displayName) ?? path.basename(roots.projectRoot);
    }
    const projects = Array.isArray(machine.projects) ? machine.projects.filter(isRecord) : [];
    // The checkout the call itself is routed to (see `pickLiveCheckout`), not
    // the first registry entry with this origin.
    const match = pickLiveCheckout(projects
      .filter((project) => localIdentity !== null && asString(project.origin) === localIdentity)
      .map((project) => ({
        name: asString(project.name),
        lastOpenedAt: typeof project.lastOpenedAt === "number" ? project.lastOpenedAt : 0,
        catalogVisibility: project.catalogVisibility === "system" ? "system" as const : null,
        ...(typeof project.exists === "boolean" ? { exists: project.exists } : {}),
      })));
    return match?.name ?? null;
  };
  // `machineSelector` is what `--machine` gets: the key, which two computers
  // with one display name cannot share. The name stays the label.
  const tag = (rows: JsonObject[], machineName: string, project: string | null, remote = false, machineSelector = machineName): JsonObject[] =>
    rows.map((row) => ({
      [MACHINE_ROW_KEY]: machineName,
      [MACHINE_PROJECT_ROW_KEY]: project,
      ...row,
      // An inbox row's answer commands must reach the machine the chat is on.
      ...(remote && kind === "inbox" && Array.isArray(row.respond)
        ? { respond: row.respond.map((command) => `${String(command)} --machine ${JSON.stringify(machineSelector)}`) }
        : {}),
    }));
  // A usage report's provider-wide notes and the asking chat's account ride
  // beside its rows; keep them, naming the machine a note came from.
  const notes: string[] = [];
  let chat: unknown = null;
  const keepReportExtras = (value: unknown, machineName: string, local: boolean): void => {
    if (kind !== "usageLimits" || !isRecord(value)) return;
    if (local && isRecord(value.chat)) chat = value.chat;
    for (const note of Array.isArray(value.notes) ? value.notes : []) {
      if (typeof note === "string" && note.trim()) notes.push(`${machineName}: ${note.trim()}`);
    }
  };
  const localName = asString(machines.find((machine) => machine.isThisMachine === true)?.name) ?? THIS_MACHINE_NAME;
  const results = await Promise.all([
    executePlan(plan, single).then(
      (value) => {
        keepReportExtras(value, localName, true);
        return tag(rowsOfListValue(kind, value), localName, projectNameOn(null));
      },
      (error) => [{ [MACHINE_ROW_KEY]: localName, unavailable: failureCause(error) }],
    ),
    ...machines
      .filter((machine) => machine.isThisMachine !== true)
      .map(async (machine): Promise<JsonObject[]> => {
        const name = asString(machine.name) ?? asString(machine.machineKey) ?? "machine";
        if (machine.online !== true) {
          const lastSeen = asString(machine.lastSeenAt);
          return [{
            [MACHINE_ROW_KEY]: name,
            unavailable: `offline${lastSeen ? ` (last seen ${new Date(lastSeen).toLocaleString()})` : ""}`,
          }];
        }
        try {
          const value = await executePlan(plan, { ...single, machine: asString(machine.machineKey) ?? name });
          keepReportExtras(value, name, false);
          return tag(rowsOfListValue(kind, value), name, projectNameOn(machine), true, asString(machine.machineKey) ?? name);
        } catch (error) {
          return [{ [MACHINE_ROW_KEY]: name, unavailable: failureCause(error) }];
        }
      }),
  ]);
  const rows = results.flat();
  if (kind === "usageLimits") return { readAt: null, chat, accounts: rows, notes };
  if (kind === "inbox") return { items: rows };
  return kind === "chats" ? { sessions: rows } : kind === "projects" ? { projects: rows } : { lanes: rows };
}

/**
 * A merged list's machine (and, unless `projectColumn: false`, project)
 * columns, ahead of the command's own. A row that only says a machine is
 * offline fills the first content column.
 */
export function withMachineColumns(
  headers: string[],
  records: JsonObject[],
  cells: (record: JsonObject) => unknown[],
  layout: { projectColumn?: boolean } = {},
): { headers: string[]; rows: unknown[][] } {
  const merged = records.some((record) => MACHINE_ROW_KEY in record);
  if (!merged) return { headers, rows: records.map(cells) };
  const projectColumn = layout.projectColumn !== false;
  const lead = projectColumn ? ["machine", "project"] : ["machine"];
  return {
    headers: [...lead, ...headers],
    rows: records.map((record) => {
      const unavailable = asString(record.unavailable);
      const machineCell = record[MACHINE_ROW_KEY];
      const projectCells = projectColumn ? [unavailable ? "-" : record[MACHINE_PROJECT_ROW_KEY] ?? ""] : [];
      if (unavailable) return [machineCell, ...projectCells, unavailable, ...headers.slice(1).map(() => "")];
      return [machineCell, ...projectCells, ...cells(record)];
    }),
  };
}

type MachineFanOutResult = {
  machineFanOut: Array<{ machine: string; sessionId: string | null; result?: unknown; error?: string }>;
};

export function isMachineFanOutResult(value: unknown): value is MachineFanOutResult {
  return isRecord(value) && Array.isArray(value.machineFanOut);
}

export function formatMachineFanOut(value: MachineFanOutResult): string {
  return renderTable(
    ["machine", "session", "result"],
    value.machineFanOut.map((row) => [row.machine, row.sessionId ?? "", row.error ? `failed: ${row.error}` : "started"]),
    "ADE chats\n(no machines)",
    { fullColumns: ["session"] },
  );
}

/**
 * `ade chat create --machine a,b,c`: the same child on every named machine,
 * one call each, in parallel. One machine failing is its own row, never the
 * whole command: the others' children already exist.
 */
async function executePlanOnMachines(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
  machines: string[],
): Promise<MachineFanOutResult> {
  if (!plan.machineFanOut) {
    throw new CliUsageError("Several machines in --machine work with `chat create` only. Use --all-machines for lists.");
  }
  const rows = await Promise.all(machines.map(async (machine) => {
    try {
      const result = await executePlan(plan, { ...options, machine });
      return { machine, sessionId: sessionIdFromCreateChatValue(result) ?? null, result };
    } catch (error) {
      return { machine, sessionId: null, error: failureCause(error) };
    }
  }));
  return { machineFanOut: rows };
}

/** The `chat.createSession` call in an `ade/actions/call` request, when it names no lane. */
function chatCreateCallWithoutLane(params: JsonObject): (JsonObject & { args: JsonObject }) | null {
  if (params.name !== "run_ade_action" || !isRecord(params.arguments)) return null;
  const call = params.arguments;
  if (call.domain !== "chat" || call.action !== "createSession" || !isRecord(call.args) || asString(call.args.laneId)) return null;
  return call as JsonObject & { args: JsonObject };
}

function withChatCreateLane(params: JsonObject, laneId: string): JsonObject {
  const call = chatCreateCallWithoutLane(params);
  return call ? { ...params, arguments: { ...call, args: { ...call.args, laneId } } } : params;
}

/* ──────────────────────────────────────────────────────────────────────────
   ADE CLOUD LANES: `--machine cloud [--size <size>]`.

   One new ADE Cloud computer for one new lane, the repository there, and the
   chat started there. This machine's brain owns the launch (`cloud.lane_launch`
   in cloudAgentActions.ts, the core in cloudLaneLaunchService.ts): it holds
   the account and the provider key, which this process never has. The CLI
   starts it and follows it. A Ctrl-C stops the following only; the launch
   goes on in the brain, and the same `--launch-id` again follows it, or goes
   on from a failed step, never with a second computer.
   ────────────────────────────────────────────────────────────────────────── */

const CLOUD_LANE_POLL_MS = 2_000;
/** Covers a new computer, the 10 minutes a join may wait for the person, and a large clone. */
const CLOUD_LANE_WAIT_MS = 30 * 60_000;

/** `--machine cloud`: a new lane on its own new ADE Cloud computer. */
export function isCloudLaneMachineSelector(machine: string | null | undefined): boolean {
  return machine?.trim().toLowerCase() === CLOUD_LANE_MACHINE;
}

/** `ade chat create`'s choices as a lane launch: a chat in a new lane with the project's lane defaults. */
function cloudLaunchArgsFromChatCreate(draft: CloudLaneLaunchDraft): JsonObject {
  // The computer binds the issue to the new lane; it has no Linear lookup for a bare id.
  const linearIssue = draft.linearIssue ? parseLaneLinearIssueValue(draft.linearIssue) : null;
  if (draft.linearIssue && !linearIssue) {
    throw new CliUsageError("--machine cloud needs the whole Linear issue (id, identifier, title, team and state) in --linear-issue-json.");
  }
  if (draft.notify) throw new CliUsageError("--notify-url doesn't work with --machine cloud yet.");
  if (asString(draft.create.laneId)) {
    throw new CliUsageError("--machine cloud makes a new lane for the chat: leave out --lane.");
  }
  const prompt = draft.prompt?.trim() ? draft.prompt : null;
  if (!prompt) throw new CliUsageError("A chat on ADE Cloud starts with its first message: pass --prompt or --prompt-file.");
  // The lane is the launch's; a parent on this machine can't follow a chat on another computer.
  const {
    laneId: _laneId,
    sessionId: _sessionId,
    orchestrationParentSessionId: parent,
    spawnKind,
    ...create
  } = draft.create;
  const provider = asString(create.provider) ?? "codex";
  if (process.env.ADE_CHAT_SESSION_ID?.trim() && (parent || spawnKind)) {
    process.stderr.write("note: a chat on ADE Cloud starts as its own chat, so it doesn't report back to you. Read it with ade chat read --machine <its computer>.\n");
  }
  const modelId = asString(create.modelId) ?? asString(create.model);
  // A name given here is the lane's one name: the lane, its computer and the
  // ADE Cloud page all use it, and nothing renames it from the prompt.
  const laneName = draft.laneName?.trim() || null;
  return {
    kind: "chat",
    mode: "background",
    launchId: draft.launchId ?? randomUUID(),
    prompt,
    provider,
    ...(modelId ? { modelId } : {}),
    ...(asString(create.title) ? { title: asString(create.title) } : {}),
    ...(laneName ? { laneName } : {}),
    ...(linearIssue || laneName ? { laneConfig: { mode: "new", ...(linearIssue ? { linearIssue } : {}) } } : {}),
    chat: {
      create: { ...create, provider, model: asString(create.model) ?? "" },
      message: { text: prompt },
    },
  };
}

/** The result a caller reads: the launch, and where the lane and its chat are. */
function cloudLaneResult(status: JsonObject): JsonObject {
  const launch = isRecord(status.launch) ? status.launch : {};
  const machine = isRecord(status.machine) ? status.machine : {};
  return {
    ok: launch.phase !== "failed" && launch.phase !== "cancelled",
    launchId: asString(launch.launchId),
    phase: asString(launch.phase),
    laneId: asString(launch.laneId),
    laneName: asString(launch.laneName),
    // A lane launch starts no chat; a chat launch's chat id is its launch id.
    sessionId: launch.kind === "lane" ? null : asString(launch.sessionId) ?? asString(launch.launchId),
    machine: {
      name: asString(machine.name),
      instanceId: asString(machine.instanceId),
      machineKey: asString(machine.machineKey),
    },
    approvalUrl: asString(status.approvalUrl),
    launch,
  };
}

/** One connection to this machine's brain for a run of `cloud` actions, in the project the CLI runs in. */
async function withCloudActions<T>(
  options: GlobalOptions,
  projectRoot: string,
  run: (call: (action: string, args: JsonObject) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return await withMachineBrain(options, async (client) => {
    const registered = await client.request("projects.add", automaticProjectRegistrationParams(projectRoot));
    const projectId = isRecord(registered) ? asString(registered.projectId) : null;
    if (!projectId) throw new Error("This machine's brain did not register the project.");
    return await run(async (action, args) => {
      const answer = unwrapToolResult(await client.request("ade/actions/call", withProjectId({
        name: "run_ade_action",
        arguments: { domain: "cloud", action, args },
      }, projectId)));
      return isRecord(answer) && "result" in answer && ("domain" in answer || "action" in answer) ? answer.result : answer;
    });
  });
}

/**
 * Starts a lane launch on ADE Cloud in this machine's brain and follows it
 * until the agent starts there. Progress goes to stderr (not with --json).
 * A failure throws the sentence the lane's card shows; the launch id rides
 * along so the same command can go on from it.
 */
export async function runCloudLaneLaunch(launchArgs: JsonObject, options: GlobalOptions): Promise<JsonObject> {
  const laneConfig = isRecord(launchArgs.laneConfig) ? launchArgs.laneConfig : null;
  const start = laneConfig && isRecord(laneConfig.start) ? laneConfig.start : null;
  if (start?.on === "uncommitted") {
    throw new CliUsageError("An ADE Cloud lane starts from the pushed copy of its branch, so it can't bring uncommitted changes.");
  }
  if (start?.on === "local") {
    throw new CliUsageError("An ADE Cloud lane starts from the pushed copy of its branch, so it can't start from this computer's copy. Leave out --on.");
  }
  if (options.machineProject) {
    throw new CliUsageError("--machine cloud makes a new lane for this project on its own computer: leave out --project and --machine-project.");
  }
  const roots = resolveRoots(options);
  const originUrl = getGitRemote(roots.projectRoot);
  if (!originUrl) {
    throw new CliUsageError("--machine cloud needs a project with a GitHub origin: ADE Cloud gets the repository from there.");
  }
  const launchId = asString(launchArgs.launchId) ?? randomUUID();
  // No --size: the brain uses the size the person saved for new lanes (Small when none).
  const sizeId = options.cloudSize ?? null;
  const launch: JsonObject = { ...launchArgs, launchId, cloud: sizeId ? { sizeId } : {} };
  const say = (line: string) => {
    if (!options.json) process.stderr.write(`ade: ${line}\n`);
  };
  // The launch is the brain's: an interrupt here leaves it running there, and says how to reach it.
  const onInterrupt = () => {
    process.stderr.write(
      `\nade: the lane keeps starting on ADE Cloud. Check it: ade chat launch-status ${launchId} --machine cloud`
      + ` · stop it and delete its computer: ade chat launch-cancel ${launchId} --machine cloud\n`,
    );
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  try {
    // Always, --json too (stderr), before anything waits: the id is what follows or resumes this launch.
    process.stderr.write(`ade: starting a lane on ADE Cloud (${sizeId ?? "your default size"}). Launch id ${launchId}.\n`);
    return await withCloudActions(options, roots.projectRoot, async (call) => {
      let lastLine = "";
      const { outcome, status, answer } = await followCloudLaneLaunch({
        start: () => call("lane_launch", { launch, originUrl }),
        read: () => call("lane_launch_status", { launchId }),
        onStatus: ({ launch: snapshot }) => {
          const line = chatLaunchStatusLine(snapshot);
          if (line !== lastLine) say(line);
          lastLine = line;
        },
        onApprovalLink: (link) => say(`Approve the new computer joining your ADE account: open ${link} on your phone or in a browser signed in to ADE.`),
        pollMs: CLOUD_LANE_POLL_MS,
        waitMs: CLOUD_LANE_WAIT_MS,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      switch (outcome) {
        case "missing":
          throw new CliExecutionError("This computer's ADE no longer has the ADE Cloud lane launch.", { launchId });
        case "succeeded":
          return cloudLaneResult(answer as JsonObject);
        case "failed":
          throw new CliExecutionError(status?.launch.error?.trim() || "The lane didn't start on ADE Cloud.", {
            launchId,
            phase: "failed",
            nextAction: `Run the same command with --launch-id ${launchId} to go on from the failed step.`,
          });
        case "cancelled":
          throw new CliExecutionError("The lane launch was cancelled, and its computer deleted.", { launchId, phase: "cancelled" });
        case "timeout":
          throw new CliExecutionError(`The lane is still starting on ADE Cloud after ${CLOUD_LANE_WAIT_MS / 60_000} minutes.`, {
            launchId,
            nextAction: `ade chat launch-status ${launchId} --machine cloud`,
          });
      }
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

/** `--machine cloud` on an execute plan: `chat create`, or a launch's status or cancel. */
async function executePlanOnCloudLane(plan: CliPlan & { kind: "execute" }, options: GlobalOptions): Promise<unknown> {
  if (plan.cloudLaneCall) {
    const { action, launchId } = plan.cloudLaneCall;
    const roots = resolveRoots(options);
    const status = await withCloudActions(options, roots.projectRoot, (call) => call(action, { launchId }));
    if (!isRecord(status)) throw new CliExecutionError("This computer's ADE has no ADE Cloud lane launch with that id.", { launchId });
    return cloudLaneResult(status);
  }
  if (plan.cloudLaunch) {
    const result = await runCloudLaneLaunch(cloudLaunchArgsFromChatCreate(plan.cloudLaunch), options);
    // `chat create` has no launch formatter: text mode gets the launch view (a string passes the formatters as it is).
    return options.text ? formatChatLaunch(result) : result;
  }
  if (plan.cloudLaneCreate) {
    // The lane alone: no chat, so no agent stage. Same launch, same id rules.
    if (plan.cloudLaneCreate.refused) throw new CliUsageError(plan.cloudLaneCreate.refused);
    const result = await runCloudLaneLaunch({
      ...plan.cloudLaneCreate.launch,
      ...(plan.cloudLaneCreate.launchId ? { launchId: plan.cloudLaneCreate.launchId } : {}),
    }, options);
    return options.text ? formatChatLaunch(result) : result;
  }
  throw new CliUsageError(
    "--machine cloud starts a new lane on ADE Cloud: use it with ade chat create, ade chat launch, or ade lanes create (the lane alone). "
    + "To reach a lane already there, use --machine with its computer's name.",
  );
}

/**
 * The machine routing `executePlan` applies first: `--all-machines`, or a
 * comma list of machines. Null for a plan that runs once, here or on one
 * machine through the connection.
 */
export async function executePlanAcrossMachines(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
): Promise<{ value: unknown } | null> {
  if (plan.cloudLaunch?.launchId && !isCloudLaneMachineSelector(options.machine)) {
    throw new CliUsageError("--launch-id on chat create is for a new lane on ADE Cloud: add --machine cloud.");
  }
  if (plan.cloudLaneCreate?.launchId && !isCloudLaneMachineSelector(options.machine)) {
    throw new CliUsageError("--launch-id on lanes create is for a new lane on ADE Cloud: add --machine cloud.");
  }
  if (isCloudLaneMachineSelector(options.machine)) return { value: await executePlanOnCloudLane(plan, options) };
  if (options.allMachines) return { value: await executePlanOnAllMachines(plan, options) };
  const machineList = [...new Set((options.machine ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (machineList.length > 1) return { value: await executePlanOnMachines(plan, options, machineList) };
  if (options.machine && plan.steps.some((step) => step.injectProjectRootIntoArgs)) {
    throw new CliUsageError(`${plan.label} reads this machine's files, so it can't run with --machine.`);
  }
  return null;
}

/** `ade machines list` from an agent's shell: the agent-safe roster. */
export function formatMachinesRoster(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const state = asString(record.state) ?? "unavailable";
  if (state === "signed_out") {
    return "Not signed in — run `ade login` on this machine. Other machines are reachable only through your ADE account.";
  }
  if (state !== "ok") return asString(record.message) ?? "The ADE account machine directory is unavailable.";
  const machines = firstArray(record, ["machines"]);
  return renderTable(
    ["machine", "key", "status", "platform", "last seen", "projects"],
    machines.map((machine) => [
      machine.isThisMachine === true ? `${String(machine.name ?? "")} (this machine)` : machine.name,
      machine.machineKey,
      asString(machine.presence) ?? (machine.online === true ? "online" : "offline"),
      machine.platform,
      asString(machine.lastSeenAt) ? new Date(String(machine.lastSeenAt)).toLocaleString() : "never",
      Array.isArray(machine.projects)
        ? machine.projects.filter(isRecord).map((project) => project.name ?? project.rootPath).join(", ")
        : asString(machine.note) ?? "",
    ]),
    "ADE machines\n(no machines on this account)",
    { fullColumns: ["key"] },
  );
}

/** How long a "which machine has this chat" lookup may delay an error. */
const CHAT_LOOKUP_BUDGET_MS = 6_000;

/**
 * The other machine on the account that holds `sessionId`, for the "not
 * found" error of a chat command that named no machine. It asks each online
 * machine for the chat's summary (one small read each, in parallel) and gives
 * up after a few seconds, so a dark or slow machine only costs the generic
 * hint. Null when no machine answered with the chat, or the roster is
 * unavailable (signed out, offline).
 *
 * Never asked under ADE MCP (`ADE_REMOTE_MCP_SCOPE`): its connection reaches
 * only this computer, and another machine's owner may have ADE MCP off.
 */
export async function locateChatOnOtherMachines(
  sessionId: string,
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
  budgetMs = CHAT_LOOKUP_BUDGET_MS,
): Promise<{ machineName: string; machineKey: string } | null> {
  if (process.env.ADE_REMOTE_MCP_SCOPE?.trim()) return null;
  const single: GlobalOptions = { ...options, allMachines: false, machine: null };
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref?.();
  });
  const lookup = (async () => {
    const roster = await withMachineBrain(single, (client) => client.request("machines.list", { includeProjects: false }));
    if (!isRecord(roster) || roster.state !== "ok" || !Array.isArray(roster.machines)) return null;
    const others = roster.machines
      .filter(isRecord)
      .filter((machine) => machine.isThisMachine !== true && machine.online === true)
      .flatMap((machine) => {
        const machineKey = asString(machine.machineKey);
        return machineKey ? [{ machineKey, machineName: asString(machine.name) ?? machineKey }] : [];
      });
    if (!others.length) return null;
    // The first machine that answers with the chat wins; a machine that fails
    // or does not have it never rejects the race.
    return await new Promise<{ machineName: string; machineKey: string } | null>((resolve) => {
      let pending = others.length;
      for (const machine of others) {
        executePlan(plan, { ...single, machine: machine.machineKey }).then(
          (value) => {
            if (summaryNamesChat(value, sessionId)) resolve(machine);
            else if (--pending === 0) resolve(null);
          },
          () => {
            if (--pending === 0) resolve(null);
          },
        );
      }
    });
  })().catch(() => null);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether a `chat show` answer is that chat. The answer may arrive wrapped in
 * a tool or action envelope; a missing chat answers null or an error envelope.
 */
function summaryNamesChat(value: unknown, sessionId: string): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (current.isError === true || current.ok === false) return false;
    const id = asString(current.sessionId) ?? asString(current.id);
    if (id) return id === sessionId;
    current = current.result ?? current.structuredContent ?? null;
  }
  return false;
}
