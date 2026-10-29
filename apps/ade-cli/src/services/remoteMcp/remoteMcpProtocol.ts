import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import type {
  RemoteMcpActivityEntry,
  RemoteMcpActivityOutcome,
  RemoteMcpConnectionSummary,
  RemoteMcpScope,
} from "../../../../desktop/src/shared/types/remoteMcp";
import { listAgentSkills, readAgentSkill } from "../skills/agentSkillCatalogService";
import { remoteMcpAdeVersion } from "./remoteMcpAccount";
import { checkRemoteAdeCommand, redactedCommandForLog, splitCommandLine } from "./remoteMcpCommandPolicy";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_STDIN_BYTES,
  MAX_TIMEOUT_MS,
  runAdeForRemote,
  type RemoteRunResult,
} from "./remoteMcpRunner";
import {
  buildTypedToolResult,
  findTypedTool,
  MACHINES_TOOL_NAME,
  nonEmptyString,
  parseTypedRun,
  shapedToolResult,
  toolText,
  TYPED_TOOLS,
  type TypedTool,
} from "./remoteMcpTools";
import {
  REMOTE_MCP_DEFAULT_PROTOCOL_VERSION,
  rosterStateWords,
  toolError,
  withMachineLabel,
  type RemoteMcpCallContext,
  type RemoteMcpMachineRouter,
  type RemoteMcpRosterMachine,
  type RemoteMcpToolResult,
} from "./remoteMcpForward";
import { adeAppResourceListing, readAdeAppResource, withAppUi } from "./remoteMcpApps";

/**
 * ADE MCP's protocol: the JSON-RPC methods an authenticated connection may
 * call (tools, resources, prompts), and running its commands. The HTTP
 * routes, sign-in and token checks stay in remoteMcpService.ts; this answers
 * one message for a connection that already passed them.
 */

export type RemoteMcpProject = { projectId: string; rootPath: string; displayName: string; lastOpenedAt: number };

export type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

type ResolvedProject = { cwd: string; project: RemoteMcpProject | null };

type ActivityBase = Pick<RemoteMcpActivityEntry, "connectionId" | "label" | "scope" | "tool">;

const MAX_CONCURRENT_REMOTE_RUNS = 4;
/** One connection's share, so a long `chat_wait` cannot shut every other app out. */
const MAX_CONCURRENT_RUNS_PER_CONNECTION = 3;
const MIN_TIMEOUT_SECONDS = 5;
/** List-shaped tools that take `machine: "all"`. */
const FAN_OUT_TOOL_NAMES = TYPED_TOOLS.filter((tool) => tool.fanOut).map((tool) => tool.name);
const MAX_FAN_OUT = 6;
const FAN_OUT_TIMEOUT_MS = 60_000;
const FORWARD_EXTRA_MS = 30_000;
const MAX_FORWARD_MS = 10 * 60_000;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TOOL_NAME = "ade";
const COMMANDS_RESOURCE_URI = "ade://commands";
const MAX_PROMPTS = 200;
const MAX_PROMPT_DESCRIPTION_CHARS = 1_024;
/** How long the command catalog is reused before it is read again. */
const CATALOG_TTL_MS = 5 * 60_000;
/** An every-project sweep reads the projects opened in this window, newest first. */
const EVERY_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60_000;
const EVERY_PROJECT_MAX = 6;
const EVERY_PROJECT_PARALLEL = 2;
/** Tools that act on one chat by id: without `machine`, the chat's own computer answers. */
const CHAT_ID_TOOL_NAMES: ReadonlySet<string> = new Set(["chat_read", "chat_status", "chat_wait", "chat_send", "chat_respond"]);
/** `ade chat locate` asks every computer at once, five seconds each. */
const CHAT_LOCATE_TIMEOUT_MS = 20_000;

const MAX_CHAT_HOMES = 500;
/** A run longer than this is logged with where its time went (unless the tool waits on purpose). */
const SLOW_RUN_MS = 20_000;
/** How long a project folder's presence is trusted before it is checked again. */
const FOLDER_PRESENCE_TTL_MS = 30_000;

/** A chat tool's answer that says this computer has no such chat. */
function isChatMiss(tool: string, result: RemoteMcpToolResult): boolean {
  if (result.isError) {
    const text = result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? "";
    return /chat session '[^']*' was not found/i.test(text);
  }
  const value = asRecord(asRecord(result.structuredContent).result);
  if (tool === "chat_wait") return value.error === "session_not_found";
  // chat_status answers `{ result: null }` for a chat it does not have.
  return tool === "chat_status"
    && (asRecord(result.structuredContent).result === null || ("result" in value && value.result === null));
}

/** A call the HTTP layer said nothing about: no bearer to forward, not forwarded, the per-machine address. */
const NO_CALL_CONTEXT: RemoteMcpCallContext = { bearer: null, via: null, protocolVersion: null, accountMount: false };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A run that never started, as a failed result, so a sweep reports it beside the others. */
function failedRun(message: string): RemoteRunResult {
  return { exitCode: null, stdout: "", stderr: message, timedOut: false, truncated: false, durationMs: 0 };
}

