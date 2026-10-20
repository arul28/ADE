/**
 * The user's own MCP servers, as one Claude or Codex chat launch should start
 * them. Two jobs, both per launch and both only read the user's files:
 *
 * 1. **Accounts.** An ADE account runs the CLI on its own config home
 *    (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` under `provider-homes/`), and that
 *    home has none of the servers the user configured for their machine login
 *    (`~/.claude.json`, `~/.codex/config.toml`). Those servers are handed to
 *    the launch, except a name the account's own config already has.
 * 2. **npx without npm's launcher** (`npxDirectLaunch.ts`).
 *
 * Both rely on a launch-level server of the same name REPLACING the CLI's own
 * copy rather than adding a second one, which ADE proved for these two CLIs:
 *
 * - Codex: a thread config overlay `mcp_servers.<name>` is merged into the
 *   config.toml table, so an overlay that only sets `command` and `args`
 *   keeps the server's env, tool approvals and timeouts.
 * - Claude: a server in the launch's MCP config (`--mcp-config`, scope
 *   "dynamic") wins over the same name in the user and local scopes; every
 *   other server of the user's still loads.
 *
 * A CLI the user starts in a terminal is unaffected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCodexMcpServers } from "./mcpProviderConfigScan";
import type { NpxDirectCommand, NpxDirectLauncher } from "./npxDirectLaunch";

type StdioCandidate = { command: string; args: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  const text = readText(filePath);
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function direct(
  launcher: NpxDirectLauncher,
  candidate: StdioCandidate,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NpxDirectCommand | null {
  return launcher.resolve({ command: candidate.command, args: candidate.args, cwd, env });
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexHomeDir(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() ? path.resolve(env.CODEX_HOME.trim()) : path.join(os.homedir(), ".codex");
}

function codexServers(home: string): Record<string, Record<string, unknown>> {
  const text = readText(path.join(home, "config.toml"));
  return text ? parseCodexMcpServers(text) : {};
}

function codexStdio(entry: Record<string, unknown>): StdioCandidate | null {
  if (typeof entry.command !== "string" || entry.cwd !== undefined) return null;
  const args = stringArray(entry.args);
  return args ? { command: entry.command, args } : null;
}

export type CodexUserServersArgs = {
  /** The env the chat's Codex runs with (its account's `CODEX_HOME`). */
  env: NodeJS.ProcessEnv;
  /** The env whose `CODEX_HOME` is the machine login's. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  cwd: string;
  /** Names ADE or a caller sets for this thread; theirs win. */
  skipNames?: ReadonlySet<string>;
};

type CodexPlan = {
  /** The account's own servers: only their process can change. */
  own: Array<{ name: string; stdio: StdioCandidate }>;
  /** The machine login's servers the account does not have: whole entries. */
  inherited: Array<{ name: string; entry: Record<string, unknown> }>;
};

function codexPlan(args: CodexUserServersArgs): CodexPlan {
  const skip = new Set(args.skipNames ?? []);
  // A project's own `.codex/config.toml` can redefine a server; an overlay
  // built from the user's definition would replace the project's.
  const projectText = readText(path.join(args.cwd, ".codex", "config.toml"));
  for (const name of Object.keys(projectText ? parseCodexMcpServers(projectText) : {})) skip.add(name);

  const accountHome = codexHomeDir(args.env);
  const own = codexServers(accountHome);
  const plan: CodexPlan = { own: [], inherited: [] };
  for (const [name, entry] of Object.entries(own)) {
    if (skip.has(name) || entry.enabled === false) continue;
    const stdio = codexStdio(entry);
    if (stdio) plan.own.push({ name, stdio });
  }
  if (!samePath(accountHome, codexHomeDir(args.baseEnv ?? process.env))) {
    for (const [name, entry] of Object.entries(codexServers(codexHomeDir(args.baseEnv ?? process.env)))) {
      if (skip.has(name) || name in own || entry.enabled === false) continue;
      plan.inherited.push({ name, entry });
    }
  }
  return plan;
}

export async function prepareCodexUserServers(launcher: NpxDirectLauncher, args: CodexUserServersArgs): Promise<void> {
  const plan = codexPlan(args);
  const candidates = [
    ...plan.own.map((server) => server.stdio),
    ...plan.inherited.map((server) => codexStdio(server.entry)).filter((stdio): stdio is StdioCandidate => stdio != null),
  ];
  await launcher.prepare(candidates, args.env);
}

