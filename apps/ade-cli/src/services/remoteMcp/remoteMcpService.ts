import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import { AccountAttestationError, verifyClerkAccountAttestation } from "../account/accountAttestationVerifier";
import type { AccountAttestationConfig } from "../account/sharedAccountAuthService";
import {
  captureAdeMcpAnalytics,
  type FeatureAnalytics,
} from "../../../../desktop/src/main/services/analytics/featureProductAnalytics";
import type { ProductAnalyticsSurface } from "../../../../desktop/src/shared/types/productAnalytics";
import {
  isRemoteMcpScope,
  type RemoteMcpAction,
  type RemoteMcpActivityEntry,
  type RemoteMcpActivityOutcome,
  type RemoteMcpConnectionSummary,
  type RemoteMcpCreatedToken,
  type RemoteMcpScope,
  type RemoteMcpStatus,
} from "../../../../desktop/src/shared/types/remoteMcp";
import {
  checkRemoteAdeCommand,
  redactedCommandForLog,
  splitCommandLine,
} from "./remoteMcpCommandPolicy";
import { createRemoteMcpActivityLog } from "./remoteMcpActivityLog";
import {
  AUTHORIZE_PAGE_HEADERS,
  buildRedirect,
  createRemoteMcpAuthorizationState,
  decodeClientId,
  parseAuthorizeRequest,
  type AuthorizeRequest,
  redirectDisplayHost,
  registerClient,
  renderConsentPage,
  renderSignInPage,
  type SignedInAccount,
  renderMessagePage,
  scopeToOAuth,
  verifyPkce,
} from "./remoteMcpOAuth";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_STDIN_BYTES,
  MAX_TIMEOUT_MS,
  runAdeForRemote,
  type RemoteRunResult,
} from "./remoteMcpRunner";
import { createRemoteMcpStore } from "./remoteMcpStore";
import { findTypedTool, TYPED_TOOLS, type TypedTool } from "./remoteMcpTools";
import { listAgentSkills, readAgentSkill } from "../skills/agentSkillCatalogService";

/**
 * ADE MCP: an MCP server for this computer, reached through ADE Relay.
 *
 * The relay Worker forwards each HTTP request under `/m/<endpointKey>/` over
 * the brain's existing control socket, and returns whatever this answers. All
 * of it happens here: the MCP protocol, OAuth sign-in, token checks, and
 * running the `ade` command. The Worker stores nothing and can mint nothing.
 *
 * Off by default. When off, the brain tells the relay so, and the relay
 * answers 404 without waking this computer.
 */

export type RemoteMcpHttpRequest = {
  method: string;
  /** Path under the machine prefix, with query, e.g. `/oauth/authorize?…`. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

export type RemoteMcpHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type RemoteMcpRelayEndpoint = {
  relayUrl: string;
  /** The key in the public URL; not the relay key (see mcpEndpointKeyFor). */
  endpointKey: string;
  connected: boolean;
};

export type RemoteMcpProject = { projectId: string; rootPath: string; displayName: string; lastOpenedAt: number };

type ResolvedProject = { cwd: string; project: RemoteMcpProject | null };

export const MAX_CONCURRENT_REMOTE_RUNS = 4;
/** One connection's share, so a long `chat_wait` cannot shut every other app out. */
export const MAX_CONCURRENT_RUNS_PER_CONNECTION = 3;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
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

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RemoteMcpHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(value),
  };
}

function html(status: number, body: string): RemoteMcpHttpResponse {
  return { status, headers: { ...AUTHORIZE_PAGE_HEADERS }, body };
}

