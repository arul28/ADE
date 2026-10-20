/**
 * Per-launch overrides that start the user's own `npx` MCP servers without
 * npm's launcher (see `npxDirectLaunch.ts`), for the two CLIs where ADE has
 * proved that a launch-level server of the same name REPLACES the CLI's own
 * copy instead of adding a second one:
 *
 * - Codex: a thread config overlay `mcp_servers.<name> = { command, args }` is
 *   merged into config.toml's table, so the server keeps its env, tool
 *   approvals and timeouts and only the process changes.
 * - Claude: a server passed in the launch's MCP config (`--mcp-config`, scope
 *   "dynamic") wins over the same name in the user and local scopes; every
 *   other server of the user's still loads as before.
 *
 * Every other provider gets nothing from here: one that cannot drop its own
 * copy of a server would end up running two.
 *
 * The user's config files are only read, never written. A CLI the user starts
 * in a terminal is unaffected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCodexMcpServers } from "./mcpProviderConfigScan";
import type { NpxDirectCommand, NpxDirectLauncher } from "./npxDirectLaunch";

type StdioCandidate = { name: string; command: string; args: string[] };

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

function resolveAll(
  launcher: NpxDirectLauncher,
  candidates: StdioCandidate[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Map<string, NpxDirectCommand> {
  const resolved = new Map<string, NpxDirectCommand>();
  for (const candidate of candidates) {
    const direct = launcher.resolve({ command: candidate.command, args: candidate.args, cwd, env });
    if (direct) resolved.set(candidate.name, direct);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexHomeDir(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** The enabled `npx` servers of config.toml that a thread overlay can safely re-point. */
function codexCandidates(args: { env: NodeJS.ProcessEnv; cwd: string; skipNames: ReadonlySet<string> }): StdioCandidate[] {
  const text = readText(path.join(codexHomeDir(args.env), "config.toml"));
  if (!text) return [];
  // A project's own `.codex/config.toml` can redefine a server; an overlay
  // built from the user's definition would then replace the project's.
  const projectText = readText(path.join(args.cwd, ".codex", "config.toml"));
  const projectNames = new Set(projectText ? Object.keys(parseCodexMcpServers(projectText)) : []);
  const candidates: StdioCandidate[] = [];
  for (const [name, entry] of Object.entries(parseCodexMcpServers(text))) {
    if (args.skipNames.has(name) || projectNames.has(name)) continue;
    if (entry.enabled === false || typeof entry.command !== "string" || entry.cwd !== undefined) continue;
    const serverArgs = stringArray(entry.args);
    if (!serverArgs) continue;
    candidates.push({ name, command: entry.command, args: serverArgs });
  }
  return candidates;
}

export async function prepareCodexUserNpxDirect(
  launcher: NpxDirectLauncher,
  args: { env?: NodeJS.ProcessEnv; cwd: string; skipNames?: ReadonlySet<string> },
): Promise<void> {
  const env = args.env ?? process.env;
  await launcher.prepare(codexCandidates({ env, cwd: args.cwd, skipNames: args.skipNames ?? new Set() }), env);
}

/** `mcp_servers` overlay entries for one Codex thread: `{ name: { command, args } }`. */
export function codexUserNpxDirectOverrides(
  launcher: NpxDirectLauncher,
  args: { env?: NodeJS.ProcessEnv; cwd: string; skipNames?: ReadonlySet<string> },
): Record<string, NpxDirectCommand> {
  const env = args.env ?? process.env;
  const candidates = codexCandidates({ env, cwd: args.cwd, skipNames: args.skipNames ?? new Set() });
  return Object.fromEntries(resolveAll(launcher, candidates, args.cwd, env));
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** The `.claude.json` this chat's CLI reads: `$CLAUDE_CONFIG_DIR/.claude.json`, else the home one. */
function claudeGlobalConfigPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || os.homedir(), ".claude.json");
}