/** `mcp_servers` overlay entries for one Codex thread. */
export function codexUserServerOverlay(
  launcher: NpxDirectLauncher,
  args: CodexUserServersArgs,
): Record<string, Record<string, unknown>> {
  const plan = codexPlan(args);
  const overlay: Record<string, Record<string, unknown>> = {};
  for (const { name, stdio } of plan.own) {
    const resolved = direct(launcher, stdio, args.cwd, args.env);
    if (resolved) overlay[name] = { ...resolved };
  }
  for (const { name, entry } of plan.inherited) {
    const stdio = codexStdio(entry);
    const resolved = stdio ? direct(launcher, stdio, args.cwd, args.env) : null;
    overlay[name] = resolved ? { ...entry, ...resolved } : { ...entry };
  }
  return overlay;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** The `.claude.json` a Claude CLI with this env reads: `$CLAUDE_CONFIG_DIR/.claude.json`, else the home one. */
function claudeGlobalConfigPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.join(path.resolve(configDir), ".claude.json") : path.join(os.homedir(), ".claude.json");
}

export type ClaudeLaunchServer =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** One `.claude.json` server entry as the launch's MCP config takes it, or null for a shape ADE does not pass. */
function claudeLaunchServer(server: unknown): ClaudeLaunchServer | null {
  if (!isRecord(server)) return null;
  const type = server.type ?? "stdio";
  if (type === "stdio") {
    const args = stringArray(server.args);
    if (typeof server.command !== "string" || !args) return null;
    const env = isRecord(server.env) && Object.values(server.env).every((value) => typeof value === "string")
      ? server.env as Record<string, string>
      : undefined;
    return { type: "stdio", command: server.command, args, ...(env && Object.keys(env).length ? { env } : {}) };
  }
  if ((type === "http" || type === "sse") && typeof server.url === "string") {
    const headers = isRecord(server.headers) && Object.values(server.headers).every((value) => typeof value === "string")
      ? server.headers as Record<string, string>
      : undefined;
    return { type, url: server.url, ...(headers && Object.keys(headers).length ? { headers } : {}) };
  }
  return null;
}

/**
 * An own server ADE may re-point at its npx copy: a launch-level entry
 * replaces the whole entry, so one that carries more than a command keeps its
 * own launch (and its env values stay off a command line).
 */
function claudePlainStdio(server: unknown): StdioCandidate | null {
  if (!isRecord(server) || (server.type !== undefined && server.type !== "stdio")) return null;
  if (typeof server.command !== "string" || server.command.includes("${")) return null;
  if (Object.keys(server).some((key) => !["type", "command", "args"].includes(key))) return null;
  const args = stringArray(server.args);
  if (!args || args.some((arg) => arg.includes("${"))) return null;
  return { command: server.command, args };
}

export type ClaudeUserServersArgs = {
  /** The env the chat's Claude runs with (its account's `CLAUDE_CONFIG_DIR`). */
  env: NodeJS.ProcessEnv;
  /** The env whose `.claude.json` is the machine login's. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  cwd: string;
  /** Folders Claude may key this project's local scope by (the main checkout of a worktree). */
  projectRoots?: readonly string[];
  settingSources: readonly string[];
  /** Names ADE or a caller sets for this launch; theirs win. */
  skipNames?: ReadonlySet<string>;
};

/** The servers one `.claude.json` gives this folder (local scope over user scope), and the names it switches off here. */
function claudeEffectiveServers(
  config: Record<string, unknown> | null,
  args: ClaudeUserServersArgs,
): { servers: Map<string, unknown>; off: Set<string>; ambiguous: Set<string> } {
  const servers = new Map<string, unknown>();
  const off = new Set<string>();
  const ambiguous = new Set<string>();
  if (!config) return { servers, off, ambiguous };
  const roots = [args.cwd, ...(args.projectRoots ?? []).filter((root) => root !== args.cwd)];
  const projectEntries = isRecord(config.projects)
    ? roots.map((root) => (config.projects as Record<string, unknown>)[root]).filter(isRecord)
    : [];
  for (const entry of projectEntries) {
    for (const name of stringArray(entry.disabledMcpServers) ?? []) off.add(name);
  }
  if (args.settingSources.includes("user") && isRecord(config.mcpServers)) {
    for (const [name, server] of Object.entries(config.mcpServers)) servers.set(name, server);
  }
  if (args.settingSources.includes("local")) {
    const local = new Map<string, unknown>();
    for (const entry of projectEntries) {
      if (!isRecord(entry.mcpServers)) continue;
      for (const [name, server] of Object.entries(entry.mcpServers)) {
        // The worktree and its main checkout naming the same server
        // differently: which one Claude picks is not ours to guess.
        if (local.has(name) && JSON.stringify(local.get(name)) !== JSON.stringify(server)) ambiguous.add(name);
        local.set(name, server);
      }
    }
    for (const [name, server] of local) servers.set(name, server);
  }
  return { servers, off, ambiguous };
}

