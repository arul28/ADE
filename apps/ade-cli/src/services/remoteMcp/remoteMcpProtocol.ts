import os from "node:os";
import path from "node:path";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import type {
  RemoteMcpActivityEntry,
  RemoteMcpActivityOutcome,
  RemoteMcpConnectionSummary,
  RemoteMcpScope,
} from "../../../../desktop/src/shared/types/remoteMcp";
import { listAgentSkills, readAgentSkill } from "../skills/agentSkillCatalogService";
import { checkRemoteAdeCommand, redactedCommandForLog, splitCommandLine } from "./remoteMcpCommandPolicy";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_STDIN_BYTES,
  MAX_TIMEOUT_MS,
  runAdeForRemote,
  type RemoteRunResult,
} from "./remoteMcpRunner";
import { findTypedTool, TYPED_TOOLS, type TypedTool } from "./remoteMcpTools";
import {
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

export const MAX_CONCURRENT_REMOTE_RUNS = 4;
/** One connection's share, so a long `chat_wait` cannot shut every other app out. */
export const MAX_CONCURRENT_RUNS_PER_CONNECTION = 3;
const MIN_TIMEOUT_SECONDS = 5;
const MACHINES_TOOL = "machines_list";
/** List-shaped tools that take `machine: "all"`. */
const FAN_OUT_TOOLS = new Set(["projects_list", "chat_list", "inbox", "usage_limits", "lanes_list"]);
const MAX_FAN_OUT = 6;
const FAN_OUT_TIMEOUT_MS = 60_000;
const FORWARD_EXTRA_MS = 30_000;
const MAX_FORWARD_MS = 10 * 60_000;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

declare const __ADE_VERSION__: string | undefined;

/** ADE's version, so a client can tell which tools and fixes this server has. */
function adeVersion(): string {
  const bundled = typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__.trim() : "";
  if (bundled && bundled !== "0.0.0") return bundled;
  return process.env.ADE_CLI_VERSION?.trim() || bundled || "0.0.0";
}

export function createRemoteMcpProtocol(deps: {
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
  record: (entry: Omit<RemoteMcpActivityEntry, "at">) => void;
  /** The provider and model this computer last launched a chat with, for chat_start. */
  launchDefaults?: () => { provider: string; model: string } | null;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  /**
   * The account's other computers. With it, every tool takes `machine` and
   * `machines_list` is listed; without it (a lone computer, tests) calls run here.
   */
  machines?: RemoteMcpMachineRouter;
}) {
  let activeRuns = 0;
  const runsByConnection = new Map<string, number>();
  const catalogByScope = new Map<RemoteMcpScope, { at: number; text: Promise<string> }>();

  // ── Projects ──────────────────────────────────────────────────────────────

  /**
   * The project a call runs in. Without `project`, the most recently opened
   * one, which changes when the person opens another: every result names it,
   * so a call never lands in a different repo unnoticed.
   */
  /** The projects an every-project sweep reads: opened in the last 30 days, at most six. */
  const recentProjects = (): RemoteMcpProject[] => {
    const projects = [...deps.listProjects()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const cutoff = Date.now() - EVERY_PROJECT_WINDOW_MS;
    const recent = projects.filter((project) => project.lastOpenedAt >= cutoff);
    return (recent.length ? recent : projects.slice(0, 1)).slice(0, EVERY_PROJECT_MAX);
  };

  const resolveProject = (requested: unknown): ResolvedProject | { error: string } => {
    const projects = deps.listProjects();
    const found = (project: RemoteMcpProject): ResolvedProject => ({ cwd: project.rootPath, project });
    if (typeof requested !== "string" || !requested.trim()) {
      const recent = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
      // No project at all: machine-wide commands (`projects list`, `doctor`) still work.
      return recent ? found(recent) : { cwd: os.homedir(), project: null };
    }
    const wanted = requested.trim();
    const lower = wanted.toLowerCase();
    const exact = projects.filter((project) =>
      project.projectId === wanted
      || (path.isAbsolute(wanted) && samePathOnPlatform(project.rootPath, wanted)));
    if (exact.length === 1) return found(exact[0]!);
    const named = projects.filter((project) =>
      project.displayName.toLowerCase() === lower || path.basename(project.rootPath).toLowerCase() === lower);
    if (named.length === 1) return found(named[0]!);
    const known = projects.map((project) => project.displayName).join(", ") || "none";
    return named.length > 1
      ? { error: `More than one project is called "${wanted}". Pass its id or path instead (see ["projects","list","--text"]).` }
      : { error: `No project "${wanted}" on this computer. Projects: ${known}.` };
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

  const toolText = (result: RemoteRunResult, outputLimitBytes = MAX_OUTPUT_BYTES): string => {
    const parts: string[] = [];
    const stdout = result.stdout.trimEnd();
    const stderr = result.stderr.trimEnd();
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stdout ? `stderr:\n${stderr}` : stderr);
    if (result.truncated) {
      parts.push(`[Output was cut off at ${Math.round(outputLimitBytes / 1024)} KB. Narrow the command, e.g. with --text, filters or --limit.]`);
    }
    if (result.timedOut) parts.push(`[Stopped: the command ran past its time limit after ${Math.round(result.durationMs / 1000)}s.]`);
    else if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode ?? "unknown"}]`);
    return parts.join("\n\n") || "(no output)";
  };

  const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

  /** A typed tool's answer: the CLI's JSON, trimmed, as structured content. */
  const typedResult = (tool: TypedTool, input: Record<string, unknown>, result: RemoteRunResult, resolved: ResolvedProject) => {
    const ok = !result.timedOut && (tool.okExitCodes ?? [0]).includes(result.exitCode ?? -1);
    const failed = () => ({
      content: [{ type: "text", text: `${projectLine(resolved)}\n${toolText(result, tool.maxOutputBytes)}` }],
      isError: true,
    });
    if (!ok || result.truncated) return failed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return failed();
    }
    const value = tool.shape ? tool.shape(parsed, input) : parsed;
    // The next step rides in the result, where the model decides it.
    const next = tool.next?.(value, input) ?? null;
    return {
      content: [{ type: "text", text: `${projectLine(resolved)}\n${JSON.stringify(value)}${next ? `\nNext: ${next}` : ""}` }],
      structuredContent: { project: projectSummary(resolved), result: value, ...(next ? { next } : {}) },
      isError: false,
    };
  };

  const clampTimeoutSeconds = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS / 1000;
    return Math.min(MAX_TIMEOUT_MS / 1000, Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)));
  };

  const callTool = async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
    const typed = params.name === TOOL_NAME ? null : findTypedTool(params.name);
    if (params.name !== TOOL_NAME && !typed) {
      const names = [TOOL_NAME, ...typedToolsFor(connection.scope).map((tool) => tool.name)].join(", ");
      return toolError(`Unknown tool "${String(params.name)}". The tools are: ${names}.`);
    }
    const input = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    const logBase = {
      connectionId: connection.id,
      label: connection.label,
      scope: connection.scope,
      ...(typed ? { tool: typed.name } : {}),
    };
    const resolved = resolveProject(input.project);
    if ("error" in resolved) {
      deps.record({ ...logBase, command: "", outcome: "refused", exitCode: null, durationMs: 0, detail: resolved.error });
      return toolError(resolved.error);
    }
    const inProject = resolved.project ? { project: resolved.project.displayName } : {};
    /** A refusal still names the project, like every other result. */
    const refuse = (command: string, reason: string) => {
      deps.record({ ...logBase, ...inProject, command, outcome: "refused", exitCode: null, durationMs: 0, detail: reason });
      return toolError(`${projectLine(resolved)}\n${reason}`);
    };
    // Write tools are not listed for a read-only connection; one that calls
    // one anyway gets the reason, not a policy list.
    if (typed?.write && connection.scope !== "write") {
      return refuse("", `This connection is read-only, so it can't run ${typed.name}. The person can give this app full access in ADE Settings → ADE MCP.`);
    }
    let words: unknown;
    let stdin: string | null = null;
    if (typed) {
      const defaults = typed.launchDefaults ? deps.launchDefaults?.() ?? null : null;
      const built = typed.build(defaults && typed.launchDefaults ? typed.launchDefaults(input, defaults) : input);
      if ("error" in built) return refuse("", built.error);
      words = built.argv;
    } else {
      words = input.args;
      if (words === undefined && typeof input.command === "string") {
        words = splitCommandLine(input.command);
        if (words === null) return refuse("", "The command has an unclosed quote.");
      }
      if (typeof input.stdin === "string") {
        if (Buffer.byteLength(input.stdin, "utf8") > MAX_STDIN_BYTES) {
          return refuse("", `\`stdin\` is larger than ${MAX_STDIN_BYTES / 1024} KB.`);
        }
        stdin = input.stdin;
      }
    }
    const verdict = checkRemoteAdeCommand(words, connection.scope, { hasStdin: stdin !== null });
    const loggedCommand = Array.isArray(words) ? redactedCommandForLog(words.filter((w): w is string => typeof w === "string")) : "";
    if (!verdict.ok) return refuse(loggedCommand, verdict.reason);
    const logged = { ...logBase, ...inProject, command: loggedCommand };
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
      if (everyProject && everyProject.length > 1 && typed?.everyProject) {
        // One slot for the whole sweep, two projects at a time, so a sweep
        // cannot take every run this computer has.
        const parts = await mapWithLimit(everyProject, EVERY_PROJECT_PARALLEL, async (project) => {
          const run = await runIn(project.rootPath);
          const ok = !run.timedOut && !run.truncated && (typed.okExitCodes ?? [0]).includes(run.exitCode ?? -1);
          let value: unknown = null;
          if (ok) {
            try { value = typed.shape ? typed.shape(JSON.parse(run.stdout), input) : JSON.parse(run.stdout); } catch { value = null; }
          }
          return { project, run, value };
        });
        const answered = parts.filter((part) => part.value !== null);
        const durationMs = Math.max(0, ...parts.map((part) => part.run.durationMs));
        const outcome: RemoteMcpActivityOutcome = answered.length ? "ok" : "failed";
        deps.record({ ...logged, project: undefined, outcome, exitCode: answered.length ? 0 : null, durationMs, detail: `${answered.length} of ${parts.length} projects` });
        if (!answered.length) {
          return toolError(`Couldn't read any project on this computer:\n${parts.map((part) => `${part.project.displayName}: ${toolText(part.run, typed.maxOutputBytes)}`).join("\n")}`);
        }
        const value = typed.everyProject.merge(answered.map((part) => ({
          project: { id: part.project.projectId, name: part.project.displayName },
          result: part.value,
        })));
        const missed = parts.filter((part) => part.value === null).map((part) => part.project.displayName);
        const next = typed.next?.(value, input) ?? null;
        const scopeLine = `[projects: ${answered.map((part) => part.project.displayName).join(", ")}${missed.length ? `; couldn't read ${missed.join(", ")}` : ""}]`;
        return {
          content: [{ type: "text", text: `${scopeLine}\n${JSON.stringify(value)}${next ? `\nNext: ${next}` : ""}` }],
          structuredContent: { project: null, result: value, ...(next ? { next } : {}) },
          isError: false,
        };
      }
      result = await runIn(resolved.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    deps.record({ ...logged, outcome, exitCode: result.exitCode, durationMs: result.durationMs });
    if (typed) return typedResult(typed, input, result, resolved);
    return {
      content: [{ type: "text", text: `${projectLine(resolved)}\n${toolText(result)}` }],
      isError: result.timedOut || result.exitCode !== 0,
    };
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
    deps.warn?.("remote_mcp.skill_unreadable", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  // ── Other computers of the account ────────────────────────────────────────

  /**
   * Every call may name a computer (`machine`). This one runs it as before;
   * another one gets the same `tools/call` through the relay (remoteMcpForward.ts)
   * and its answer comes back marked `[machine: …]`. List tools take "all".
   */
  const routeToolCall = async (
    connection: RemoteMcpConnectionSummary,
    params: Record<string, unknown>,
    context: RemoteMcpCallContext | undefined,
  ): Promise<unknown> => {
    const router = deps.machines;
    if (!router) return await callTool(connection, params);
    const name = typeof params.name === "string" ? params.name : "";
    const input = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const logBase = {
      connectionId: connection.id,
      label: connection.label,
      scope: connection.scope,
      ...(name !== TOOL_NAME ? { tool: name } : {}),
    };
    const refuse = (reason: string) => {
      deps.record({ ...logBase, command: "", outcome: "refused", exitCode: null, durationMs: 0, detail: reason });
      return toolError(reason);
    };
    if (name === MACHINES_TOOL) return await machinesListResult(router, logBase);
    if (input.machine === undefined || input.machine === null || input.machine === "") {
      const result = await callTool(connection, params) as RemoteMcpToolResult;
      // On the account address any computer may answer: say which one did.
      return context?.accountMount ? withMachineLabel(result, router.thisMachine()) : result;
    }
    if (typeof input.machine !== "string") return refuse("`machine` must be a computer's name or key from machines_list.");
    const { machine: selector, ...rest } = input;
    const localParams = { ...params, arguments: rest };
    if ((selector as string).trim().toLowerCase() === "all") {
      if (!FAN_OUT_TOOLS.has(name)) {
        return refuse(`machine "all" works with ${[...FAN_OUT_TOOLS].join(", ")}. Name one computer for ${name}.`);
      }
      if (context?.via) return refuse(`This call came through ${context.via}; ADE MCP sends a call on one hop only.`);
      return await fanOut(connection, name, localParams, rest, context, router);
    }
    const resolved = await router.resolve(selector as string);
    if (resolved.kind === "error") return refuse(resolved.message);
    if (resolved.kind === "here") {
      return withMachineLabel(await callTool(connection, localParams) as RemoteMcpToolResult, resolved.machine);
    }
    if (context?.via) {
      return refuse(
        `This call came through ${context.via}; ADE MCP sends a call on one hop only, so it can't reach ${resolved.machine.name} from here.`,
      );
    }
    const reason = router.unavailableReason(resolved.machine);
    if (reason) return refuse(reason);
    return await forwardTo(connection, name, rest, resolved.machine, context, forwardTimeoutMs(name, rest), router);
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
    context: RemoteMcpCallContext | undefined,
    timeoutMs: number,
    router: RemoteMcpMachineRouter,
  ): Promise<RemoteMcpToolResult> => {
    const started = Date.now();
    const result = await router.forward(
      machine,
      { name, arguments: input },
      context ?? { bearer: null, via: null, protocolVersion: null, accountMount: false },
      timeoutMs,
    );
    deps.record({
      connectionId: connection.id,
      label: connection.label,
      scope: connection.scope,
      ...(name !== TOOL_NAME ? { tool: name } : {}),
      command: commandForLog(name, input),
      outcome: result.isError ? "failed" : "ok",
      exitCode: null,
      durationMs: Date.now() - started,
      forwardedTo: machine.name,
      ...(result.isError ? { detail: firstText(result) } : {}),
    });
    return withMachineLabel(result, { key: machine.machineKey, name: machine.name });
  };

  /** A list tool on every included computer at once, at most six in flight, one row per computer. */
  const fanOut = async (
    connection: RemoteMcpConnectionSummary,
    name: string,
    localParams: Record<string, unknown>,
    input: Record<string, unknown>,
    context: RemoteMcpCallContext | undefined,
    router: RemoteMcpMachineRouter,
  ) => {
    const targets = (await router.roster()).filter((machine) => machine.isThisMachine || machine.included);
    const self = router.thisMachine();
    const timeoutMs = Math.min(forwardTimeoutMs(name, input), FAN_OUT_TIMEOUT_MS);
    type Row = { machine: { key: string; name: string }; ok: boolean; result?: unknown; error?: string; text: string };
    const rows: Row[] = new Array(targets.length);
    const runOne = async (index: number) => {
      const machine = targets[index]!;
      const ref = machine.isThisMachine ? self : { key: machine.machineKey, name: machine.name };
      const reason = machine.isThisMachine ? null : router.unavailableReason(machine);
      let result: RemoteMcpToolResult;
      if (reason) result = toolError(reason);
      else if (machine.isThisMachine) result = await callTool(connection, localParams) as RemoteMcpToolResult;
      else result = await forwardTo(connection, name, input, machine, context, timeoutMs, router);
      const text = firstText(result).replace(/^\[machine: [^\]\n]*\]\n?/, "");
      rows[index] = result.isError
        ? { machine: ref, ok: false, error: text, text }
        : { machine: ref, ok: true, result: result.structuredContent ?? { text }, text };
    };
    let next = 0;
    const worker = async () => {
      while (next < targets.length) await runOne(next++);
    };
    await Promise.all(Array.from({ length: Math.min(MAX_FAN_OUT, targets.length) }, worker));
    return {
      content: [{
        type: "text",
        text: rows.map((row) => `[machine: ${row.machine.name}]${row.ok ? "" : " failed"}\n${row.text}`).join("\n\n")
          || "No computers to ask.",
      }],
      structuredContent: { machines: rows.map(({ text: _text, ...row }) => row) },
      isError: rows.length > 0 && rows.every((row) => !row.ok),
    };
  };

  const machinesListResult = async (
    router: RemoteMcpMachineRouter,
    logBase: { connectionId: string; label: string; scope: RemoteMcpScope },
  ) => {
    const started = Date.now();
    const machines = (await router.roster()).map((machine) => ({
      name: machine.name,
      key: machine.machineKey,
      online: machine.online,
      included: machine.included,
      serving: machine.serving,
      supported: machine.supported,
      isThisMachine: machine.isThisMachine,
    }));
    deps.record({ ...logBase, tool: MACHINES_TOOL, command: "", outcome: "ok", exitCode: null, durationMs: Date.now() - started });
    const describe = (machine: (typeof machines)[number]) => [
      machine.isThisMachine ? `${machine.name} (answering)` : machine.name,
      machine.online === null ? "online unknown" : machine.online ? "online" : "offline",
      !machine.supported ? "not joined yet (open the latest ADE on it)" : !machine.included ? "left out" : machine.serving ? "serving" : "not serving",
    ].join(" · ");
    return {
      content: [{ type: "text", text: machines.map(describe).join("\n") || "No computers found." }],
      structuredContent: { machines },
      isError: false,
    };
  };

  const machineInput = (toolName: string) => ({
    type: "string",
    description: FAN_OUT_TOOLS.has(toolName)
      ? "Computer (machines_list) or \"all\". Default: this one."
      : "Computer (machines_list). Default: this one.",
  });

  const machinesToolDefinition = () => ({
    name: MACHINES_TOOL,
    title: "List computers",
    description: "The computers on this ADE account: online, included, serving, and which one is answering.",
    inputSchema: { type: "object", properties: {} as Record<string, unknown> },
    annotations: { readOnlyHint: true, openWorldHint: false },
  });

  /** Adds `machine` to every tool and lists machines_list, when calls can reach other computers. */
  const withMachineTools = <T extends { name: string; inputSchema: { properties?: Record<string, unknown> } }>(
    tools: T[],
  ): Array<T | ReturnType<typeof machinesToolDefinition>> => {
    if (!deps.machines) return tools;
    return [
      ...tools.map((tool) => ({
        ...tool,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, machine: machineInput(tool.name) } },
      })),
      machinesToolDefinition(),
    ];
  };


  const handleRpc = async (
    connection: RemoteMcpConnectionSummary,
    message: JsonRpcMessage | null,
    /** What the HTTP layer knows: the bearer, a forwarding computer, the address used. */
    context?: RemoteMcpCallContext,
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
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "ade", title: `ADE on ${deps.machineName()}`, version: adeVersion() },
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
          const message = error instanceof Error ? error.message : String(error);
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
        const promptArgs = params.arguments && typeof params.arguments === "object"
          ? params.arguments as Record<string, unknown>
          : {};
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
