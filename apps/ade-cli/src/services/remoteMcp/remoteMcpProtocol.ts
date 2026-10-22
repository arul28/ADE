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
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = "ade";
const COMMANDS_RESOURCE_URI = "ade://commands";
const MAX_PROMPTS = 200;
const MAX_PROMPT_DESCRIPTION_CHARS = 1_024;
/** How long the command catalog is reused before it is read again. */
const CATALOG_TTL_MS = 5 * 60_000;

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
  warn?: (event: string, data?: Record<string, unknown>) => void;
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
    description: "Project name, id or path. Defaults to the most recently opened project; every result names the one used.",
  };

  const toolDefinition = (scope: RemoteMcpScope) => ({
    name: TOOL_NAME,
    title: "Run an ADE command",
    description: [
      `Runs ADE's \`ade\` command on ${deps.machineName()} and returns its output.`,
      "Pass the words after `ade` as `args`, e.g. [\"lanes\",\"list\",\"--text\"]. Add --text for readable output.",
      "For everyday reads, the typed tools (lanes_list, files_read, chat_read, prs_checks, …) take named inputs.",
      `What this connection can run: the ${COMMANDS_RESOURCE_URI} resource, or ["help","--json"]. `
        + "[\"help\",\"<command>\"] explains one command.",
      "Commands run in `project`, or the most recently opened project; every result starts with the project it ran in.",
      scope === "read"
        ? "This connection is READ-ONLY."
        : "This connection has full access: it can do anything the person could do with `ade` in a terminal.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "The command as a list of words, without the leading `ade`.",
        },
        command: {
          type: "string",
          description: "Instead of `args`: the same command as one string, e.g. \"lanes list --text\". Quotes group words; no shell runs it.",
        },
        project: PROJECT_INPUT,
        stdin: {
          type: "string",
          maxLength: MAX_STDIN_BYTES,
          description: "Text for the command's stdin, for commands that read it (`files write --stdin`, `--body-file -`).",
        },
        timeout_seconds: {
          type: "integer",
          minimum: MIN_TIMEOUT_SECONDS,
          maximum: MAX_TIMEOUT_MS / 1000,
          description: `Stop the command after this many seconds. Default ${DEFAULT_TIMEOUT_MS / 1000}.`,
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

  const typedToolDefinition = (tool: TypedTool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: { ...tool.properties, project: PROJECT_INPUT },
      ...(tool.required?.length ? { required: tool.required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  const instructions = (scope: RemoteMcpScope): string => [
    `This server is ADE on ${deps.machineName()}. ADE manages coding lanes (git worktrees), agent chats, PRs and proof.`,
    "Typed tools cover the everyday reads (projects_list, lanes_list, files_read, diff_changes, prs_list, chat_read, …).",
    "The `ade` tool runs any other ade command; the ade://commands resource lists the ones this connection can run.",
    "Without `project`, calls run in the most recently opened project; pass `project` to be sure.",
    scope === "read" ? "This connection is read-only." : "This connection has full access.",
  ].join("\n");

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
    return {
      content: [{ type: "text", text: `${projectLine(resolved)}\n${JSON.stringify(value)}` }],
      structuredContent: { project: projectSummary(resolved), result: value },
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
      const names = [TOOL_NAME, ...TYPED_TOOLS.map((tool) => tool.name)].join(", ");
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
    let words: unknown;
    let stdin: string | null = null;
    if (typed) {
      const built = typed.build(input);
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
    activeRuns += 1;
    runsByConnection.set(connection.id, connectionRuns + 1);
    let result: RemoteRunResult;
    try {
      result = await runAdeForRemote({
        argv: verdict.args,
        cwd: resolved.cwd,
        timeoutMs,
        connectionId: connection.id,
        connectionLabel: connection.label,
        role: connection.scope === "write" ? "cto" : "agent",
        stdin,
        ...(typed?.maxOutputBytes ? { maxOutputBytes: typed.maxOutputBytes } : {}),
      });
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

  const handleRpc = async (
    connection: RemoteMcpConnectionSummary,
    message: JsonRpcMessage | null,
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
        return reply({ tools: [toolDefinition(connection.scope), ...TYPED_TOOLS.map(typedToolDefinition)] });
      case "tools/call":
        return reply(await callTool(connection, params));
      case "resources/list":
        return reply({
          resources: [{
            uri: COMMANDS_RESOURCE_URI,
            name: "commands",
            title: "ADE commands",
            description: "Every ade command this connection can run, with a summary and examples (ade help --json).",
            mimeType: "application/json",
          }],
        });
      case "resources/read": {
        if (params.uri !== COMMANDS_RESOURCE_URI) return fail(-32002, `Resource not found: ${String(params.uri)}`);
        try {
          const text = await commandCatalog(connection.scope);
          return reply({ contents: [{ uri: COMMANDS_RESOURCE_URI, mimeType: "application/json", text }] });
        } catch (error) {
          return fail(-32603, error instanceof Error ? error.message : String(error));
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