/** Why a connection from before accounts can't reach this computer, or the one it named. */
function onlyMachineRefusal(only: NonNullable<RemoteMcpConnectionSummary["onlyMachine"]>): string {
  return `This connection was made for ${only.name} before ADE MCP covered your account. `
    + "Reconnect the app in ADE Settings → ADE MCP to reach every computer.";
}

export function createRemoteMcpProtocol(deps: {
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
  record: (entry: Omit<RemoteMcpActivityEntry, "at">) => void;
  /** The provider and model this computer last launched a chat with, for chat_start. */
  launchDefaults?: () => { provider: string; model: string } | null;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  /** The account's computers: every tool takes `machine`, and machines_list lists them. */
  machines: RemoteMcpMachineRouter;
}) {
  let activeRuns = 0;
  const runsByConnection = new Map<string, number>();
  const catalogByScope = new Map<RemoteMcpScope, { at: number; text: Promise<string> }>();

  // ── Projects ──────────────────────────────────────────────────────────────

  // Whether each registered project's folder still exists, checked at most
  // every 30 s per folder. A registry keeps projects whose folder was deleted
  // (test projects in a temp folder); they must not win a name or a default.
  const folderPresence = new Map<string, { at: number; present: boolean }>();
  const folderExists = (rootPath: string): boolean => {
    const cached = folderPresence.get(rootPath);
    if (cached && Date.now() - cached.at < FOLDER_PRESENCE_TTL_MS) return cached.present;
    let present = true;
    try {
      present = fs.statSync(rootPath).isDirectory();
    } catch (error) {
      // Only "not there" counts as gone; a folder that can't be checked stays.
      const code = (error as NodeJS.ErrnoException)?.code;
      present = code !== "ENOENT" && code !== "ENOTDIR";
    }
    if (folderPresence.size > 2_000) folderPresence.clear();
    folderPresence.set(rootPath, { at: Date.now(), present });
    return present;
  };
  /** The registered projects whose folder exists, last opened first. */
  const liveProjects = (): RemoteMcpProject[] =>
    [...deps.listProjects()].filter((project) => folderExists(project.rootPath)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  /** The projects an every-project sweep reads: opened in the last 30 days, at most six. */
  const recentProjects = (): RemoteMcpProject[] => {
    const projects = liveProjects();
    const cutoff = Date.now() - EVERY_PROJECT_WINDOW_MS;
    const recent = projects.filter((project) => project.lastOpenedAt >= cutoff);
    return (recent.length ? recent : projects.slice(0, 1)).slice(0, EVERY_PROJECT_MAX);
  };

  const describeCandidate = (project: RemoteMcpProject): string => `${project.displayName} (id ${project.projectId}, ${project.rootPath})`;

  /**
   * The project a call runs in. Without `project`, the most recently opened
   * one whose folder exists, which changes when the person opens another:
   * every result names it, so a call never lands in a different repo
   * unnoticed. An id or path picks exactly; a name picks among the projects
   * whose folder exists, and two with the same name are refused with both.
   */
  const resolveProject = (requested: unknown): ResolvedProject | { error: string } => {
    const all = deps.listProjects();
    const found = (project: RemoteMcpProject): ResolvedProject => ({ cwd: project.rootPath, project });
    const gone = (project: RemoteMcpProject) => ({
      error: `${project.displayName}'s folder is gone (${project.rootPath}). Clone it again with projects_clone, `
        + "or remove the stale entry with [\"projects\",\"prune\"].",
    });
    if (typeof requested !== "string" || !requested.trim()) {
      const recent = liveProjects()[0];
      // No project at all: machine-wide commands (`projects list`, `doctor`) still work.
      return recent ? found(recent) : { cwd: os.homedir(), project: null };
    }
    const wanted = requested.trim();
    const lower = wanted.toLowerCase();
    const exact = all.filter((project) =>
      project.projectId === wanted
      || (path.isAbsolute(wanted) && samePathOnPlatform(project.rootPath, wanted)));
    if (exact.length === 1) return folderExists(exact[0]!.rootPath) ? found(exact[0]!) : gone(exact[0]!);
    const named = all.filter((project) =>
      project.displayName.toLowerCase() === lower || path.basename(project.rootPath).toLowerCase() === lower);
    const live = named.filter((project) => folderExists(project.rootPath));
    if (live.length === 1) return found(live[0]!);
    if (live.length > 1) {
      return {
        error: `More than one project is called "${wanted}": ${live.map(describeCandidate).join("; ")}. Pass its id or path as \`project\`.`,
      };
    }
    if (named.length > 0) return gone(named[0]!);
    const known = liveProjects().map((project) => project.displayName).join(", ") || "none";
    return { error: `No project "${wanted}" on this computer. Projects: ${known}. A new repository can be added with projects_clone.` };
  };

  // ── MCP ───────────────────────────────────────────────────────────────────

  const PROJECT_INPUT = {
    type: "string",
    description: "Project name, id or path. Default: the last opened.",
  };

  const toolDefinition = (scope: RemoteMcpScope) => ({
    name: TOOL_NAME,
    title: "Run an ADE command",
    description: [
      `Runs the \`ade\` CLI on ${deps.machineName()}, for what no other tool covers. Add --text for readable output.`,
      `["help"] or ${COMMANDS_RESOURCE_URI} lists the commands; ["<command>","--help"] explains one.`,
      scope === "read" ? "Read-only: commands that change things are refused." : "Full access, like the person's terminal.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "The words after `ade`, e.g. [\"lanes\",\"list\",\"--text\"].",
        },
        command: { type: "string", description: "Or the same as one string. No shell runs it." },
        project: PROJECT_INPUT,
        stdin: {
          type: "string",
          maxLength: MAX_STDIN_BYTES,
          description: "Stdin, for `--stdin` or `--body-file -`.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_MS / 1000,
          description: `Default ${DEFAULT_TIMEOUT_MS / 1000}.`,
        },
      },
    },
    annotations: {
      title: "Run an ADE command",
      readOnlyHint: scope === "read",
      destructiveHint: scope === "write",
      idempotentHint: false,
      openWorldHint: true,
    },
  });

  /**
   * Compact on purpose: every app pays for this list before it does anything
   * (remoteMcpContextBudget.test.ts). Hints the MCP spec defaults are left out:
   * `destructiveHint` and `idempotentHint` mean nothing on a read-only tool.
   */
  const typedToolDefinition = (tool: TypedTool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.machineWide ? tool.properties : { ...tool.properties, project: PROJECT_INPUT },
      ...(tool.required?.length ? { required: tool.required } : {}),
    },
    annotations: tool.write
      ? { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false },
  });

  /** The typed tools a scope sees: write tools only with full access. */
  const typedToolsFor = (scope: RemoteMcpScope): readonly TypedTool[] =>
    scope === "write" ? TYPED_TOOLS : TYPED_TOOLS.filter((tool) => !tool.write);

  const instructions = (scope: RemoteMcpScope): string => [
    `ADE on ${deps.machineName()}: coding lanes (git worktrees), agent chats and pull requests.`,
    "Use the typed tools; `ade` runs anything else.",
    "Calls run in `project` (default: the last opened); each result names it.",
    ...(scope === "read" ? ["This connection is read-only."] : []),
  ].join(" ");

  const projectSummary = (resolved: ResolvedProject) => resolved.project
    ? { id: resolved.project.projectId, name: resolved.project.displayName, path: resolved.project.rootPath }
    : null;

  /** The first line of every result: which repo the command touched. */
  const projectLine = (resolved: ResolvedProject): string => {
    const project = resolved.project;
    if (!project) return "[project: none; no project is open on this computer, so this ran in the home folder]";
    return `[project: ${project.displayName} · ${project.projectId} · ${project.rootPath}]`;
  };

  /** What every activity entry of one call shares. */
  const logBaseFor = (connection: RemoteMcpConnectionSummary, name: string): ActivityBase => ({
    connectionId: connection.id,
    label: connection.label,
    scope: connection.scope,
    ...(name && name !== TOOL_NAME ? { tool: name } : {}),
  });

  /** Logs a refusal and answers it; `headLine` (the project line) goes first when the call got that far. */
  const refuse = (
    logBase: ActivityBase,
    reason: string,
    extra: { command?: string; project?: string; headLine?: string } = {},
  ): RemoteMcpToolResult => {
    deps.record({
      ...logBase,
      ...(extra.project ? { project: extra.project } : {}),
      command: extra.command ?? "",
      outcome: "refused",
      exitCode: null,
      durationMs: 0,
      detail: reason,
    });
    return toolError(extra.headLine ? `${extra.headLine}\n${reason}` : reason);
  };

  const clampTimeoutSeconds = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS / 1000;
    return Math.min(MAX_TIMEOUT_MS / 1000, Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)));
  };

  /** Runs one call on this computer. */
  const callTool = async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>): Promise<RemoteMcpToolResult> => {
    const typed = params.name === TOOL_NAME ? null : findTypedTool(params.name);
    if (params.name !== TOOL_NAME && !typed) {
      const names = [TOOL_NAME, ...typedToolsFor(connection.scope).map((tool) => tool.name)].join(", ");
      return toolError(`Unknown tool "${String(params.name)}". The tools are: ${names}.`);
    }
    const input = asRecord(params.arguments);
    const logBase = logBaseFor(connection, typed?.name ?? TOOL_NAME);
    const resolved = resolveProject(input.project);
    if ("error" in resolved) return refuse(logBase, resolved.error);
    const projectName = resolved.project?.displayName;
    // A refusal still names the project, like every other result.
    const refuseHere = (command: string, reason: string) =>
      refuse(logBase, reason, { command, project: projectName, headLine: projectLine(resolved) });
    // Write tools are not listed for a read-only connection; one that calls
    // one anyway gets the reason, not a policy list.
    if (typed?.write && connection.scope !== "write") {
      return refuseHere("", `This connection is read-only, so it can't run ${typed.name}. The person can give this app full access in ADE Settings → ADE MCP.`);
    }
    let words: unknown;
    let stdin: string | null = null;
    if (typed) {
      const defaults = typed.launchDefaults ? deps.launchDefaults?.() ?? null : null;
      const built = typed.build(defaults && typed.launchDefaults ? typed.launchDefaults(input, defaults) : input);
      if ("error" in built) return refuseHere("", built.error);
      words = built.argv;
    } else {
      words = input.args;
      if (words === undefined && typeof input.command === "string") {
        words = splitCommandLine(input.command);
        if (words === null) return refuseHere("", "The command has an unclosed quote.");
      }
      if (typeof input.stdin === "string") {
        if (Buffer.byteLength(input.stdin, "utf8") > MAX_STDIN_BYTES) {
          return refuseHere("", `\`stdin\` is larger than ${MAX_STDIN_BYTES / 1024} KB.`);
        }
        stdin = input.stdin;
      }
    }
    const verdict = checkRemoteAdeCommand(words, connection.scope, { hasStdin: stdin !== null });
    const loggedCommand = Array.isArray(words) ? redactedCommandForLog(words.filter((w): w is string => typeof w === "string")) : "";
    if (!verdict.ok) return refuseHere(loggedCommand, verdict.reason);
    const logged = { ...logBase, ...(projectName ? { project: projectName } : {}), command: loggedCommand };
    const connectionRuns = runsByConnection.get(connection.id) ?? 0;
    if (activeRuns >= MAX_CONCURRENT_REMOTE_RUNS) {
      deps.record({ ...logged, outcome: "busy", exitCode: null, durationMs: 0 });
      return toolError(`This computer is already running ${MAX_CONCURRENT_REMOTE_RUNS} remote commands. Wait for one to finish, then retry.`);
    }
    if (connectionRuns >= MAX_CONCURRENT_RUNS_PER_CONNECTION) {
      deps.record({ ...logged, outcome: "busy", exitCode: null, durationMs: 0 });
      return toolError(`This app already has ${MAX_CONCURRENT_RUNS_PER_CONNECTION} commands running. Wait for one to finish, then retry.`);
    }
    const timeoutMs = typed?.timeoutMs ? typed.timeoutMs(input) : clampTimeoutSeconds(input.timeout_seconds) * 1000;
    const runIn = (cwd: string) => runAdeForRemote({
      argv: verdict.args,
      cwd,
      timeoutMs,
      connectionId: connection.id,
      connectionLabel: connection.label,
      role: connection.scope === "write" ? "cto" : "agent",
      stdin,
      ...(typed?.maxOutputBytes ? { maxOutputBytes: typed.maxOutputBytes } : {}),
    });
    const everyProject = typed?.everyProject && !nonEmptyString(input.project) ? recentProjects() : null;
    activeRuns += 1;
    runsByConnection.set(connection.id, connectionRuns + 1);
    let result: RemoteRunResult;
    try {
      if (typed && everyProject && everyProject.length > 1) {
        // One slot for the whole sweep, so a sweep cannot take every run this computer has.
        return await sweepProjects(typed, input, everyProject, runIn, logBase, loggedCommand);
      }
      result = await runIn(resolved.cwd);
    } catch (error) {
      const message = getErrorMessage(error);
      deps.record({ ...logged, outcome: "failed", exitCode: null, durationMs: 0, detail: message });
      return toolError(message);
    } finally {
      activeRuns -= 1;
      const left = (runsByConnection.get(connection.id) ?? 1) - 1;
      if (left > 0) runsByConnection.set(connection.id, left);
      else runsByConnection.delete(connection.id);
    }
    const answered = (typed?.okExitCodes ?? [0]).includes(result.exitCode ?? -1);
    const outcome: RemoteMcpActivityOutcome = result.timedOut ? "timeout" : answered ? "ok" : "failed";
    // `ade help` once ran past a minute on a computer where it takes half a
    // second; a slow run says where its time went.
    if (result.timedOut || (result.durationMs > SLOW_RUN_MS && !typed?.timeoutMs)) {
      deps.warn?.("remote_mcp.slow_run", {
        command: loggedCommand,
        durationMs: result.durationMs,
        launchMs: result.launchMs ?? null,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
      });
    }
    deps.record({ ...logged, outcome, exitCode: result.exitCode, durationMs: result.durationMs });
    const headLine = projectLine(resolved);
    if (typed) return buildTypedToolResult(typed, input, result, { headLine, project: projectSummary(resolved) });
    return {
      content: [{ type: "text", text: `${headLine}\n${toolText(result)}` }],
      isError: result.timedOut || result.exitCode !== 0,
    };
  };

  /**
   * A typed tool with `everyProject`, run in each recent project two at a
   * time and merged into one result. A project whose run fails (or throws) is
   * named as missed; the sweep fails only when none answered.
   */
  const sweepProjects = async (
    tool: TypedTool,
    input: Record<string, unknown>,
    projects: readonly RemoteMcpProject[],
    runIn: (cwd: string) => Promise<RemoteRunResult>,
    logBase: ActivityBase,
    command: string,
  ): Promise<RemoteMcpToolResult> => {
    const parts = await mapWithLimit(projects, EVERY_PROJECT_PARALLEL, async (project) => {
      let run: RemoteRunResult;
      try {
        run = await runIn(project.rootPath);
      } catch (error) {
        // Settle like a failed run, so the slot is held until every sibling is done.
        run = failedRun(getErrorMessage(error));
      }
      return { project, run, parsed: parseTypedRun(tool, input, run) };
    });
    const answered = parts.flatMap((part) => (part.parsed ? [{ project: part.project, value: part.parsed.value }] : []));
    const durationMs = Math.max(0, ...parts.map((part) => part.run.durationMs));
    deps.record({
      ...logBase,
      command,
      outcome: answered.length ? "ok" : "failed",
      exitCode: answered.length ? 0 : null,
      durationMs,
      detail: `${answered.length} of ${parts.length} projects`,
    });
    if (!answered.length) {
      return toolError(`Couldn't read any project on this computer:\n${parts.map((part) => `${part.project.displayName}: ${toolText(part.run, tool.maxOutputBytes)}`).join("\n")}`);
    }
    const value = tool.everyProject!.merge(answered.map((part) => ({
      project: { id: part.project.projectId, name: part.project.displayName },
      result: part.value,
    })));
    const missed = parts.filter((part) => !part.parsed).map((part) => part.project.displayName);
    const headLine = `[projects: ${answered.map((part) => part.project.displayName).join(", ")}${missed.length ? `; couldn't read ${missed.join(", ")}` : ""}]`;
    return shapedToolResult(tool, input, value, { headLine, project: null });
  };

  /**
   * `ade help --json` as this scope sees it, read once and kept a few minutes.
   * Callers that arrive while it is being read share that one read.
   */
  const commandCatalog = (scope: RemoteMcpScope): Promise<string> => {
    const cached = catalogByScope.get(scope);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.text;
    const reading = readCommandCatalog(scope);
    catalogByScope.set(scope, { at: Date.now(), text: reading });
    // A failed read is not kept, so the next call tries again.
    reading.catch(() => {
      if (catalogByScope.get(scope)?.text === reading) catalogByScope.delete(scope);
    });
    return reading;
  };

  const readCommandCatalog = async (scope: RemoteMcpScope): Promise<string> => {
    const resolved = resolveProject(undefined);
    const result = await runAdeForRemote({
      argv: ["help", "--json"],
      cwd: "error" in resolved ? os.homedir() : resolved.cwd,
      timeoutMs: 30_000,
      connectionId: "catalog",
      connectionLabel: "ADE MCP",
      role: scope === "write" ? "cto" : "agent",
    });
    if (result.exitCode !== 0 || result.truncated) throw new Error("ADE could not list its commands right now.");
    return result.stdout;
  };

  const skillUnreadable = (filePath: string, error: unknown): void => {
    deps.warn?.("remote_mcp.skill_unreadable", { path: filePath, error: getErrorMessage(error) });
  };

  // ── Other computers of the account ────────────────────────────────────────

  /**
   * Every call may name a computer (`machine`). This one runs it as before;
   * another one gets the same `tools/call` through the relay (remoteMcpForward.ts)
   * and its answer comes back marked `[machine: …]`. List tools take "all".
   *
   * A connection from before accounts (`onlyMachine`) reaches only the
   * computer it was made on: on the account address its calls go there, and
   * anywhere else they are refused, whatever they name.
   */
  const routeToolCall = async (
    connection: RemoteMcpConnectionSummary,
    params: Record<string, unknown>,
    context: RemoteMcpCallContext,
  ): Promise<RemoteMcpToolResult> => {
    const router = deps.machines;
    const name = typeof params.name === "string" ? params.name : "";
    const input = asRecord(params.arguments);
    const logBase = logBaseFor(connection, name);
    const self = router.thisMachine();
    const only = connection.onlyMachine ?? null;
    const onlyElsewhere = only !== null && only.machineKey !== self.key;
    if (onlyElsewhere && (!context.accountMount || context.via)) return refuse(logBase, onlyMachineRefusal(only));
    if (name === MACHINES_TOOL_NAME) return await machinesListResult(logBase);
    const { machine: selector, ...rest } = input;
    const localParams = { ...params, arguments: rest };
    if (selector === undefined || selector === null || selector === "") {
      if (onlyElsewhere) return await forwardToOnlyMachine(connection, name, rest, only, context, logBase);
      // A chat id with no computer: the chat's own computer answers. A call
      // forwarded here already went its one hop, so it is answered here.
      const sessionId = CHAT_ID_TOOL_NAMES.has(name) && !context.via ? nonEmptyString(rest.session) : null;
      // Remembered per connection: one app's lookups never steer another's.
      const homeKey = sessionId ? `${connection.id}:${sessionId}` : null;
      const rememberedKey = homeKey ? chatHomes.get(homeKey) : undefined;
      if (homeKey && rememberedKey && (!only || only.machineKey === rememberedKey)) {
        const remembered = await router.resolve(rememberedKey);
        if (remembered.kind === "remote" && !router.unavailableReason(remembered.machine)) {
          const result = await forwardTo(connection, name, rest, remembered.machine, context, forwardTimeoutMs(name, rest));
          if (!isChatMiss(name, result)) return result;
        }
        chatHomes.delete(homeKey);
      }
      const result = await callTool(connection, params);
      if (sessionId && homeKey && isChatMiss(name, result)) {
        const elsewhere = await chatElsewhere(connection, sessionId, only, logBase);
        if (elsewhere && "refusal" in elsewhere) return elsewhere.refusal;
        if (elsewhere) {
          rememberChatHome(homeKey, elsewhere.machine.machineKey);
          return await forwardTo(connection, name, rest, elsewhere.machine, context, forwardTimeoutMs(name, rest));
        }
      }
      // On the account address any computer may answer: say which one did.
      return context.accountMount ? withMachineLabel(result, self) : result;
    }
    if (typeof selector !== "string") return refuse(logBase, "`machine` must be a computer's name or key from machines_list.");
    if (selector.trim().toLowerCase() === "all") {
      if (!findTypedTool(name)?.fanOut) {
        return refuse(logBase, `machine "all" works with ${FAN_OUT_TOOL_NAMES.join(", ")}. Name one computer for ${name}.`);
      }
      if (context.via) return refuse(logBase, `This call came through ${context.via}; ADE MCP sends a call on one hop only.`);
      return await fanOut(connection, name, localParams, rest, context, only?.machineKey ?? null);
    }
    const resolved = await router.resolve(selector);
    if (resolved.kind === "error") return refuse(logBase, resolved.message);
    const targetKey = resolved.kind === "here" ? resolved.machine.key : resolved.machine.machineKey;
    if (only && targetKey !== only.machineKey) return refuse(logBase, onlyMachineRefusal(only));
    if (resolved.kind === "here") return withMachineLabel(await callTool(connection, localParams), resolved.machine);
    if (context.via) {
      return refuse(
        logBase,
        `This call came through ${context.via}; ADE MCP sends a call on one hop only, so it can't reach ${resolved.machine.name} from here.`,
      );
    }
    const reason = router.unavailableReason(resolved.machine);
    if (reason) return refuse(logBase, reason);
    return await forwardTo(connection, name, rest, resolved.machine, context, forwardTimeoutMs(name, rest));
  };

  /** Connection and chat id → the computer that answered for it, so the next call goes straight there. */
  const chatHomes = new Map<string, string>();
  const rememberChatHome = (key: string, machineKey: string): void => {
    chatHomes.delete(key);
    chatHomes.set(key, machineKey);
    // Oldest first: a long-lived brain keeps the most recent few hundred.
    while (chatHomes.size > MAX_CHAT_HOMES) chatHomes.delete(chatHomes.keys().next().value!);
  };

  /**
   * The other computer that has `sessionId` (`ade chat locate`: one read-only
   * question to each online computer). Null when none does; a refusal when one
   * does but this connection can't reach it.
   */
  const chatElsewhere = async (
    connection: RemoteMcpConnectionSummary,
    sessionId: string,
    only: RemoteMcpConnectionSummary["onlyMachine"] | null,
    logBase: ActivityBase,
  ): Promise<{ machine: RemoteMcpRosterMachine } | { refusal: RemoteMcpToolResult } | null> => {
    let located: unknown;
    try {
      const run = await runAdeForRemote({
        argv: ["chat", "locate", sessionId, "--json"],
        cwd: os.homedir(),
        timeoutMs: CHAT_LOCATE_TIMEOUT_MS,
        connectionId: connection.id,
        connectionLabel: connection.label,
        role: "agent",
      });
      located = run.exitCode === 0 ? JSON.parse(run.stdout) : null;
    } catch (error) {
      // The call still answers as "not found here"; the log says why no computer was asked.
      deps.warn?.("remote_mcp.chat_locate_failed", { error: getErrorMessage(error) });
      return null;
    }
    const machine = asRecord(asRecord(located).machine);
    const key = nonEmptyString(machine.key);
    if (!key || machine.isThisMachine === true) return null;
    const resolved = await deps.machines.resolve(key);
    if (resolved.kind !== "remote") return null;
    if (only && only.machineKey !== key) {
      return { refusal: refuse(logBase, `This chat is on ${resolved.machine.name}. ${onlyMachineRefusal(only)}`) };
    }
    const reason = deps.machines.unavailableReason(resolved.machine);
    if (reason) return { refusal: refuse(logBase, `This chat is on ${resolved.machine.name}. ${reason}`) };
    return { machine: resolved.machine };
  };

  /** A connection from before accounts, on the account address of another computer: its call goes to its own. */
  const forwardToOnlyMachine = async (
    connection: RemoteMcpConnectionSummary,
    name: string,
    input: Record<string, unknown>,
    only: NonNullable<RemoteMcpConnectionSummary["onlyMachine"]>,
    context: RemoteMcpCallContext,
    logBase: ActivityBase,
  ): Promise<RemoteMcpToolResult> => {
    const resolved = await deps.machines.resolve(only.machineKey);
    if (resolved.kind !== "remote") return refuse(logBase, onlyMachineRefusal(only));
    const reason = deps.machines.unavailableReason(resolved.machine);
    if (reason) return refuse(logBase, reason);
    return await forwardTo(connection, name, input, resolved.machine, context, forwardTimeoutMs(name, input));
  };

  /** The forwarded call's budget: the tool's own timeout plus room for the trip, at most 10 minutes. */
  const forwardTimeoutMs = (name: string, input: Record<string, unknown>): number => {
    const typed = name === TOOL_NAME ? null : findTypedTool(name);
    const toolMs = typed?.timeoutMs ? typed.timeoutMs(input) : clampTimeoutSeconds(input.timeout_seconds) * 1000;
    return Math.min(MAX_FORWARD_MS, toolMs + FORWARD_EXTRA_MS);
  };

  /** The `ade` tool's command for this computer's log; a typed tool's is logged where it runs. */
  const commandForLog = (name: string, input: Record<string, unknown>): string => {
    if (name !== TOOL_NAME) return "";
    const words = Array.isArray(input.args)
      ? input.args
      : typeof input.command === "string" ? splitCommandLine(input.command) : null;
    return Array.isArray(words) ? redactedCommandForLog(words.filter((word): word is string => typeof word === "string")) : "";
  };

  const firstText = (result: RemoteMcpToolResult): string =>
    result.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? "";

  const forwardTo = async (
    connection: RemoteMcpConnectionSummary,
    name: string,
    input: Record<string, unknown>,
    machine: RemoteMcpRosterMachine,
    context: RemoteMcpCallContext,
    timeoutMs: number,
  ): Promise<RemoteMcpToolResult> => {
    const started = Date.now();
    const result = await deps.machines.forward(machine, { name, arguments: input }, context, timeoutMs);
    deps.record({
      ...logBaseFor(connection, name),
      command: commandForLog(name, input),
      outcome: result.isError ? "failed" : "ok",
      exitCode: null,
      durationMs: Date.now() - started,
      forwardedTo: machine.name,
      ...(result.isError ? { detail: firstText(result) } : {}),
    });
    return withMachineLabel(result, { key: machine.machineKey, name: machine.name });
  };

  /**
   * A list tool on every included computer at once (or, for a connection
   * from before accounts, on its one computer), at most six in flight, one
   * row per computer.
   */
  const fanOut = async (
    connection: RemoteMcpConnectionSummary,
    name: string,
    localParams: Record<string, unknown>,
    input: Record<string, unknown>,
    context: RemoteMcpCallContext,
    onlyMachineKey: string | null,
  ): Promise<RemoteMcpToolResult> => {
    const router = deps.machines;
    const targets = (await router.roster()).filter((machine) =>
      (machine.isThisMachine || machine.included) && (!onlyMachineKey || machine.machineKey === onlyMachineKey));
    const self = router.thisMachine();
    const timeoutMs = Math.min(forwardTimeoutMs(name, input), FAN_OUT_TIMEOUT_MS);
    const rows = await mapWithLimit(targets, MAX_FAN_OUT, async (machine) => {
      const ref = machine.isThisMachine ? self : { key: machine.machineKey, name: machine.name };
      const reason = machine.isThisMachine ? null : router.unavailableReason(machine);
      const result = reason
        ? toolError(reason)
        : machine.isThisMachine
          ? await callTool(connection, localParams)
          : await forwardTo(connection, name, input, machine, context, timeoutMs);
      const text = firstText(result).replace(/^\[machine: [^\]\n]*\]\n?/, "");
      return result.isError
        ? { machine: ref, ok: false, error: text, text }
        : { machine: ref, ok: true, result: result.structuredContent ?? { text }, text };
    });
    return {
      content: [{
        type: "text",
        text: rows.map((row) => `[machine: ${row.machine.name}]${row.ok ? "" : " failed"}\n${row.text}`).join("\n\n")
          || "No computers to ask.",
      }],
      structuredContent: { view: name, machines: rows.map(({ text: _text, ...row }) => row) },
      isError: rows.length > 0 && rows.every((row) => !row.ok),
    };
  };

  const machinesListResult = async (logBase: ActivityBase): Promise<RemoteMcpToolResult> => {
    const started = Date.now();
    const roster = await deps.machines.roster();
    const machines = roster.map((machine) => ({
      name: machine.name,
      key: machine.machineKey,
      online: machine.online,
      included: machine.included,
      // null: its ADE never reported, so whether it serves is unknown.
      serving: machine.servingKnown ? machine.serving : null,
      notServingReason: machine.notServingReason,
      reportedAt: machine.reportedAt,
      supported: machine.supported,
      isThisMachine: machine.isThisMachine,
    }));
    deps.record({ ...logBase, command: "", outcome: "ok", exitCode: null, durationMs: Date.now() - started });
    const describe = (machine: (typeof roster)[number]) => [
      machine.isThisMachine ? `${machine.name} (answering)` : machine.name,
      machine.online === null ? "online unknown" : machine.online ? "online" : "offline",
      rosterStateWords(machine),
    ].join(" · ");
    return {
      content: [{ type: "text", text: roster.map(describe).join("\n") || "No computers found." }],
      structuredContent: { view: MACHINES_TOOL_NAME, machines },
      isError: false,
    };
  };

  const machineInput = (toolName: string) => ({
    type: "string",
    description: findTypedTool(toolName)?.fanOut
      ? "Computer (machines_list) or \"all\". Default: this one."
      : CHAT_ID_TOOL_NAMES.has(toolName)
        ? "Computer (machines_list). Default: the chat's computer."
        : "Computer (machines_list). Default: this one.",
  });

  const machinesToolDefinition = () => ({
    name: MACHINES_TOOL_NAME,
    title: "List computers",
    description: "The computers on this ADE account: online, serving or why not, and which one answers.",
    inputSchema: { type: "object", properties: {} as Record<string, unknown> },
    annotations: { readOnlyHint: true, openWorldHint: false },
  });

  /** Adds `machine` to every tool and lists machines_list. */
  const withMachineTools = <T extends { name: string; inputSchema: { properties?: Record<string, unknown> } }>(
    tools: T[],
  ): Array<T | ReturnType<typeof machinesToolDefinition>> => [
    ...tools.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, machine: machineInput(tool.name) } },
    })),
    machinesToolDefinition(),
  ];

  const handleRpc = async (
    connection: RemoteMcpConnectionSummary,
    message: JsonRpcMessage | null,
    /** What the HTTP layer knows: the bearer, a forwarding computer, the address used. */
    context: RemoteMcpCallContext = NO_CALL_CONTEXT,
  ): Promise<Record<string, unknown> | null> => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
    }
    const id = message.id;
    const isRequest = id !== undefined && id !== null && (typeof id === "string" || typeof id === "number");
    const method = typeof message.method === "string" ? message.method : "";
    // Notifications and stray responses need no answer.
    if (!isRequest) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (message.jsonrpc !== "2.0" || !method) return fail(-32600, "Invalid JSON-RPC request.");
    const params = asRecord(message.params);
    // A connection kept to another computer reads none of this one's
    // projects: no skills and no command catalog (the tools refuse it too).
    const only = connection.onlyMachine ?? null;
    if (only && only.machineKey !== deps.machines.thisMachine().key) {
      if (method === "prompts/list") return reply({ prompts: [] });
      if (method === "prompts/get" || (method === "resources/read" && params.uri === COMMANDS_RESOURCE_URI)) {
        return fail(-32602, onlyMachineRefusal(only));
      }
    }
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : REMOTE_MCP_DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "ade", title: `ADE on ${deps.machineName()}`, version: remoteMcpAdeVersion() },
          instructions: instructions(connection.scope),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        // MCP Apps: tools with a view carry `_meta.ui.resourceUri` (remoteMcpApps.ts).
        return reply({
          tools: withMachineTools([toolDefinition(connection.scope), ...typedToolsFor(connection.scope).map(typedToolDefinition)]).map(withAppUi),
        });
      case "tools/call":
        return reply(await routeToolCall(connection, params, context));
      case "resources/list":
        return reply({
          resources: [{
            uri: COMMANDS_RESOURCE_URI,
            name: "commands",
            title: "ADE commands",
            description: "Every ade command this connection can run, with a summary and examples (ade help --json).",
            mimeType: "application/json",
          }, adeAppResourceListing()],
        });
      case "resources/read": {
        const appResource = readAdeAppResource(params.uri);
        if (appResource) return reply(appResource);
        if (params.uri !== COMMANDS_RESOURCE_URI) return fail(-32002, `Resource not found: ${String(params.uri)}`);
        try {
          const text = await commandCatalog(connection.scope);
          return reply({ contents: [{ uri: COMMANDS_RESOURCE_URI, mimeType: "application/json", text }] });
        } catch (error) {
          const message = getErrorMessage(error);
          deps.warn?.("remote_mcp.catalog_failed", { scope: connection.scope, error: message });
          return fail(-32603, message);
        }
      }
      case "prompts/list": {
        // Prompt names must be unique, so the list is the default project's;
        // prompts/get takes `project` for another one.
        const resolved = resolveProject(undefined);
        const skills = "error" in resolved || !resolved.project ? [] : listAgentSkills({ cwd: resolved.cwd, includeUser: false, onError: skillUnreadable });
        return reply({
          prompts: skills.slice(0, MAX_PROMPTS).map((skill) => ({
            name: skill.name,
            title: skill.name,
            description: skill.description.slice(0, MAX_PROMPT_DESCRIPTION_CHARS),
            arguments: [{ name: "project", description: PROJECT_INPUT.description, required: false }],
            _meta: { "ade/source": skill.source },
          })),
        });
      }
      case "prompts/get": {
        const name = typeof params.name === "string" ? params.name : "";
        const promptArgs = asRecord(params.arguments);
        const resolved = resolveProject(promptArgs.project);
        if ("error" in resolved) return fail(-32602, resolved.error);
        if (!resolved.project) return fail(-32602, "No project is open on this computer, so it has no skills to show.");
        // Personal skills in the home folder never leave this computer.
        const skill = name ? readAgentSkill(name, { cwd: resolved.cwd, includeUser: false, onError: skillUnreadable }) : null;
        if (!skill) {
          return fail(-32602, `No skill "${name}" in ${resolved.project.displayName}. See ["skill","list","--text"].`);
        }
        const heading = `Skill "${skill.entry.name}" (${skill.entry.source}) from ${resolved.project.displayName} at ${resolved.project.rootPath}.`;
        return reply({
          description: skill.entry.description,
          messages: [{ role: "user", content: { type: "text", text: `${heading}\n\n${skill.body}` } }],
        });
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };

  return { handleRpc };
}
