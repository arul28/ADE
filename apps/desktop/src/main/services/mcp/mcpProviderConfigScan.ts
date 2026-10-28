/**
 * MCP servers the provider CLIs already have on this computer.
 *
 * Each CLI keeps its own list in its own file and format. This reads them all
 * into one shape so the settings page can offer "these exist here but not in
 * ADE" and import one without the user retyping it.
 *
 * Main process only, and deliberately split in two: {@link scanProviderMcpConfigs}
 * returns definitions WITH their env and header values, for the import path
 * that moves them into the vault; {@link toFoundServers} is what may be sent to
 * the renderer, and carries names only.
 *
 * Every read is best-effort. A file that is missing, unreadable, or not the
 * shape expected contributes nothing; it never fails the scan.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ADE_RESERVED_MCP_SERVER_NAMES } from "../../../shared/callerMcpServers";
import { isValidMcpRegistryName, normalizeMcpRegistryServer } from "../../../shared/mcpRegistry";
import { mcpServerDefinitionFromConfig, type McpServerDefinition } from "../../../shared/mcpServerImport";
import { parseJsonc } from "../../../shared/theme/jsonc";
import type { McpConfigProvider, McpFoundServer, McpRegistryScan } from "../../../shared/types/mcpRegistry";
import { pathsEqual } from "../shared/pathCompare";
import {
  codexConfigHome,
  copilotConfigHome,
  factoryConfigHome,
  grokConfigHome,
  kimiCodeConfigHome,
  qwenConfigHome,
} from "../shared/providerConfigHomes";

export type ScannedMcpServer = McpServerDefinition & { providers: McpConfigProvider[] };

export type ProviderMcpScan = {
  servers: ScannedMcpServer[];
  skipped: string[];
};

export type ProviderMcpScanArgs = {
  /** The open project, for the provider configs that are filed per project. */
  projectRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A config file may be a megabyte of chat history (`~/.claude.json`); cap what is read. */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/** A config file's text, BOM stripped and size capped; null when missing or unreadable. */