function redirect(location: string): RemoteMcpHttpResponse {
  return { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" };
}

function header(request: RemoteMcpHttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function parseForm(request: RemoteMcpHttpRequest): URLSearchParams {
  const type = header(request, "content-type").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof value === "string") params.set(key, value);
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(request.body ?? "");
}

export type RemoteMcpService = ReturnType<typeof createRemoteMcpService>;

export function createRemoteMcpService(args: {
  storePath: string;
  activityPath: string;
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
  logger?: {
    info?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  /**
   * The ADE account this computer is signed in to, and how to check one: the
   * same Clerk client and attestation the relay's phone hellos use.
   */
  account: {
    signedIn: () => SignedInAccount | null;
    oauth: () => { issuer: string; clientId: string } | null;
    attestation: () => AccountAttestationConfig | null;
  };
}) {
  const store = createRemoteMcpStore({ filePath: args.storePath, logger: args.logger });
  const activity = createRemoteMcpActivityLog({ filePath: args.activityPath, logger: args.logger });
  const authorization = createRemoteMcpAuthorizationState();
  const enabledListeners = new Set<(enabled: boolean) => void>();
  let relayEndpoint: () => RemoteMcpRelayEndpoint | null = () => null;
  let analytics: FeatureAnalytics | null = null;
  let activeRuns = 0;
  const runsByConnection = new Map<string, number>();
  const catalogByScope = new Map<RemoteMcpScope, { at: number; text: string }>();

  const base = (): string | null => {
    const endpoint = relayEndpoint();
    if (!endpoint) return null;
    return `${withoutTrailingSlash(endpoint.relayUrl)}/m/${endpoint.endpointKey}`;
  };

  const notifyEnabled = (enabled: boolean): void => {
    for (const listener of enabledListeners) {
      try {
        listener(enabled);
      } catch (error) {
        args.logger?.warn?.("remote_mcp.enabled_listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const record = (entry: Omit<RemoteMcpActivityEntry, "at">): void => {
    activity.append({ at: new Date().toISOString(), ...entry });
  };

  // ── Projects ──────────────────────────────────────────────────────────────

  /**
   * The project a call runs in. Without `project`, the most recently opened
   * one, which changes when the person opens another: every result names it,
   * so a call never lands in a different repo unnoticed.
   */
  const resolveProject = (requested: unknown): ResolvedProject | { error: string } => {
    const projects = args.listProjects();
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
      `Runs ADE's \`ade\` command on ${args.machineName()} and returns its output.`,
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
    `This server is ADE on ${args.machineName()}. ADE manages coding lanes (git worktrees), agent chats, PRs and proof.`,
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
      record({ ...logBase, command: "", outcome: "refused", exitCode: null, durationMs: 0, detail: resolved.error });
      return toolError(resolved.error);
    }
    const inProject = resolved.project ? { project: resolved.project.displayName } : {};
    /** A refusal still names the project, like every other result. */
    const refuse = (command: string, reason: string) => {
      record({ ...logBase, ...inProject, command, outcome: "refused", exitCode: null, durationMs: 0, detail: reason });
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
      record({ ...logged, outcome: "busy", exitCode: null, durationMs: 0 });
      return toolError(`This computer is already running ${MAX_CONCURRENT_REMOTE_RUNS} remote commands. Wait for one to finish, then retry.`);
    }
    if (connectionRuns >= MAX_CONCURRENT_RUNS_PER_CONNECTION) {
      record({ ...logged, outcome: "busy", exitCode: null, durationMs: 0 });
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
      record({ ...logged, outcome: "failed", exitCode: null, durationMs: 0, detail: message });
      return toolError(message);
    } finally {
      activeRuns -= 1;
      const left = (runsByConnection.get(connection.id) ?? 1) - 1;
      if (left > 0) runsByConnection.set(connection.id, left);
      else runsByConnection.delete(connection.id);
    }
    const answered = (typed?.okExitCodes ?? [0]).includes(result.exitCode ?? -1);
    const outcome: RemoteMcpActivityOutcome = result.timedOut ? "timeout" : answered ? "ok" : "failed";
    record({ ...logged, outcome, exitCode: result.exitCode, durationMs: result.durationMs });
    if (typed) return typedResult(typed, input, result, resolved);
    return {
      content: [{ type: "text", text: `${projectLine(resolved)}\n${toolText(result)}` }],
      isError: result.timedOut || result.exitCode !== 0,
    };
  };

  /** `ade help --json` as this scope sees it, read once and kept a few minutes. */
  const commandCatalog = async (scope: RemoteMcpScope): Promise<string> => {
    const cached = catalogByScope.get(scope);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.text;
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
    catalogByScope.set(scope, { at: Date.now(), text: result.stdout });
    return result.stdout;
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
          serverInfo: { name: "ade", title: `ADE on ${args.machineName()}`, version: adeVersion() },
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
        const skills = "error" in resolved || !resolved.project ? [] : listAgentSkills({ cwd: resolved.cwd, includeUser: false });
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
        const skill = name ? readAgentSkill(name, { cwd: resolved.cwd, includeUser: false }) : null;
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

  const unauthorized = (serverBase: string, presented: boolean): RemoteMcpHttpResponse => json(
    401,
    { error: presented ? "invalid_token" : "unauthorized", error_description: "Sign in to ADE on this computer to use it." },
    {
      "www-authenticate": `Bearer resource_metadata="${serverBase}/.well-known/oauth-protected-resource"${presented ? ", error=\"invalid_token\"" : ""}`,
    },
  );

  const handleMcp = async (request: RemoteMcpHttpRequest, serverBase: string): Promise<RemoteMcpHttpResponse> => {
    const authHeader = header(request, "authorization");
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const connection = match ? store.authenticate(match[1]!) : null;
    if (!connection) return unauthorized(serverBase, Boolean(match));
    if (request.method === "GET" || request.method === "DELETE") {
      // Stateless server: no server-initiated stream and no session to end.
      return json(405, { error: "This server answers POST only." }, { allow: "POST" });
    }
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    store.recordUse(connection.id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0 || parsed.length > 20) {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send 1 to 20 messages." } });
      }
      // One at a time: run together, a batch would trip the run limit on itself.
      const replies: Record<string, unknown>[] = [];
      for (const entry of parsed) {
        const answer = await handleRpc(connection, entry as JsonRpcMessage);
        if (answer !== null) replies.push(answer);
      }
      return replies.length ? json(200, replies) : { status: 202, headers: {}, body: "" };
    }
    if (!parsed || typeof parsed !== "object") {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    }
    const replyMessage = await handleRpc(connection, parsed as JsonRpcMessage);
    return replyMessage ? json(200, replyMessage) : { status: 202, headers: {}, body: "" };
  };

  // ── OAuth ─────────────────────────────────────────────────────────────────

  const protectedResourceMetadata = (serverBase: string) => ({
    resource: `${serverBase}/mcp`,
    authorization_servers: [serverBase],
    bearer_methods_supported: ["header"],
    scopes_supported: ["ade:read", "ade:write"],
    resource_name: `ADE on ${args.machineName()}`,
  });

  const authorizationServerMetadata = (serverBase: string) => ({
    issuer: serverBase,
    authorization_endpoint: `${serverBase}/oauth/authorize`,
    token_endpoint: `${serverBase}/oauth/token`,
    registration_endpoint: `${serverBase}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["ade:read", "ade:write"],
    authorization_response_iss_parameter_supported: true,
  });

  const expiredSignIn = (): RemoteMcpHttpResponse =>
    html(400, renderMessagePage("This sign-in expired", "Go back to the app and connect again."));

  /** Where ADE sign-in sends the person back: the relay's one fixed callback. */
  const accountCallbackUrl = (): string | null => {
    const endpoint = relayEndpoint();
    return endpoint ? `${withoutTrailingSlash(endpoint.relayUrl)}/oauth/callback` : null;
  };

  const denyToApp = (authRequest: AuthorizeRequest, serverBase: string): RemoteMcpHttpResponse =>
    redirect(buildRedirect(authRequest.redirectUri, {
      error: "access_denied",
      error_description: "The person cancelled.",
      state: authRequest.state,
      iss: serverBase,
    }));

  // Step 1: the app sends the person here; "Continue with ADE" starts the ADE sign-in.
  const handleAuthorize = (request: RemoteMcpHttpRequest, query: URLSearchParams, serverBase: string): RemoteMcpHttpResponse => {
    const isPost = request.method === "POST";
    if (!isPost && request.method !== "GET") return json(405, { error: "Method not allowed." });
    const params = isPost ? parseForm(request) : query;
    const parsed = parseAuthorizeRequest(params);
    if (!parsed.ok) {
      if (parsed.kind === "page") return html(400, renderMessagePage("Can't connect this app", parsed.message));
      return redirect(buildRedirect(parsed.redirectUri, {
        error: parsed.error,
        error_description: parsed.description,
        state: parsed.state,
        iss: serverBase,
      }));
    }
    const authRequest = parsed.request;
    const machineName = args.machineName();
    const oauth = args.account.oauth();
    const callbackUrl = accountCallbackUrl();
    const endpoint = relayEndpoint();
    const ready = oauth && args.account.attestation() && callbackUrl && endpoint
      ? { oauth, callbackUrl, endpoint }
      : null;
    const unavailable = !args.account.signedIn()
      ? `${machineName} isn't signed in to an ADE account. Sign in to ADE on it, then try again.`
      : !ready
        ? `${machineName} can't check ADE sign-ins right now. Update ADE on it, then try again.`
        : null;
    if (!isPost) return html(200, renderSignInPage({ request: authRequest, machineName, error: unavailable }));
    if (params.get("decision") === "deny") return denyToApp(authRequest, serverBase);
    if (unavailable || !ready) {
      return html(409, renderSignInPage({ request: authRequest, machineName, error: unavailable }));
    }
    const { nonce, accountChallenge } = authorization.beginSignIn(authRequest);
    const signIn = new URL(`${withoutTrailingSlash(ready.oauth.issuer)}/oauth/authorize`);
    signIn.searchParams.set("response_type", "code");
    signIn.searchParams.set("client_id", ready.oauth.clientId);
    signIn.searchParams.set("redirect_uri", ready.callbackUrl);
    signIn.searchParams.set("code_challenge", accountChallenge);
    signIn.searchParams.set("code_challenge_method", "S256");
    // The relay routes the callback back to this machine by the key before the dot.
    signIn.searchParams.set("state", `${ready.endpoint.endpointKey}.${nonce}`);
    signIn.searchParams.set("scope", "openid profile email");
    return redirect(signIn.toString());
  };

  /** Redeems ADE's sign-in code here, with a verifier only this computer holds. */
  const exchangeAccountCode = async (code: string, verifier: string): Promise<string> => {
    const oauth = args.account.oauth();
    const callbackUrl = accountCallbackUrl();
    if (!oauth || !callbackUrl) throw new Error("ADE sign-in isn't configured on this computer.");
    const response = await fetch(`${withoutTrailingSlash(oauth.issuer)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: oauth.clientId,
        redirect_uri: callbackUrl,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
    if (!response.ok || typeof body?.access_token !== "string") throw new Error(`ADE sign-in answered ${response.status}.`);
    return body.access_token;
  };

  // Step 2: back from ADE sign-in. Check the account, then ask for access.
  const handleAccountCallback = async (query: URLSearchParams, serverBase: string): Promise<RemoteMcpHttpResponse> => {
    const state = query.get("state") ?? "";
    const nonce = state.slice(state.indexOf(".") + 1);
    const pending = nonce ? authorization.pendingAccountStep(nonce) : null;
    if (!pending) {
      return expiredSignIn();
    }
    const { request: authRequest } = pending;
    if (query.get("error") || !query.get("code")) {
      authorization.forget(nonce);
      return denyToApp(authRequest, serverBase);
    }
    const owner = args.account.signedIn();
    const attestation = args.account.attestation();
    if (!owner || !attestation) {
      authorization.forget(nonce);
      return html(409, renderMessagePage("Can't connect", `${args.machineName()} isn't signed in to an ADE account.`));
    }
    try {
      const token = await exchangeAccountCode(query.get("code")!, pending.accountVerifier);
      await verifyClerkAccountAttestation({ token, expectedUserId: owner.userId, config: attestation });
    } catch (error) {
      authorization.forget(nonce);
      const mismatch = error instanceof AccountAttestationError && error.code === "account_mismatch";
      args.logger?.warn?.("remote_mcp.account_sign_in_failed", {
        reason: error instanceof AccountAttestationError ? error.code : "exchange_failed",
      });
      return html(mismatch ? 403 : 502, renderMessagePage(
        mismatch ? "Different ADE account" : "Couldn't check your sign-in",
        mismatch
          ? `${args.machineName()} belongs to ${owner.email ?? "another ADE account"}. Sign in with that account to connect apps to it.`
          : "ADE couldn't confirm your sign-in. Go back to the app and try again.",
      ));
    }
    const csrf = authorization.markSignedIn(nonce, owner);
    if (!csrf) return expiredSignIn();
    return html(200, renderConsentPage({
      request: authRequest,
      machineName: args.machineName(),
      account: owner,
      nonce,
      csrf,
      consentPath: `${serverBase}/oauth/consent`,
    }));
  };

  // Step 3: the person chose the access and allowed it.
  const handleConsent = (request: RemoteMcpHttpRequest, serverBase: string): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const params = parseForm(request);
    const taken = authorization.takeConsent(params.get("nonce") ?? "", params.get("csrf") ?? "");
    if (!taken) return expiredSignIn();
    const { request: authRequest } = taken;
    if (params.get("decision") !== "allow") return denyToApp(authRequest, serverBase);
    const scope: RemoteMcpScope = params.get("access") === "read" ? "read" : "write";
    const code = authorization.issueAuthCode({
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      codeChallenge: authRequest.codeChallenge,
      scope,
      clientName: authRequest.client.clientName,
    });
    return redirect(buildRedirect(authRequest.redirectUri, { code, state: authRequest.state, iss: serverBase }));
  };

  const handleToken = (request: RemoteMcpHttpRequest): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "invalid_request" });
    const params = parseForm(request);
    const fail = (error: string, description: string, status = 400) =>
      json(status, { error, error_description: description });
    if (params.get("grant_type") !== "authorization_code") {
      return fail("unsupported_grant_type", "Only authorization_code is supported.");
    }
    const pending = authorization.takeAuthCode(params.get("code") ?? "");
    if (!pending) return fail("invalid_grant", "The authorization code is unknown, used, or expired.");
    const clientId = params.get("client_id");
    if (clientId && clientId !== pending.clientId) return fail("invalid_grant", "The code was issued to another client.");
    const redirectUri = params.get("redirect_uri");
    if (redirectUri && redirectUri !== pending.redirectUri) return fail("invalid_grant", "redirect_uri does not match.");
    if (!verifyPkce(params.get("code_verifier") ?? "", pending.codeChallenge)) {
      return fail("invalid_grant", "PKCE verification failed.");
    }
    if (!decodeClientId(pending.clientId)) return fail("invalid_client", "Unknown client.");
    let created: ReturnType<typeof store.create>;
    try {
      created = store.create({
        kind: "app",
        label: pending.clientName,
        scope: pending.scope,
        redirectHost: redirectDisplayHost(pending.redirectUri),
        clientKey: createHash("sha256").update(pending.clientId, "utf8").digest("hex"),
      });
    } catch (error) {
      return fail("invalid_request", error instanceof Error ? error.message : String(error));
    }
    captureAdeMcpAnalytics({ analytics, surface: "api", action: "app_connected", outcome: "completed" });
    args.logger?.info?.("remote_mcp.app_connected", {
      connectionId: created.connection.id,
      scope: created.connection.scope,
      redirectHost: created.connection.redirectHost,
    });
    return json(200, {
      access_token: created.token,
      token_type: "Bearer",
      scope: scopeToOAuth(created.connection.scope),
    });
  };

  const handleRegister = (request: RemoteMcpHttpRequest): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "invalid_request" });
    let body: unknown;
    try {
      body = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { error: "invalid_client_metadata", error_description: "Send JSON." });
    }
    const result = registerClient(body);
    if (!result.ok) return json(400, { error: result.error, error_description: result.description });
    return json(201, {
      client_id: result.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: result.client.clientName,
      redirect_uris: result.client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  };

  const handleHttp = async (request: RemoteMcpHttpRequest): Promise<RemoteMcpHttpResponse> => {
    if (!store.isEnabled()) {
      return json(404, { error: "ade_mcp_off", error_description: "ADE MCP is off on this computer." });
    }
    const serverBase = base();
    if (!serverBase) return json(503, { error: "unavailable", error_description: "This computer has no relay address yet." });
    if ((request.body?.length ?? 0) > MAX_REQUEST_BODY_CHARS) return json(413, { error: "Request too large." });
    let url: URL;
    try {
      url = new URL(request.path, "https://relay.invalid");
    } catch {
      return json(400, { error: "Bad path." });
    }
    const route = url.pathname.replace(/\/+$/, "") || "/";
    switch (route) {
      case "/mcp":
        return await handleMcp(request, serverBase);
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, protectedResourceMetadata(serverBase), { "cache-control": "max-age=300" });
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json(200, authorizationServerMetadata(serverBase), { "cache-control": "max-age=300" });
      case "/oauth/register":
        return handleRegister(request);
      case "/oauth/authorize":
        return handleAuthorize(request, url.searchParams, serverBase);
      case "/oauth/account-callback":
        return await handleAccountCallback(url.searchParams, serverBase);
      case "/oauth/consent":
        return handleConsent(request, serverBase);
      case "/oauth/token":
        return handleToken(request);
      default:
        return json(404, { error: "not_found" });
    }
  };

  // ── Settings ──────────────────────────────────────────────────────────────

  const getStatus = (): RemoteMcpStatus => {
    const endpoint = relayEndpoint();
    const serverBase = base();
    return {
      enabled: store.isEnabled(),
      serverUrl: serverBase ? `${serverBase}/mcp` : null,
      relayConnected: endpoint?.connected === true,
      machineName: args.machineName(),
      connections: store.list(),
    };
  };

  const parseScope = (value: unknown, fallback: RemoteMcpScope): RemoteMcpScope => {
    if (value === undefined || value === null || value === "") return fallback;
    if (isRemoteMcpScope(value)) return value;
    throw new Error("Access must be \"read\" or \"write\".");
  };

  return {
    handleHttp,
    getStatus,
    isEnabled: () => store.isEnabled(),
    /** The tunnel tells the service where it is reachable. */
    attachRelayEndpoint(resolve: () => RemoteMcpRelayEndpoint | null): void {
      relayEndpoint = resolve;
    },
    /** The machine's product analytics sink, attached with the relay tunnel. */
    attachAnalytics(sink: FeatureAnalytics | null): void {
      analytics = sink;
    },
    onEnabledChange(listener: (enabled: boolean) => void): () => void {
      enabledListeners.add(listener);
      return () => enabledListeners.delete(listener);
    },
    setEnabled(input: { enabled?: unknown }, surface: ProductAnalyticsSurface = "desktop"): RemoteMcpStatus {
      if (typeof input?.enabled !== "boolean") throw new Error("Pass enabled: true or false.");
      store.setEnabled(input.enabled);
      captureAdeMcpAnalytics({
        analytics,
        surface,
        action: "server_toggled",
        outcome: input.enabled ? "enabled" : "disabled",
      });
      args.logger?.info?.("remote_mcp.enabled_changed", { enabled: input.enabled });
      notifyEnabled(input.enabled);
      return getStatus();
    },
    createToken(input: { label?: unknown; scope?: unknown }, surface: ProductAnalyticsSurface = "desktop"): RemoteMcpCreatedToken {
      const created = store.create({
        kind: "token",
        label: typeof input?.label === "string" ? input.label : "Token",
        scope: parseScope(input?.scope, "write"),
      });
      captureAdeMcpAnalytics({ analytics, surface, action: "token_created", outcome: "completed" });
      args.logger?.info?.("remote_mcp.token_created", { connectionId: created.connection.id, scope: created.connection.scope });
      return { ...created, serverUrl: getStatus().serverUrl };
    },
    updateConnection(input: { id?: unknown; scope?: unknown; label?: unknown }): RemoteMcpConnectionSummary {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      return store.update(input.id, {
        ...(input.scope !== undefined ? { scope: parseScope(input.scope, "write") } : {}),
        ...(typeof input.label === "string" ? { label: input.label } : {}),
      });
    },
    removeConnection(input: { id?: unknown }, surface: ProductAnalyticsSurface = "desktop"): { removed: boolean } {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      const removed = store.remove(input.id);
      if (removed) {
        captureAdeMcpAnalytics({ analytics, surface, action: "connection_removed", outcome: "completed" });
        args.logger?.info?.("remote_mcp.connection_removed", { connectionId: input.id });
      }
      return { removed };
    },
    listActivity(input: { limit?: unknown } = {}): RemoteMcpActivityEntry[] {
      return activity.recent(typeof input?.limit === "number" ? input.limit : 100);
    },
  };
}

/**
 * The one table of what Settings (the `remote_mcp` action domain) and
 * `ade mcp` (the machine method `remoteMcp.call`) may ask the service.
 */
export function remoteMcpActionHandlers(
  service: RemoteMcpService,
  /** Who asked, for product analytics: Settings is `desktop`, `ade mcp` is `api`. */
  surface: ProductAnalyticsSurface,
): Record<RemoteMcpAction, (args: Record<string, unknown>) => unknown> {
  return {
    getStatus: () => service.getStatus(),
    listActivity: (args) => service.listActivity(args),
    setEnabled: (args) => service.setEnabled(args, surface),
    createToken: (args) => service.createToken(args, surface),
    updateConnection: (args) => service.updateConnection(args),
    removeConnection: (args) => service.removeConnection(args, surface),
  };
}
