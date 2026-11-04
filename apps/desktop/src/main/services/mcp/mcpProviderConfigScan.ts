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
  devinConfigDir,
  factoryConfigHome,
  grokConfigHome,
  kimiCodeConfigHome,
  openCodeConfigDir,
  piAgentDir,
  qwenConfigHome,
  xdgConfigHome,
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

/**
 * Parsed configs by path, kept while the file's size and change time stay the
 * same. A chat's registry read parses the provider's config (Claude's
 * `~/.claude.json` runs to megabytes) on its launch, redaction and status
 * paths; an unchanged file is parsed once. Bounded: the oldest entry goes.
 */
const parsedJsonCache = new Map<string, { size: number; mtimeMs: number; value: Record<string, unknown> | null }>();
const PARSED_JSON_CACHE_LIMIT = 32;

/**
 * A JSON or JSONC config file as an object; null when missing, unreadable or
 * not an object. The object can be shared with other callers: read it, never
 * change it.
 */
export function readJson(filePath: string): Record<string, unknown> | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    parsedJsonCache.delete(filePath);
    return null;
  }
  const cached = parsedJsonCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
  const text = readText(filePath);
  let value: Record<string, unknown> | null = null;
  if (text != null) {
    try {
      const parsed = parseJsonc(text);
      value = isRecord(parsed) ? parsed : null;
    } catch {
      value = null;
    }
  }
  parsedJsonCache.delete(filePath);
  parsedJsonCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  if (parsedJsonCache.size > PARSED_JSON_CACHE_LIMIT) {
    const oldest = parsedJsonCache.keys().next().value;
    if (oldest !== undefined) parsedJsonCache.delete(oldest);
  }
  return value;
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

  for (const file of ["opencode.json", "opencode.jsonc"]) {
    sources.push({ provider: "opencode", table: readJson(path.join(openCodeConfigDir(homes), file))?.mcp });
  }

  sources.push({ provider: "droid", table: readJson(path.join(factoryConfigHome(homes), "mcp.json"))?.mcpServers });

  // Pi: `mcp.json` in its agent directory, the one ADE's Pi chats run on.
  sources.push({ provider: "pi", table: readJson(path.join(piAgentDir(homes), "mcp.json"))?.mcpServers });

  sources.push({ provider: "muse", table: readJson(path.join(xdgConfigHome(homes), "muse", "settings.json"))?.mcpServers });
  sources.push({ provider: "qwen", table: geminiStyleTable(readJson(path.join(qwenConfigHome(homes), "settings.json"))?.mcpServers) });
  sources.push({ provider: "kimi", table: readJson(path.join(kimiCodeConfigHome(homes), "mcp.json"))?.mcpServers });
  sources.push({ provider: "grok", table: tomlMcpTable(path.join(grokConfigHome(homes), "config.toml"), env) });
  for (const file of DEVIN_MCP_FILES) {
    sources.push({ provider: "devin", table: readJson(path.join(devinConfigDir(homes), file))?.mcpServers });
  }
  sources.push({ provider: "antigravity", table: readJson(path.join(homeDir, ".gemini", "config", "mcp_config.json"))?.mcpServers });
  // A project's own files (`.mcp.json`, `.github/mcp.json`, `.pi/mcp.json`,
  // ...) come with the repository and are not read.
  return sources;
}

/** Devin 3000.3+ keeps servers in `mcp_config.json` per scope; older builds kept `mcpServers` in `config.json`. */
const DEVIN_MCP_FILES = ["mcp_config.json", "mcp_config.local.json", "config.json", "config.local.json"] as const;

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

/** One file a provider reads MCP servers from, and where in it they sit. */
export type McpConfigSource = {
  file: string;
  format: "json" | "toml";
  /** The table's key in a JSON file (a TOML file's servers are its `[mcp_servers.*]` tables). */
  key: string;
  /** `project` comes with the repository, `user` is the user's own, `local` is the user's for one project. */
  scope: "project" | "user" | "local";
  /** For a JSON file that files servers per project (`~/.claude.json`): the project path under `projects`. */
  projectKey?: string;
};

/**
 * The MCP config files a provider reads for a chat in `cwd`, project files
 * first, for the providers whose list ADE knows (Droid, Qwen, Muse, Kimi,
 * Grok, Devin, Antigravity); `[]` for any other. A reader that keeps the first
 * definition of a name gets the project's, as these providers do.
 */
