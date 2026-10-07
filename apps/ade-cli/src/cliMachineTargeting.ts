import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { THIS_MACHINE_NAME } from "../../desktop/src/shared/machineIdentity";
import { normalizeGitRemoteIdentity } from "../../desktop/src/shared/crossMachineHandoff";
import { samePathOnPlatform } from "../../desktop/src/shared/pathContainment";
import {
  CliExecutionError,
  CliUsageError,
  asString,
  automaticProjectRegistrationParams,
  connectMachineRuntimeDaemon,
  executePlan,
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

/** Commands that can run on another machine with `--machine`. */
const MACHINE_TARGETABLE_PRIMARIES: ReadonlySet<string> = new Set([
  "chat",
  "new",
  "lanes",
  "lane",
  "projects",
  "apple",
  "mac-desktop",
  "app-control",
]);
/** Where `--project` means "the project on that machine" (apple uses it for an Xcode project). */
const MACHINE_PROJECT_ALIAS_PRIMARIES: ReadonlySet<string> = new Set(["chat", "lanes", "lane"]);
/** Flags whose value is free text that may itself look like a flag. */
const FREE_TEXT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--text", "--prompt", "--message", "--note", "--title", "--reason"]);

/**
 * Pull `--machine <name>`, `--all-machines`, `--machine-project <sel>`,
 * `--clone` and (for chat and lanes, while targeting a machine)
 * `--project <sel>` out of a supported command's own arguments into the
 * global options. Unsupported commands keep their flags and fail as before.
 */
export function extractMachineTargeting(parsed: ParsedCli): ParsedCli {
  const primary = parsed.command[0]?.toLowerCase() ?? "";
  if (!MACHINE_TARGETABLE_PRIMARIES.has(primary)) return parsed;
  // `ade chat handoff <session> --machine X` moves a chat FROM here TO X: the
  // flag names the destination, so the command runs on this machine and is
  // never forwarded. The other handoff forms act on this machine's own move,
  // so --machine with them is a mistake, not a target.
  if (primary === "chat" && parsed.command[1]?.toLowerCase() === "handoff") {
    const flags = new Set(parsed.command.map((token) => token.split("=")[0]!));
    if ((flags.has("--machine") || flags.has("--to-machine")) && ["--cancel", "--retry", "--options", "--where"].some((flag) => flags.has(flag))) {
      throw new CliUsageError("--machine names the destination of a move; drop it for --cancel/--retry/--options.");
    }
    return parsed;
  }
  const kept: string[] = [];
  let machine: string | null = null;
  let allMachines = false;
  let machineProject: string | null = null;
  let projectAlias: string | null = null;
  let machineClone = false;
  const command = parsed.command;
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (token === "--") {
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
  if (machineProject && !machine && !allMachines) throw new CliUsageError("--machine-project needs --machine <name>.");
  if (!machine && !allMachines) return parsed;
  return {
    command: kept,
    options: {
      ...parsed.options,
      machine,
      allMachines,
      machineProject: machineProject ?? projectAlias,
      machineClone,
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
  options: GlobalOptions,
  localOriginUrl: () => string | null,
): JsonObject {
  if (method.startsWith("personalChats.")) return { kind: "personal" };
  if (method.startsWith("projects.")) return { kind: "machine" };
  const selector = options.machineProject?.trim();
  if (selector) return { kind: "project", selector };
  const originUrl = localOriginUrl();
  if (!originUrl) {
    throw new CliUsageError(
      "This directory has no git origin, so ADE can't tell which project to use on the other machine. Pass --project <name|path|id>.",
    );
  }
  return { kind: "repo", originUrl };
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

  const callRemote = async (method: string, params?: JsonObject): Promise<unknown> => {
    const answer = await socketClient.request("machines.call", {
      machine,
      scope: machineCallScopeFor(method, options, localOriginUrl),
      request: { method, params: withoutLocalPaths(params) },
      timeoutMs: options.timeoutMs,
      ...(options.machineClone ? { clone: true } : {}),
    });
    return isRecord(answer) && "result" in answer ? answer.result : answer;
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
      if (method === "ade/actions/call" && params?.name === "list_computer_use_artifacts") {
        // A proof command's verify step checks the drawer it filed into: this one.
        return await callLocalProject(method, params);
      }
      return await callRemote(method, params);
    },
    close: () => socketClient.close(),
  };
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

export type MachineListKind = "chats" | "projects" | "lanes";

function rowsOfListValue(kind: MachineListKind, value: unknown): JsonObject[] {
  if (kind === "chats") return firstArray(value, ["sessions", "chats", "items"]);
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
      "--all-machines works with `chat list`, `lanes list` and `projects list`. Use --machine <name> for one machine.",
    );
  }
  const single: GlobalOptions = { ...options, allMachines: false, machine: null };
  const [roster, localProjects] = await withMachineBrain(options, async (client) => [
    await client.request("machines.list", { includeProjects: kind !== "projects" }),
    kind === "projects" ? [] : await client.request("projects.list", {}).catch(() => []),
  ] as const);
  const machines = isRecord(roster) && Array.isArray(roster.machines) ? roster.machines.filter(isRecord) : [];
  if (isRecord(roster) && roster.state !== "ok") {
    process.stderr.write(`ade: ${String(roster.message ?? "Other machines are unavailable.")} Showing this machine only.\n`);
  }
  const roots = resolveRoots(options);
  const localIdentity = normalizeGitRemoteIdentity(getGitRemote(roots.projectRoot));
  // The project a row came from, as that machine names it. A projects list is
  // its own project column.
  const projectNameOn = (machine: JsonObject | null): string | null => {
    if (kind === "projects") return null;
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
    const match = projects.find((project) => asString(project.origin) === localIdentity);
    return asString(match?.name) ?? null;
  };
  const tag = (rows: JsonObject[], machineName: string, project: string | null): JsonObject[] =>
    rows.map((row) => ({ [MACHINE_ROW_KEY]: machineName, [MACHINE_PROJECT_ROW_KEY]: project, ...row }));
  const localName = asString(machines.find((machine) => machine.isThisMachine === true)?.name) ?? THIS_MACHINE_NAME;
  const results = await Promise.all([
    executePlan(plan, single).then(
      (value) => tag(rowsOfListValue(kind, value), localName, projectNameOn(null)),
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
          return tag(rowsOfListValue(kind, value), name, projectNameOn(machine));
        } catch (error) {
          return [{ [MACHINE_ROW_KEY]: name, unavailable: failureCause(error) }];
        }
      }),
  ]);
  const rows = results.flat();
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

/**
 * The machine routing `executePlan` applies first: `--all-machines`, or a
 * comma list of machines. Null for a plan that runs once, here or on one
 * machine through the connection.
 */
export async function executePlanAcrossMachines(
  plan: CliPlan & { kind: "execute" },
  options: GlobalOptions,
): Promise<{ value: unknown } | null> {
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