export function readText(filePath: string): string | null {
  try {
    if (fs.statSync(filePath).size > MAX_CONFIG_BYTES) return null;
    // A BOM is common on files written by Windows tools and breaks JSON.parse.
    return fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** A JSON or JSONC config file as an object; null when missing, unreadable or not an object. */
export function readJson(filePath: string): Record<string, unknown> | null {
  const text = readText(filePath);
  if (text == null) return null;
  try {
    const parsed = parseJsonc(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml
// ---------------------------------------------------------------------------

/**
 * The one walk over a piece of TOML that knows what a string is. Calls `visit`
 * for every character outside a string that is not a bracket, with how deep in
 * lists and inline tables it sits; `visit` answers true to stop. Returns the
 * depth where the walk ended.
 *
 * A basic string (`"..."`) has backslash escapes, a literal one (`'...'`) has
 * none: a Windows path in single quotes ends at its closing quote.
 */
function scanTomlOutsideStrings(text: string, visit: (char: string, index: number, depth: number) => boolean): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === "\"") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    } else if (visit(char, index, depth)) {
      break;
    }
  }
  return depth;
}

/** Where the first `target` outside a string is, or -1. */
function findOutsideTomlStrings(text: string, target: string): number {
  let found = -1;
  scanTomlOutsideStrings(text, (char, index) => {
    if (char !== target) return false;
    found = index;
    return true;
  });
  return found;
}

function stripTomlComment(line: string): string {
  const hash = findOutsideTomlStrings(line, "#");
  return hash < 0 ? line : line.slice(0, hash);
}

/** Splits a dotted TOML key (`mcp_servers."my.server".env`) into its segments. */
function splitTomlKey(key: string): string[] {
  const segments: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while (consumed < key.length && (match = pattern.exec(key)) !== null) {
    segments.push(match[1] ?? match[2] ?? match[3] ?? "");
    consumed = pattern.lastIndex;
  }
  return consumed >= key.length ? segments : [];
}

/**
 * A TOML value, for the few kinds an MCP server entry uses: strings, booleans,
 * numbers, lists of those, and one-line inline tables. Anything else is
 * `undefined` and the key is skipped.
 */
function parseTomlValue(raw: string): unknown {
  const text = raw.trim();
  if (!text.length) return undefined;
  if (text.startsWith("\"")) {
    try {
      // A TOML basic string and a JSON string share their escapes.
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(text)) return Number(text.replace(/_/g, ""));
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitTomlList(text.slice(1, -1)).map(parseTomlValue).filter((entry) => entry !== undefined);
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const table: Record<string, unknown> = {};
    for (const part of splitTomlList(text.slice(1, -1))) {
      const equals = findTomlEquals(part);
      if (equals < 0) continue;
      const key = splitTomlKey(part.slice(0, equals).trim());
      const value = parseTomlValue(part.slice(equals + 1));
      if (key.length === 1 && value !== undefined) table[key[0]!] = value;
    }
    return table;
  }
  return undefined;
}

/** Splits on top-level commas: not inside a string, a list or an inline table. */
function splitTomlList(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scanTomlOutsideStrings(text, (char, index, depth) => {
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    return false;
  });
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function findTomlEquals(line: string): number {
  return findOutsideTomlStrings(line, "=");
}

/** True while a list opened on an earlier line has not closed yet. */
function tomlListIsOpen(value: string): boolean {
  return scanTomlOutsideStrings(value, () => false) > 0;
}

/**
 * The `[mcp_servers.<name>]` tables of a Codex config, each as a plain object
 * with its sub-tables (`env`, `http_headers`, `env_http_headers`) nested.
 *
 * Not a TOML parser: it reads table headers and `key = value` lines under
 * `mcp_servers`, which is how Codex itself writes them. A server declared only
 * through an inline `mcp_servers = { ... }` table is not read.
 */
/**
 * The one name that still reaches `Object.prototype` once a record built here
 * is spread or indexed by an ordinary object downstream.
 */
const UNSAFE_TABLE_KEYS = new Set(["__proto__"]);

export function parseCodexMcpServers(configText: string): Record<string, Record<string, unknown>> {
  // A project's own config is read too, and that file comes with the
  // repository: tables are prototype-free and `__proto__` is skipped.
  const servers: Record<string, Record<string, unknown>> = Object.create(null);
  let target: Record<string, unknown> | null = null;
  const lines = configText.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripTomlComment(lines[index]!).trim();
    if (!line.length) continue;
    const header = line.match(/^\[\[?\s*(.*?)\s*\]\]?$/);
    if (header && findTomlEquals(line) < 0) {
      const segments = splitTomlKey(header[1] ?? "");
      target = null;
      if (segments[0] !== "mcp_servers" || segments.length < 2 || segments.length > 3) continue;
      if (segments.slice(1).some((segment) => UNSAFE_TABLE_KEYS.has(segment))) continue;
      const server = (servers[segments[1]!] ??= Object.create(null) as Record<string, unknown>);
      if (segments.length === 2) {
        target = server;
      } else {
        const existing = server[segments[2]!];
        const sub: Record<string, unknown> = isRecord(existing) ? existing : Object.create(null);
        server[segments[2]!] = sub;
        target = sub;
      }
      continue;
    }
    if (!target) continue;
    const equals = findTomlEquals(line);
    if (equals < 0) continue;
    // A list may run over several lines; join them before reading the value.
    while (tomlListIsOpen(line.slice(equals + 1)) && index + 1 < lines.length) {
      index += 1;
      line += ` ${stripTomlComment(lines[index]!).trim()}`;
    }
    const key = splitTomlKey(line.slice(0, equals).trim());
    const value = parseTomlValue(line.slice(equals + 1));
    if (key.length === 1 && value !== undefined && !UNSAFE_TABLE_KEYS.has(key[0]!)) target[key[0]!] = value;
  }
  return servers;
}

/**
 * Codex names the env variable a token is read from instead of storing the
 * token. The registry stores values, so read the variable here; a variable
 * this process does not have leaves the header named and its value missing.
 */
function codexEntryAsConfig(entry: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const headers: Record<string, string> = {};
  if (isRecord(entry.env_http_headers)) {
    for (const [header, variable] of Object.entries(entry.env_http_headers)) {
      if (typeof variable === "string") headers[header] = env[variable] ?? "";
    }
  }
  if (typeof entry.bearer_token_env_var === "string" && entry.bearer_token_env_var.trim()) {
    const token = env[entry.bearer_token_env_var.trim()];
    headers.Authorization = token ? `Bearer ${token}` : "";
  }
  return {
    ...entry,
    http_headers: { ...headers, ...(isRecord(entry.http_headers) ? entry.http_headers : {}) },
  };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

type RawSource = { provider: McpConfigProvider; table: unknown };

/** A Codex-style TOML file's `[mcp_servers.*]` as config entries, or null when the file is missing. */
function tomlMcpTable(filePath: string, env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const text = readText(filePath);
  if (text == null) return null;
  const table: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(parseCodexMcpServers(text))) {
    table[name] = codexEntryAsConfig(entry, env);
  }
  return table;
}

/**
 * Gemini's config shape (Qwen keeps it): `url` is the SSE endpoint and
 * `httpUrl` the streamable HTTP one, so a `url` with no `type` is SSE.
 */
function geminiStyleTable(table: unknown): unknown {
  if (!isRecord(table)) return table;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(table)) {
    out[name] = isRecord(entry) && typeof entry.url === "string" && entry.type == null && entry.transport == null && entry.httpUrl == null
      ? { ...entry, type: "sse" }
      : entry;
  }
  return out;
}

