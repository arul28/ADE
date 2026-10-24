import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PiSdkMcpServer, PiSdkWorkerInit } from "./piSdkProtocol";
import type { PiApprovalGate } from "./piSdkUiBridge";

/**
 * How the Pi worker gives a session Pi's MCP support: ADE's servers as Pi
 * `mcp.json` entries, the user's own config, and the approval hook. Bundled
 * into the worker process (`piSdkWorker.ts`); like the worker, it has no
 * static import from Pi and gets the loaded module passed in.
 */

type PiModule = Record<string, unknown>;
type Callable = (...args: unknown[]) => unknown;

/** The tools Pi's built-in MCP support needs to reach servers with `codemode` and `deferred` exposure. */
export const PI_MCP_DISCOVERY_TOOLS = ["codemode", "tool_search"] as const;
/** Pi's MCP resource tools; they count as MCP tools (`isMcpToolName` in Pi). */
export const PI_MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
/** The inline extension that puts MCP calls behind ADE's approval card; its load failing fails the chat start. */
export const ADE_MCP_APPROVAL_EXTENSION = "ade-mcp-approval";

/** What the MCP extensions need from an initialized worker. */
export type PiSdkWorkerMcpContext = {
  /** Root of the loaded Pi package, for Pi's internal MCP config loader. */
  piRoot: string | null;
  /** The worker's checked method lookup; its error names the loaded Pi package. */
  method: (target: unknown, name: string) => Callable;
  errorMessage: (error: unknown) => string;
  /** The worker's one approval gate, shared with the gated built-ins. */
  approvalGate: () => PiApprovalGate;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPiMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || PI_MCP_RESOURCE_TOOLS.has(name);
}

/**
 * A literal value as Pi's config resolution keeps it: Pi reads `$NAME`,
 * `${NAME}` and a leading `!command` in `env` and `headers` values, and a
 * registry value is a secret as written, never a reference or a command.
 * `$$` is Pi's literal `$` and `$!` its literal `!`.
 */
function piLiteralConfigValue(value: string): string {
  const escaped = value.replace(/\$/gu, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function piLiteralConfigValues(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values || !Object.keys(values).length) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, piLiteralConfigValue(value)]));
}