export function providerMcpConfigSources(
  provider: string,
  args: { cwd: string; env?: NodeJS.ProcessEnv; homeDir?: string },
): McpConfigSource[] {
  const env = args.env ?? process.env;
  const homeDir = args.homeDir ?? os.homedir();
  const homes = { env, homeDir };
  const json = (file: string, scope: McpConfigSource["scope"]): McpConfigSource => ({ file, format: "json", key: "mcpServers", scope });
  const toml = (file: string, scope: McpConfigSource["scope"]): McpConfigSource => ({ file, format: "toml", key: "mcp_servers", scope });
  switch (provider) {
    case "droid": {
      // `.factory/mcp.json` in the folder and every folder above it, then the user's.
      const sources: McpConfigSource[] = [];
      for (let dir = path.resolve(args.cwd); ; dir = path.dirname(dir)) {
        sources.push(json(path.join(dir, ".factory", "mcp.json"), "project"));
        if (path.dirname(dir) === dir) break;
      }
      sources.push(json(path.join(factoryConfigHome(homes), "mcp.json"), "user"));
      return sources;
    }
    case "qwen":
      return [
        json(path.join(args.cwd, ".qwen", "settings.json"), "project"),
        json(path.join(qwenConfigHome(homes), "settings.json"), "user"),
      ];
    case "muse":
      return [
        json(path.join(args.cwd, ".mcp.json"), "project"),
        json(path.join(xdgConfigHome(homes), "muse", "settings.json"), "user"),
      ];
    case "kimi":
      // The project's `.kimi-code/mcp.json` (docs) or `.mcp.json` (the bundled
      // import skill names both), and `<KIMI_CODE_HOME>/mcp.json`.
      return [
        json(path.join(args.cwd, ".kimi-code", "mcp.json"), "project"),
        json(path.join(args.cwd, ".mcp.json"), "project"),
        json(path.join(kimiCodeConfigHome(homes), "mcp.json"), "user"),
      ];
    case "grok":
      // `[mcp_servers.<name>]` in `./.grok/config.toml` and `<GROK_HOME>/config.toml`.
      return [
        toml(path.join(args.cwd, ".grok", "config.toml"), "project"),
        toml(path.join(grokConfigHome(homes), "config.toml"), "user"),
      ];
    case "devin":
      return [
        ...DEVIN_MCP_FILES.map((file) => json(path.join(args.cwd, ".devin", file), "project")),
        ...DEVIN_MCP_FILES.map((file) => json(path.join(devinConfigDir(homes), file), "user")),
      ];
    case "antigravity":
      return [
        json(path.join(args.cwd, ".agents", "mcp_config.json"), "project"),
        json(path.join(homeDir, ".gemini", "config", "mcp_config.json"), "user"),
      ];
    default:
      return [];
  }
}

/** A JSON file's server table: `key`, or (no key) `mcpServers` else the whole file. */
function jsonServerTable(file: string, key: string | null): Record<string, unknown> | null {
  const json = readJson(file);
  if (!json) return null;
  const table = key ? json[key] : (isRecord(json.mcpServers) ? json.mcpServers : json);
  return isRecord(table) ? table : null;
}

function tomlServerTable(file: string): Record<string, unknown> | null {
  const text = readText(file);
  return text == null ? null : parseCodexMcpServers(text);
}

function folderAndAbove(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  return dirs;
}

/**
 * What every MCP server a provider loads on its own for a chat in `cwd` runs
 * or dials: its own config files (the account's config home from `env`, the
 * machine login's from `baseEnv`, and the project's files). Best-effort, like
 * the scan. Used to leave out a registry server the provider already starts
 * under another name, so a chat does not run two copies of one server.
 */