function rawSources(args: Required<Pick<ProviderMcpScanArgs, "env" | "homeDir">> & { projectRoot: string | null }): RawSource[] {
  const { env, homeDir, projectRoot } = args;
  const homes = { env, homeDir };
  const sources: RawSource[] = [];

  // Claude Code: one JSON file. User servers at the top, and one more table
  // per project path for the servers added "for this project only".
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim();
  const claude = readJson(path.join(claudeDir || homeDir, ".claude.json"));
  if (claude) {
    sources.push({ provider: "claude", table: claude.mcpServers });
    if (projectRoot && isRecord(claude.projects)) {
      for (const [projectPath, entry] of Object.entries(claude.projects)) {
        if (isRecord(entry) && pathsEqual(projectPath, projectRoot)) {
          sources.push({ provider: "claude", table: entry.mcpServers });
        }
      }
    }
  }

  sources.push({ provider: "codex", table: tomlMcpTable(path.join(codexConfigHome(homes), "config.toml"), env) });

  // `copilot mcp add` and Copilot's `/mcp add` write here.
  sources.push({ provider: "copilot", table: readJson(path.join(copilotConfigHome(homes), "mcp-config.json"))?.mcpServers });

  sources.push({ provider: "cursor", table: readJson(path.join(homeDir, ".cursor", "mcp.json"))?.mcpServers });

  // OpenCode follows the XDG layout on every platform, Windows included.
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    sources.push({ provider: "opencode", table: readJson(path.join(xdgConfig, "opencode", file))?.mcp });
  }

  sources.push({ provider: "droid", table: readJson(path.join(factoryConfigHome(homes), "mcp.json"))?.mcpServers });

  // Pi: `mcp.json` in its agent directory, the one ADE's Pi chats run on.
  const piAgentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDir, ".pi", "agent");
  sources.push({ provider: "pi", table: readJson(path.join(piAgentDir, "mcp.json"))?.mcpServers });

  sources.push({ provider: "muse", table: readJson(path.join(xdgConfig, "muse", "settings.json"))?.mcpServers });
  sources.push({ provider: "qwen", table: geminiStyleTable(readJson(path.join(qwenConfigHome(homes), "settings.json"))?.mcpServers) });
  sources.push({ provider: "kimi", table: readJson(path.join(kimiCodeConfigHome(homes), "mcp.json"))?.mcpServers });
  sources.push({ provider: "grok", table: tomlMcpTable(path.join(grokConfigHome(homes), "config.toml"), env) });
  for (const file of DEVIN_MCP_FILES) {
    sources.push({ provider: "devin", table: readJson(path.join(devinUserConfigDir(homes), file))?.mcpServers });
  }
  sources.push({ provider: "antigravity", table: readJson(path.join(homeDir, ".gemini", "config", "mcp_config.json"))?.mcpServers });
  // A project's own files (`.mcp.json`, `.github/mcp.json`, `.pi/mcp.json`,
  // ...) come with the repository and are not read.
  return sources;
}