function claudeServerCandidate(name: string, server: unknown): StdioCandidate | null {
  if (!isRecord(server)) return null;
  if (server.type !== undefined && server.type !== "stdio") return null;
  if (typeof server.command !== "string") return null;
  // The launch's MCP config replaces the whole entry, so a server whose entry
  // carries more than a command would lose it, and env values would end up on
  // a command line. Those keep their own launch.
  if (Object.keys(server).some((key) => !["type", "command", "args"].includes(key))) return null;
  const serverArgs = stringArray(server.args);
  if (!serverArgs || serverArgs.some((arg) => arg.includes("${"))) return null;
  if (server.command.includes("${")) return null;
  return { name, command: server.command, args: serverArgs };
}

/**
 * The user's `npx` servers Claude would start for this folder, by effective
 * definition (local scope over user scope). A name the project's `.mcp.json`
 * also declares, or that the user switched off here, is left alone.
 */
function claudeCandidates(args: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  projectRoots: readonly string[];
  scopes: { user: boolean; local: boolean };
  skipNames: ReadonlySet<string>;
}): StdioCandidate[] {
  const config = readJsonRecord(claudeGlobalConfigPath(args.env));
  if (!config) return [];
  const projectEntries = isRecord(config.projects)
    ? [args.cwd, ...args.projectRoots].map((root) => (config.projects as Record<string, unknown>)[root]).filter(isRecord)
    : [];
  const skip = new Set(args.skipNames);
  for (const entry of projectEntries) {
    for (const name of stringArray(entry.disabledMcpServers) ?? []) skip.add(name);
  }
  for (const root of [args.cwd, ...args.projectRoots]) {
    const projectMcp = readJsonRecord(path.join(root, ".mcp.json"));
    if (isRecord(projectMcp?.mcpServers)) for (const name of Object.keys(projectMcp.mcpServers)) skip.add(name);
  }

  const effective = new Map<string, unknown>();
  if (args.scopes.user && isRecord(config.mcpServers)) {
    for (const [name, server] of Object.entries(config.mcpServers)) effective.set(name, server);
  }
  if (args.scopes.local) {
    const local = new Map<string, unknown>();
    for (const entry of projectEntries) {
      if (!isRecord(entry.mcpServers)) continue;
      for (const [name, server] of Object.entries(entry.mcpServers)) {
        // Two project keys (the worktree and its main checkout) naming the same
        // server differently: which one Claude picks is not ours to guess.
        if (local.has(name) && JSON.stringify(local.get(name)) !== JSON.stringify(server)) skip.add(name);
        local.set(name, server);
      }
    }
    for (const [name, server] of local) effective.set(name, server);
  }

  const candidates: StdioCandidate[] = [];
  for (const [name, server] of effective) {
    if (skip.has(name)) continue;
    const candidate = claudeServerCandidate(name, server);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export type ClaudeUserNpxDirectArgs = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Folders Claude may key this project's local scope by (the main checkout of a worktree). */
  projectRoots?: readonly string[];
  settingSources: readonly string[];
  skipNames?: ReadonlySet<string>;
};

function claudeArgs(args: ClaudeUserNpxDirectArgs) {
  return {
    env: args.env,
    cwd: args.cwd,
    projectRoots: (args.projectRoots ?? []).filter((root) => root !== args.cwd),
    scopes: { user: args.settingSources.includes("user"), local: args.settingSources.includes("local") },
    skipNames: args.skipNames ?? new Set<string>(),
  };
}

export async function prepareClaudeUserNpxDirect(launcher: NpxDirectLauncher, args: ClaudeUserNpxDirectArgs): Promise<void> {
  await launcher.prepare(claudeCandidates(claudeArgs(args)), args.env);
}

/** Launch-level stdio servers that replace the user's `npx` servers of the same name. */
export function claudeUserNpxDirectServers(
  launcher: NpxDirectLauncher,
  args: ClaudeUserNpxDirectArgs,
): Record<string, { type: "stdio"; command: string; args: string[] }> {
  const resolved = resolveAll(launcher, claudeCandidates(claudeArgs(args)), args.cwd, args.env);
  return Object.fromEntries([...resolved].map(([name, direct]) => [name, { type: "stdio" as const, ...direct }]));
}