/** A server ADE hands the session, as a Pi `mcp.json` entry. */
function piMcpServerConfig(server: PiSdkMcpServer): Record<string, unknown> {
  if ("command" in server) {
    const env = piLiteralConfigValues(server.env);
    return {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(env ? { env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  const headers = piLiteralConfigValues(server.headers);
  return { url: server.url, ...(headers ? { headers } : {}) };
}

/**
 * How Pi's MCP support reads the user's `mcp.json`.
 *
 * ADE marks every project untrusted (see `initWorker`), so Pi's own loader
 * reads only the agent directory's file. A project's `.pi/mcp.json` loads too
 * when the user trusted that folder in Pi itself: Pi's `trust.json`, the
 * answer its CLI asked for. Pi's internal loader is used for that, so a Pi
 * build without it falls back to the agent directory's file only.
 */
async function piMcpConfigLoader(
  init: PiSdkWorkerInit,
  sdk: PiModule,
  context: PiSdkWorkerMcpContext,
): Promise<((ctx: unknown) => unknown) | undefined> {
  const { method, piRoot } = context;
  if (init.mcp?.userConfig !== true) return () => ({ servers: [], errors: [] });
  let trusted = false;
  try {
    const Store = sdk.ProjectTrustStore;
    if (typeof Store === "function") {
      const store = new (Store as new (agentDir: string) => Record<string, unknown>)(init.agentDir);
      trusted = (method(store, "get").call(store, init.cwd)) === true;
    }
  } catch {
    trusted = false;
  }
  if (!trusted || !piRoot) return undefined;
  try {
    const configModule = await import(pathToFileURL(path.join(piRoot, "dist", "extensions", "mcp", "config.js")).href) as Record<string, unknown>;
    const load = configModule.loadMcpConfig;
    if (typeof load !== "function") return undefined;
    return (ctx: unknown) => (load as Callable)({
      agentDir: init.agentDir,
      cwd: nonEmpty(record(ctx)?.cwd) ?? init.cwd,
      projectTrusted: true,
    });
  } catch {
    return undefined;
  }
}

/**
 * The inline extension that puts each MCP call, codemode's nested calls
 * included, behind the worker's shared approval gate (Pi's `tool_call` hook).
 */
function mcpApprovalExtension(context: PiSdkWorkerMcpContext): Record<string, unknown> {
  const { method, approvalGate } = context;
  return {
    name: ADE_MCP_APPROVAL_EXTENSION,
    hidden: true,
    factory: (api: Record<string, unknown>) => {
      method(api, "on").call(api, "tool_call", async (event: unknown, ctx: unknown) => {
        const toolName = nonEmpty(record(event)?.toolName);
        if (!toolName || !isPiMcpToolName(toolName)) return undefined;
        const signal = record(ctx)?.signal;
        const allowed = await approvalGate().check(
          toolName,
          record(event)?.input,
          signal instanceof AbortSignal ? signal : undefined,
        );
        return allowed
          ? undefined
          : { block: true, reason: `The user denied this ${toolName} call. Ask before trying it again, or take a different approach.` };
      });
    },
  };
}

/**
 * The inline extensions that give a session Pi's MCP support, or none.
 *
 * Pi's SDK loads no built-in extension, so ADE adds `createMcpExtension()`
 * (which connects the servers on `session_start`) with `codemode` and
 * `tool_search`, the tools that reach servers with Pi's default `codemode`
 * and `deferred` exposure. They load as inline factories, so the user's own
 * extensions stay off unless the chat enabled them; replaceable, as in Pi's
 * CLI, so a user extension that brings its own MCP support replaces Pi's.
 *
 * Every MCP call runs through Pi's `tool_call` hooks, codemode's nested calls
 * included, so one hook puts each behind the approval card when the session's
 * mode asks before a shell.
 */
export async function buildMcpExtensions(
  init: PiSdkWorkerInit,
  sdk: PiModule,
  registrationErrors: string[],
  context: PiSdkWorkerMcpContext,
): Promise<unknown[] | null> {
  const { method, errorMessage } = context;
  const mcp = init.mcp;
  if (!mcp) return null;
  const createMcp = sdk.createMcpExtension;
  const createCodemode = sdk.createCodemodeExtension;
  const createToolSearch = sdk.createToolSearchExtension;
  if (typeof createMcp !== "function" || typeof createCodemode !== "function" || typeof createToolSearch !== "function") {
    registrationErrors.push("This Pi build has no MCP support for embedded sessions, so MCP servers stayed off.");
    return null;
  }
  const loadConfig = await piMcpConfigLoader(init, sdk, context);
  const servers = Object.entries(mcp.servers ?? {});
  const factories: unknown[] = [];
  if (mcp.approval) factories.push(mcpApprovalExtension(context));
  if (servers.length) {
    factories.push({
      name: "ade-mcp-servers",
      hidden: true,
      factory: (api: Record<string, unknown>) => {
        for (const [name, server] of servers) {
          // One bad registration (Pi treats names that differ only in `-` and
          // `_` as one server) must not take the others down with it.
          try {
            method(api, "registerMcpServer").call(api, name, piMcpServerConfig(server));
          } catch (error) {
            registrationErrors.push(`MCP server "${name}" could not be added: ${errorMessage(error)}`);
          }
        }
      },
    });
  }
  factories.push(
    // `models: false`: a script must not run paid classifier or image models
    // on the user's credentials without a card the user answers.
    { name: "codemode", hidden: true, replaceable: true, factory: (createCodemode as Callable)({ models: false }) },
    { name: "tool-search", hidden: true, replaceable: true, factory: (createToolSearch as Callable)() },
    { name: "mcp", hidden: true, replaceable: true, factory: (createMcp as Callable)(loadConfig ? { loadConfig } : {}) },
  );
  return factories;
}
