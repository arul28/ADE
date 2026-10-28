/**
 * Reading an MCP server out of somebody else's config.
 *
 * Every provider CLI writes the same few facts — a command with arguments and
 * env variables, or a URL with headers — under slightly different keys. This
 * module turns one such entry into the registry's shape, keeping the secret
 * VALUES beside it instead of in it, so the two callers can each send the
 * values to the one place they belong:
 *
 * - the settings page's "paste a JSON snippet" (renderer), and
 * - the "found on this computer" scan and its Import (main process).
 *
 * Pure: no file system, no IPC.
 */

import { parseJsonc } from "./theme/jsonc";
import { isValidMcpFieldName, type McpRegistryTransport } from "./mcpRegistry";

/** One server as a config file states it. Not validated as a registry server yet. */
export type McpServerDefinition = {
  /** Empty when the source did not name it (a single pasted server object). */
  name: string;
  transport: McpRegistryTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Env variables for a `stdio` server. The values are secrets. */
  env: Record<string, string>;
  /** Headers for an `http` / `sse` server. The values are secrets. */
  headers: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = key.trim();
    if (!isValidMcpFieldName(name)) continue;
    if (typeof entry === "string") out[name] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[name] = String(entry);
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * One config entry as a server, or null when it is not one.
 *
 * Accepts the shapes in use today: Claude / Cursor / Droid / Copilot / Kimi
 * (`command`, `args`, `env`, or `url`, `headers`, with an optional `type` or
 * `transport`), OpenCode (`type: "local"` with `command` as one list and
 * `environment`; `type: "remote"`), Gemini-style Qwen (`httpUrl` for
 * streamable HTTP), Antigravity / Devin (`serverUrl`), and Codex's or Grok's
 * table once read from TOML (`http_headers`).
 */
export function mcpServerDefinitionFromConfig(name: string, raw: unknown): McpServerDefinition | null {
  if (!isRecord(raw)) return null;
  const typeField = typeof raw.type === "string" ? raw.type : typeof raw.transport === "string" ? raw.transport : "";
  const httpUrl = typeof raw.httpUrl === "string" ? raw.httpUrl.trim() : "";
  // `httpUrl` is streamable HTTP by definition, whatever its path looks like.
  const type = httpUrl ? "http" : typeField.trim().toLowerCase().replace(/^streamable[-_]?http$/, "http");
  const env = { ...stringMap(raw.environment), ...stringMap(raw.env) };
  const headers = { ...stringMap(raw.http_headers), ...stringMap(raw.headers) };
  const url = httpUrl
    || (typeof raw.url === "string" ? raw.url.trim() : "")
    || (typeof raw.serverUrl === "string" ? raw.serverUrl.trim() : "");
  const commandList = Array.isArray(raw.command) ? stringList(raw.command) : null;
  const command = commandList ? (commandList[0] ?? "").trim() : typeof raw.command === "string" ? raw.command.trim() : "";
  const args = commandList ? commandList.slice(1) : stringList(raw.args);

  if (command && type !== "http" && type !== "sse" && type !== "remote") {
    return { name: name.trim(), transport: "stdio", command, ...(args.length ? { args } : {}), env, headers: {} };
  }
  if (url) {
    // A config that does not say which HTTP protocol is read by its URL: the
    // old SSE transport conventionally answers on a path ending in `/sse`.
    const transport: McpRegistryTransport = type === "sse" || (type !== "http" && /\/sse\/?(\?.*)?$/i.test(url)) ? "sse" : "http";
    return { name: name.trim(), transport, url, env: {}, headers };
  }
  return null;
}

/**
 * The servers in a pasted snippet.
 *
 * Takes the usual `{"mcpServers": {...}}`, OpenCode's `{"mcp": {...}}`, a bare
 * `{"name": {...}}` map, or one server object on its own (which comes back
 * with an empty name for the form to ask for). Comments and trailing commas
 * are allowed. Returns an empty list when nothing in it is a server.
 */
export function parseMcpServerSnippet(text: string): McpServerDefinition[] {
  let parsed: unknown;
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    parsed = parseJsonc(trimmed);
  } catch {
    // A fragment copied out of the middle of a file: `"name": { ... }`.
    try {
      parsed = parseJsonc(`{${trimmed.replace(/,\s*$/, "")}}`);
    } catch {
      return [];
    }
  }
  if (!isRecord(parsed)) return [];
  const single = mcpServerDefinitionFromConfig(typeof parsed.name === "string" ? parsed.name : "", parsed);
  if (single) return [single];
  const table = isRecord(parsed.mcpServers) ? parsed.mcpServers
    : isRecord(parsed.mcp_servers) ? parsed.mcp_servers
      : isRecord(parsed.mcp) ? parsed.mcp
        : isRecord(parsed.servers) ? parsed.servers
          : parsed;
  const out: McpServerDefinition[] = [];
  for (const [name, entry] of Object.entries(table)) {
    const server = mcpServerDefinitionFromConfig(name, entry);
    if (server) out.push(server);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Secrets in the wrong place
// ---------------------------------------------------------------------------

/**
 * Something in a server's arguments or URL that looks like a secret.
 *
 * The registry keeps env and header VALUES in the vault, but arguments and the
 * URL are part of the list and sync as plain text. A token passed as
 * `--api-key sk-…` or `?token=…` therefore lands in the readable row. This is a
 * guess from the text's shape, so it only ever warns; it never blocks a save.
 *
 * - `value`: it looks like the secret itself.
 * - `reference`: a `${NAME}` placeholder. Some provider CLIs fill those in
 *   from the environment; ADE hands the text over as written.
 */
export type McpPlainTextSecretFinding = {
  where: "args" | "url";
  kind: "value" | "reference";
  /** For a `reference`, the placeholder as written (`${NAME}`). Never a secret value. */
  reference?: string;
};

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/;
const SECRET_WORD = /(?:^|[-_.])(?:api[-_]?key|key|token|secret|password|passwd|pwd|auth|authorization|bearer|signature|sig|credential|credentials)$/i;
const KNOWN_TOKEN_PREFIX = /^(?:sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abprs]-|eyJ|AKIA|AIza|ya29\.|lin_api_|phc_|phx_)[A-Za-z0-9_\-.]{8,}/;

/** A long run of letters and digits with no word shape: what a generated token looks like. */
function looksLikeToken(text: string): boolean {
  const value = text.trim();
  if (KNOWN_TOKEN_PREFIX.test(value)) return true;
  if (value.length < 24 || !/^[A-Za-z0-9_\-+=.]+$/.test(value)) return false;
  // A file name, a package name or a version has dots and few digits; a token
  // mixes letters and digits throughout.
  const digits = value.replace(/[^0-9]/g, "").length;
  const letters = value.replace(/[^A-Za-z]/g, "").length;
  return digits >= 4 && letters >= 4;
}

function urlHoldsSecret(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(url.protocol)) return false;
  if (url.password || (url.username && looksLikeToken(url.username))) return true;
  for (const [name, value] of url.searchParams) {
    if (!value || ENV_REFERENCE.test(value)) continue;
    if (SECRET_WORD.test(name) || looksLikeToken(value)) return true;
  }
  // A stray `%` is a legal thing to type and to have saved; it must not throw
  // out of a render.
  return url.pathname.split("/").some((segment) => {
    try {
      return looksLikeToken(decodeURIComponent(segment));
    } catch {
      return looksLikeToken(segment);
    }
  });
}