/** Devin 3000.3+ keeps servers in `mcp_config.json` per scope; older builds kept `mcpServers` in `config.json`. */
const DEVIN_MCP_FILES = ["mcp_config.json", "mcp_config.local.json", "config.json", "config.local.json"] as const;

function devinUserConfigDir(args: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  return process.platform === "win32"
    ? path.join(args.env.APPDATA?.trim() || path.join(args.homeDir, "AppData", "Roaming"), "devin")
    : path.join(args.env.XDG_CONFIG_HOME?.trim() || path.join(args.homeDir, ".config"), "devin");
}

/**
 * Every server the provider configs on this computer declare, one per name.
 *
 * The same name in two providers is one row: the first definition found is the
 * one kept (in the order {@link rawSources} reads them: Claude, Codex, Copilot,
 * Cursor, OpenCode, Droid, Pi, Muse, Qwen, Kimi, Grok, Devin, Antigravity) and
 * the rest only add their provider to `providers`.
 */
export function scanProviderMcpConfigs(args: ProviderMcpScanArgs = {}): ProviderMcpScan {
  const env = args.env ?? process.env;
  const homeDir = args.homeDir ?? os.homedir();
  const byName = new Map<string, ScannedMcpServer>();
  const skipped: string[] = [];
  for (const source of rawSources({ env, homeDir, projectRoot: args.projectRoot?.trim() || null })) {
    if (!isRecord(source.table)) continue;
    for (const [rawName, entry] of Object.entries(source.table)) {
      const name = rawName.trim();
      // ADE starts these itself; importing one would shadow ADE's own server.
      if (ADE_RESERVED_MCP_SERVER_NAMES.includes(name)) continue;
      const existing = byName.get(name);
      if (existing) {
        if (!existing.providers.includes(source.provider)) existing.providers.push(source.provider);
        continue;
      }
      const definition = mcpServerDefinitionFromConfig(name, entry);
      const usable = definition != null && isValidMcpRegistryName(name) && normalizeMcpRegistryServer({
        ...definition,
        envNames: Object.keys(definition.env),
        headerNames: Object.keys(definition.headers),
      }) != null;
      if (!definition || !usable) {
        if (name && !skipped.includes(name)) skipped.push(name);
        continue;
      }
      byName.set(name, { ...definition, providers: [source.provider] });
    }
  }
  const servers = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { servers, skipped: skipped.filter((name) => !byName.has(name)).sort((left, right) => left.localeCompare(right)) };
}

/** The scan as the renderer may see it: every value dropped, names kept. */
export function toFoundServers(scan: ProviderMcpScan): McpRegistryScan {
  return {
    servers: scan.servers.map((server): McpFoundServer => ({
      name: server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: [...server.args] } : {}),
      ...(server.url ? { url: server.url } : {}),
      envNames: Object.keys(server.env),
      headerNames: Object.keys(server.headers),
      providers: [...server.providers],
    })),
    skipped: [...scan.skipped],
  };
}