type ClaudePlan = {
  own: Array<{ name: string; stdio: StdioCandidate }>;
  inherited: Array<{ name: string; server: ClaudeLaunchServer }>;
};

function claudePlan(args: ClaudeUserServersArgs): ClaudePlan {
  const plan: ClaudePlan = { own: [], inherited: [] };
  const skip = new Set(args.skipNames ?? []);
  // The project's `.mcp.json` outranks the user scope; a launch entry would
  // replace the project's server.
  for (const root of [args.cwd, ...(args.projectRoots ?? [])]) {
    const projectMcp = readJsonRecord(path.join(root, ".mcp.json"));
    if (isRecord(projectMcp?.mcpServers)) for (const name of Object.keys(projectMcp.mcpServers)) skip.add(name);
  }
  const accountPath = claudeGlobalConfigPath(args.env);
  const own = claudeEffectiveServers(readJsonRecord(accountPath), args);
  for (const name of [...own.off, ...own.ambiguous]) skip.add(name);
  for (const [name, server] of own.servers) {
    if (skip.has(name)) continue;
    const stdio = claudePlainStdio(server);
    if (stdio) plan.own.push({ name, stdio });
  }

  const basePath = claudeGlobalConfigPath(args.baseEnv ?? process.env);
  if (!samePath(accountPath, basePath)) {
    const base = claudeEffectiveServers(readJsonRecord(basePath), args);
    for (const name of [...base.off, ...base.ambiguous]) skip.add(name);
    for (const [name, raw] of base.servers) {
      if (skip.has(name) || own.servers.has(name)) continue;
      const server = claudeLaunchServer(raw);
      if (server) plan.inherited.push({ name, server });
    }
  }
  return plan;
}

export async function prepareClaudeUserServers(launcher: NpxDirectLauncher, args: ClaudeUserServersArgs): Promise<void> {
  const plan = claudePlan(args);
  const candidates = [
    ...plan.own.map((server) => server.stdio),
    ...plan.inherited.flatMap(({ server }) => server.type === "stdio" ? [{ command: server.command, args: server.args }] : []),
  ];
  await launcher.prepare(candidates, args.env);
}