/**
 * What in this server's arguments and URL looks like a secret. Empty when
 * nothing does. At most one finding per place and kind, so the page shows one
 * line each.
 */
export function mcpPlainTextSecretFindings(
  server: { args?: readonly string[]; url?: string },
): McpPlainTextSecretFinding[] {
  const findings: McpPlainTextSecretFinding[] = [];
  const add = (finding: McpPlainTextSecretFinding): void => {
    if (!findings.some((entry) => entry.where === finding.where && entry.kind === finding.kind)) findings.push(finding);
  };
  const args = server.args ?? [];
  args.forEach((arg, index) => {
    const reference = arg.match(ENV_REFERENCE);
    if (reference) add({ where: "args", kind: "reference", reference: reference[0] });
    const withoutReferences = arg.replace(new RegExp(ENV_REFERENCE.source, "g"), "");
    // `Authorization: Bearer abc…`, with the token in this argument.
    if (/\bBearer\s+[^\s$]{8,}/i.test(withoutReferences)) add({ where: "args", kind: "value" });
    // `--api-key=abc…`, or `--api-key` followed by its value.
    const flag = arg.match(/^--?([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/);
    if (flag && SECRET_WORD.test(flag[1]!)) {
      const value = flag[2] ?? args[index + 1] ?? "";
      if (value && !value.startsWith("-") && !ENV_REFERENCE.test(value)) add({ where: "args", kind: "value" });
    }
    if (/^https?:\/\//i.test(arg) ? urlHoldsSecret(arg) : looksLikeToken(withoutReferences)) add({ where: "args", kind: "value" });
    // `Header: value` and `NAME=value` pairs passed as one argument.
    const pair = withoutReferences.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$/);
    if (pair && (looksLikeToken(pair[2]!) || (SECRET_WORD.test(pair[1]!) && pair[2]!.trim().length >= 8))) {
      add({ where: "args", kind: "value" });
    }
  });
  const url = server.url?.trim() ?? "";
  if (url) {
    const reference = url.match(ENV_REFERENCE);
    if (reference) add({ where: "url", kind: "reference", reference: reference[0] });
    if (urlHoldsSecret(url)) add({ where: "url", kind: "value" });
  }
  return findings;
}