/**
 * The MCP server names a provider loads from its own config files for a chat
 * in `cwd`, for the providers that cannot drop their own copy of a server.
 * ADE then leaves out a registry server of the same name, which would
 * otherwise start a second copy (Droid, Qwen, Kimi, Grok, Devin, Antigravity:
 * not shown to replace), or refuse the session's server (Muse). Claude, Codex,
 * Copilot (probed) and Cursor (documented first-match precedence, inline
 * first) replace a same-named server from the launch, and OpenCode merges its
 * config by key, so they are not listed.
 */
export function providerOwnMcpServerNames(
  provider: string,
  args: { cwd: string; env?: NodeJS.ProcessEnv; homeDir?: string },
): Set<string> {
  const env = args.env ?? process.env;
  const homeDir = args.homeDir ?? os.homedir();
  const files: Array<{ file: string; key: string; toml?: string }> = [];
  switch (provider) {
    case "droid":
      // The user file, and `.factory/mcp.json` in the folder and every folder above it.
      files.push({ file: path.join(factoryConfigHome({ env, homeDir }), "mcp.json"), key: "mcpServers" });
      for (let dir = path.resolve(args.cwd); ; dir = path.dirname(dir)) {
        files.push({ file: path.join(dir, ".factory", "mcp.json"), key: "mcpServers" });
        if (path.dirname(dir) === dir) break;
      }
      break;
    case "qwen":
      files.push({ file: path.join(qwenConfigHome({ env, homeDir }), "settings.json"), key: "mcpServers" });
      files.push({ file: path.join(args.cwd, ".qwen", "settings.json"), key: "mcpServers" });
      break;
    case "muse":
      // Muse refuses a session server whose name its own config already has,
      // rather than starting either.
      files.push({ file: path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config"), "muse", "settings.json"), key: "mcpServers" });
      files.push({ file: path.join(args.cwd, ".mcp.json"), key: "mcpServers" });
      break;
    case "kimi":
      // `<KIMI_CODE_HOME>/mcp.json`, and the project's `.kimi-code/mcp.json`
      // (docs) or `.mcp.json` (the bundled import skill names both).
      files.push({ file: path.join(kimiCodeConfigHome({ env, homeDir }), "mcp.json"), key: "mcpServers" });
      files.push({ file: path.join(args.cwd, ".kimi-code", "mcp.json"), key: "mcpServers" });
      files.push({ file: path.join(args.cwd, ".mcp.json"), key: "mcpServers" });
      break;
    case "grok":
      // `[mcp_servers.<name>]` in `<GROK_HOME>/config.toml` and `./.grok/config.toml`.
      for (const file of [path.join(grokConfigHome({ env, homeDir }), "config.toml"), path.join(args.cwd, ".grok", "config.toml")]) {
        const text = readText(file);
        if (text != null) files.push({ file, key: "", toml: text });
      }
      break;
    case "devin": {
      for (const dir of [devinUserConfigDir({ env, homeDir }), path.join(args.cwd, ".devin")]) {
        for (const file of DEVIN_MCP_FILES) {
          files.push({ file: path.join(dir, file), key: "mcpServers" });
        }
      }
      break;
    }
    case "antigravity":
      files.push({ file: path.join(homeDir, ".gemini", "config", "mcp_config.json"), key: "mcpServers" });
      files.push({ file: path.join(args.cwd, ".agents", "mcp_config.json"), key: "mcpServers" });
      break;
    default:
      break;
  }
  const names = new Set<string>();
  for (const { file, key, toml } of files) {
    const table = toml != null ? parseCodexMcpServers(toml) : readJson(file)?.[key];
    if (isRecord(table)) for (const name of Object.keys(table)) names.add(name.trim());
  }
  return names;
}