/** Launch-level servers: the machine login's servers an account lacks, and npx servers re-pointed. */
export function claudeUserServersForLaunch(
  launcher: NpxDirectLauncher,
  args: ClaudeUserServersArgs,
): Record<string, ClaudeLaunchServer> {
  const plan = claudePlan(args);
  const servers: Record<string, ClaudeLaunchServer> = {};
  for (const { name, stdio } of plan.own) {
    const resolved = direct(launcher, stdio, args.cwd, args.env);
    if (resolved) servers[name] = { type: "stdio", ...resolved };
  }
  for (const { name, server } of plan.inherited) {
    const resolved = server.type === "stdio" ? direct(launcher, server, args.cwd, args.env) : null;
    servers[name] = resolved && server.type === "stdio" ? { ...server, ...resolved } : server;
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Copilot, Cursor, OpenCode
// ---------------------------------------------------------------------------

/**
 * Providers whose launch-level server of a name replaces their own config's
 * server of that name, beyond Claude and Codex: Copilot (probed: one process,
 * the launch's command), Cursor (documented first-match precedence, inline
 * first) and OpenCode (config merged by key into its one shared server).
 * For these, the user's own `npx` servers are re-pointed at the package npx
 * already installed. Only entries that are just a command: the launch entry
 * replaces the whole definition.
 */
export const NPX_DIRECT_OWN_SERVER_PROVIDERS = ["copilot", "cursor", "opencode"] as const;

type JsonSource = { file: string; key: string | null };

function readJsoncRecord(filePath: string): Record<string, unknown> | null {
  const text = readText(filePath);
  if (text == null) return null;
  try {
    // OpenCode allows comments and trailing commas.
    const stripped = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, str: string | undefined) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(stripped) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sourceTable(source: JsonSource): Record<string, unknown> | null {
  const json = readJsoncRecord(source.file);
  if (!json) return null;
  const table = source.key ? json[source.key] : (isRecord(json.mcpServers) ? json.mcpServers : json);
  return isRecord(table) ? table : null;
}

function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  return dirs;
}

function providerSources(provider: string, cwd: string, env: NodeJS.ProcessEnv): { own: JsonSource[]; outranking: JsonSource[] } | null {
  const home = os.homedir();
  switch (provider) {
    case "copilot": {
      const copilotHome = env.COPILOT_HOME?.trim() ? path.resolve(env.COPILOT_HOME.trim()) : path.join(home, ".copilot");
      return {
        own: [{ file: path.join(copilotHome, "mcp-config.json"), key: "mcpServers" }],
        // Workspace files from the folder up to the filesystem root, either shape.
        outranking: ancestors(cwd).flatMap((dir) => [
          { file: path.join(dir, ".mcp.json"), key: null },
          { file: path.join(dir, ".github", "mcp.json"), key: null },
        ]),
      };
    }
    case "cursor":
      return {
        own: [{ file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers" }],
        outranking: [{ file: path.join(cwd, ".cursor", "mcp.json"), key: "mcpServers" }],
      };
    case "opencode": {
      const configDir = path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "opencode");
      return {
        own: ["opencode.json", "opencode.jsonc"].map((file) => ({ file: path.join(configDir, file), key: "mcp" })),
        outranking: ["opencode.json", "opencode.jsonc", path.join(".opencode", "opencode.json")]
          .map((file) => ({ file: path.join(cwd, file), key: "mcp" })),
      };
    }
    default:
      return null;
  }
}

/** A plain command entry in this provider's shape, or null. */
function providerStdio(provider: string, server: unknown): StdioCandidate | null {
  if (!isRecord(server) || server.enabled === false) return null;
  if (provider === "opencode") {
    if (server.type !== "local" || !Array.isArray(server.command)) return null;
    if (Object.keys(server).some((key) => !["type", "command", "enabled"].includes(key))) return null;
    const [command, ...args] = server.command;
    return typeof command === "string" && args.every((arg) => typeof arg === "string") ? { command, args: args as string[] } : null;
  }
  if (typeof server.command !== "string") return null;
  if (Object.keys(server).some((key) => !["type", "command", "args", "tools"].includes(key))) return null;
  const args = stringArray(server.args);
  if (!args || args.some((arg) => arg.includes("${")) || server.command.includes("${")) return null;
  return { command: server.command, args };
}

function providerCandidates(provider: string, cwd: string, env: NodeJS.ProcessEnv, skipNames: ReadonlySet<string>) {
  const sources = providerSources(provider, cwd, env);
  if (!sources) return [];
  const skip = new Set(skipNames);
  for (const source of sources.outranking) {
    for (const name of Object.keys(sourceTable(source) ?? {})) skip.add(name);
  }
  const candidates: Array<{ name: string; stdio: StdioCandidate }> = [];
  for (const source of sources.own) {
    for (const [name, server] of Object.entries(sourceTable(source) ?? {})) {
      if (skip.has(name) || candidates.some((candidate) => candidate.name === name)) continue;
      const stdio = providerStdio(provider, server);
      if (stdio) candidates.push({ name, stdio });
    }
  }
  return candidates;
}

export async function prepareProviderUserNpxDirect(
  launcher: NpxDirectLauncher,
  args: { provider: string; cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const env = args.env ?? process.env;
  await launcher.prepare(providerCandidates(args.provider, args.cwd, env, new Set()).map((candidate) => candidate.stdio), env);
}

/** The user's own `npx` servers for a Copilot, Cursor or OpenCode launch, re-pointed; empty for other providers. */
export function providerUserNpxDirectServers(
  launcher: NpxDirectLauncher,
  args: { provider: string; cwd: string; env?: NodeJS.ProcessEnv; skipNames?: ReadonlySet<string> },
): Record<string, { type: "stdio"; command: string; args: string[] }> {
  const env = args.env ?? process.env;
  const servers: Record<string, { type: "stdio"; command: string; args: string[] }> = {};
  for (const { name, stdio } of providerCandidates(args.provider, args.cwd, env, args.skipNames ?? new Set())) {
    const resolved = direct(launcher, stdio, args.cwd, env);
    if (resolved) servers[name] = { type: "stdio", ...resolved };
  }
  return servers;
}