export function providerLoadedMcpServers(
  provider: string,
  args: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** The env whose config home is the machine login's. Defaults to this process's. */
    baseEnv?: NodeJS.ProcessEnv;
    homeDir?: string;
    /** More folders a provider keys this project's own servers by (a worktree's main checkout). */
    projectRoots?: readonly string[];
  },
): McpServerDefinition[] {
  const env = args.env ?? process.env;
  const baseEnv = args.baseEnv ?? process.env;
  const homeDir = args.homeDir ?? os.homedir();
  const roots = [args.cwd, ...(args.projectRoots ?? [])];
  const tables: Array<Record<string, unknown> | null> = [];
  const homesFor = (candidate: NodeJS.ProcessEnv) => ({ env: candidate, homeDir });
  const distinct = (files: string[]): string[] => files.filter((file, index) => files.findIndex((other) => pathsEqual(other, file)) === index);
  switch (provider) {
    case "claude": {
      const configFiles = distinct([env, baseEnv].map((candidate) => {
        const dir = candidate.CLAUDE_CONFIG_DIR?.trim();
        return path.join(dir ? path.resolve(dir) : homeDir, ".claude.json");
      }));
      for (const file of configFiles) {
        const config = readJson(file);
        if (!config) continue;
        tables.push(isRecord(config.mcpServers) ? config.mcpServers : null);
        if (isRecord(config.projects)) {
          for (const [projectPath, entry] of Object.entries(config.projects)) {
            if (isRecord(entry) && roots.some((root) => pathsEqual(projectPath, root))) {
              tables.push(isRecord(entry.mcpServers) ? entry.mcpServers : null);
            }
          }
        }
      }
      for (const root of roots) tables.push(jsonServerTable(path.join(root, ".mcp.json"), "mcpServers"));
      break;
    }
    case "codex":
      for (const file of distinct([env, baseEnv].map((candidate) => path.join(codexConfigHome(homesFor(candidate)), "config.toml")))) {
        tables.push(tomlServerTable(file));
      }
      tables.push(tomlServerTable(path.join(args.cwd, ".codex", "config.toml")));
      break;
    case "copilot":
      tables.push(jsonServerTable(path.join(copilotConfigHome(homesFor(env)), "mcp-config.json"), "mcpServers"));
      for (const dir of folderAndAbove(args.cwd)) {
        tables.push(jsonServerTable(path.join(dir, ".mcp.json"), null));
        tables.push(jsonServerTable(path.join(dir, ".github", "mcp.json"), null));
      }
      break;
    case "cursor":
      tables.push(jsonServerTable(path.join(homeDir, ".cursor", "mcp.json"), "mcpServers"));
      tables.push(jsonServerTable(path.join(args.cwd, ".cursor", "mcp.json"), "mcpServers"));
      break;
    case "opencode":
      for (const file of ["opencode.json", "opencode.jsonc"]) {
        tables.push(jsonServerTable(path.join(openCodeConfigDir(homesFor(env)), file), "mcp"));
        tables.push(jsonServerTable(path.join(args.cwd, file), "mcp"));
      }
      tables.push(jsonServerTable(path.join(args.cwd, ".opencode", "opencode.json"), "mcp"));
      break;
    case "pi":
      tables.push(jsonServerTable(path.join(piAgentDir(homesFor(env)), "mcp.json"), "mcpServers"));
      tables.push(jsonServerTable(path.join(args.cwd, ".pi", "mcp.json"), "mcpServers"));
      break;
    default:
      for (const source of providerMcpConfigSources(provider, { cwd: args.cwd, env, homeDir })) {
        tables.push(source.format === "toml" ? tomlServerTable(source.file) : jsonServerTable(source.file, source.key));
      }
  }
  const servers: McpServerDefinition[] = [];
  for (const table of tables) {
    if (!table) continue;
    for (const [name, entry] of Object.entries(table)) {
      // A server its own config switched off does not start.
      if (isRecord(entry) && (entry.enabled === false || entry.disabled === true)) continue;
      const definition = mcpServerDefinitionFromConfig(name, entry);
      if (definition) servers.push(definition);
    }
  }
  return servers;
}

/**
 * The MCP server names a provider loads from its own config files for a chat
 * in `cwd`, for the providers that cannot drop their own copy of a server.
 * ADE then leaves out a registry server of the same name, which would
 * otherwise start a second copy (Droid, Qwen, Kimi, Grok, Devin, Antigravity:
 * not shown to replace), or refuse the session's server (Muse refuses a
 * session server whose name its own config already has, rather than starting
 * either). Claude, Codex, Copilot (probed) and Cursor (documented first-match
 * precedence, inline first) replace a same-named server from the launch, and
 * OpenCode merges its config by key, so they are not listed.
 */
export function providerOwnMcpServerNames(
  provider: string,
  args: { cwd: string; env?: NodeJS.ProcessEnv; homeDir?: string },
): Set<string> {
  const names = new Set<string>();
  for (const source of providerMcpConfigSources(provider, args)) {
    let table: unknown;
    if (source.format === "toml") {
      const text = readText(source.file);
      table = text != null ? parseCodexMcpServers(text) : null;
    } else {
      table = readJson(source.file)?.[source.key];
    }
    if (isRecord(table)) for (const name of Object.keys(table)) names.add(name.trim());
  }
  return names;
}
