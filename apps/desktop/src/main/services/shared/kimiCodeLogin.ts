import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord, sha256Hex } from "./utils";
import { kimiCodeConfigHome } from "./providerConfigHomes";

/**
 * Where this machine's Kimi Code login lives, resolved the way Kimi Code
 * itself resolves it (read from the `kimi` binary, `packages/oauth/src`:
 * `managed-kimi-code.ts` `resolveKimiCodeRuntimeAuth`, `toolkit.ts`
 * `resolveKimiTokenStorageName`, `storage.ts` `FileTokenStorage`, and
 * `region.ts`).
 *
 * A login is an OAuth token file in `$KIMI_CODE_HOME/credentials/`. Which file
 * depends on the environment it was made for:
 *
 * - The mainland-China default (`auth.kimi.com` + `api.kimi.com/coding/v1`)
 *   uses the slot `oauth/kimi-code`, file `kimi-code.json`.
 * - Any other pairing, including `kimi login --region global`, uses
 *   `oauth/kimi-code-env-<first 16 hex of sha256(JSON.stringify({ oauthHost,
 *   baseUrl }))>`, file `kimi-code-env-<hash>.json`.
 *
 * `kimi login` records the slot and the API base in `config.toml` under
 * `[providers."managed:kimi-code"]` (`base_url`, and an `oauth` table with
 * `storage`, `key`, and `oauth_host`). At run time Kimi reads that entry, then
 * lets `KIMI_CODE_BASE_URL` and `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`
 * override it. The `region` marker file only picks the region of a login that
 * has not happened yet, so it counts only when `config.toml` names no login.
 *
 * Differences from Kimi, all deliberate: a blank env variable counts as unset
 * (ADE's rule for every provider home), a blank `base_url` counts as absent,
 * and a `keyring` login returns null because ADE reads files only.
 */

export type KimiCodeLogin = {
  /** The OAuth token file: `access_token`, `refresh_token`, `expires_at`. */
  credentialPath: string;
  /** The managed API base, no trailing slash: `/usages` and `/me` hang off it. */
  baseUrl: string;
  /** `config` when `config.toml` names the login; `legacy` when it names none (the pre-config layout). */
  source: "config" | "legacy";
};

const KIMI_CODE_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_CODE_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_GLOBAL_BASE_URL = "https://api.kimi.ai/coding/v1";

const MANAGED_PROVIDER_NAME = "managed:kimi-code";
const DEFAULT_OAUTH_KEY = "oauth/kimi-code";
const SCOPED_OAUTH_KEY_PREFIX = "oauth/kimi-code-env-";
const PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "kimi",
  "google-genai",
  "openai_responses",
  "vertexai",
]);

type OAuthRef = { storage: "file" | "keyring"; key: string; oauthHost?: string };
type ManagedProvider = { baseUrl?: string; oauth?: OAuthRef };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value?.trim() ? value : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Kimi's `resolveKimiCodeOAuthKey`: the credential slot for an (OAuth host, API base) pair. */
export function kimiCodeOAuthKey(args: { oauthHost?: string; baseUrl?: string }): string {
  const oauthHost = stripTrailingSlashes((args.oauthHost ?? KIMI_CODE_DEFAULT_OAUTH_HOST).trim());
  const baseUrl = stripTrailingSlashes(args.baseUrl ?? KIMI_CODE_DEFAULT_BASE_URL);
  if (oauthHost === KIMI_CODE_DEFAULT_OAUTH_HOST && baseUrl === KIMI_CODE_DEFAULT_BASE_URL) return DEFAULT_OAUTH_KEY;
  return `${SCOPED_OAUTH_KEY_PREFIX}${sha256Hex(JSON.stringify({ oauthHost, baseUrl })).slice(0, 16)}`;
}

/** Kimi's `resolveKimiTokenStorageName` + `FileTokenStorage.pathFor`: the token file's name, or null. */
function tokenFileName(key: string): string | null {
  let name: string;
  if (key === "kimi-code" || key === DEFAULT_OAUTH_KEY) name = "kimi-code";
  else if (key.startsWith("oauth/") && key.length > "oauth/".length) name = key.slice("oauth/".length);
  else if (!key.includes("/") && !key.startsWith(".")) name = key;
  else return null;
  if (!name || name.startsWith(".") || path.basename(name) !== name) return null;
  return `${name}.json`;
}

/** Kimi's `snakeToCamel` over one table's keys; a later spelling of the same key wins, as in Kimi. */
function camelKeys(table: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    value,
  ]));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function stringRecord(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"));
}

/**
 * The `managed:kimi-code` entry, or undefined when there is none or Kimi's
 * schema would drop it (its lenient loader drops an invalid provider entry
 * whole, and a file that is not TOML reads as an empty config).
 */
function readManagedProvider(configPath: string): ManagedProvider | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  let providers: unknown;
  try {
    providers = parseKimiConfigToml(text).providers;
  } catch {
    return undefined;
  }
  if (!isRecord(providers) || !isRecord(providers[MANAGED_PROVIDER_NAME])) return undefined;
  const entry = camelKeys(providers[MANAGED_PROVIDER_NAME]);
  if (typeof entry.type !== "string" || !PROVIDER_TYPES.has(entry.type)) return undefined;
  if (!optionalString(entry.apiKey) || !optionalString(entry.baseUrl) || !optionalString(entry.defaultModel)) return undefined;
  if (!stringRecord(entry.env) || !stringRecord(entry.customHeaders)) return undefined;
  if (entry.source !== undefined && !isRecord(entry.source)) return undefined;
  let oauth: OAuthRef | undefined;
  if (entry.oauth !== undefined) {
    if (!isRecord(entry.oauth)) return undefined;
    const ref = camelKeys(entry.oauth);
    if (ref.storage !== "file" && ref.storage !== "keyring") return undefined;
    if (typeof ref.key !== "string" || ref.key.length === 0) return undefined;
    if (ref.oauthHost !== undefined && (typeof ref.oauthHost !== "string" || ref.oauthHost.length === 0)) return undefined;
    oauth = { storage: ref.storage, key: ref.key, ...(typeof ref.oauthHost === "string" ? { oauthHost: ref.oauthHost } : {}) };
  }
  const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl.trim() ? entry.baseUrl : undefined;
  return { ...(baseUrl ? { baseUrl } : {}), ...(oauth ? { oauth } : {}) };
}

/** Kimi's `readRegionMarker`: `mainland-cn` or `global`, exactly, after trimming. */
function readRegionMarker(homeDir: string): "mainland-cn" | "global" | undefined {
  try {
    const value = readFileSync(path.join(homeDir, "region"), "utf8").trim();
    return value === "mainland-cn" || value === "global" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Kimi Code login on this machine, or null when there is none: no token
 * file in the slot Kimi would read, or a login held in the OS keyring.
 */
export function resolveKimiCodeLogin(args: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): KimiCodeLogin | null {
  const env = args.env ?? process.env;
  const home = kimiCodeConfigHome({ env, homeDir: args.homeDir });
  const envBaseUrl = envValue(env, "KIMI_CODE_BASE_URL");
  const envOAuthHost = envValue(env, "KIMI_CODE_OAUTH_HOST") ?? envValue(env, "KIMI_OAUTH_HOST");
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const configured = readManagedProvider(path.join(home, "config.toml"));

  const baseUrl = envBaseUrl !== undefined ? stripTrailingSlashes(envBaseUrl) : configured?.baseUrl;
  const expectedKey = kimiCodeOAuthKey({
    oauthHost: hasEnvOverride ? envOAuthHost : configured?.oauth?.oauthHost,
    baseUrl,
  });
  // Kimi keeps the configured ref only when no env override is set and its key
  // is the one this environment maps to; either way the slot is `expectedKey`.
  const configuredRef = configured?.oauth;
  const storage = configuredRef && !hasEnvOverride && configuredRef.key === expectedKey ? configuredRef.storage : "file";
  if (storage !== "file") return null;

  const fileName = tokenFileName(expectedKey);
  if (!fileName) return null;
  const credentialPath = path.join(home, "credentials", fileName);
  if (!existsSync(credentialPath)) return null;

  const markerBase = !configured && !hasEnvOverride && env.KIMI_CODE_REGION_MARKER !== "off"
    && readRegionMarker(home) === "global"
    ? KIMI_CODE_GLOBAL_BASE_URL
    : KIMI_CODE_DEFAULT_BASE_URL;
  return {
    credentialPath,
    baseUrl: stripTrailingSlashes(baseUrl ?? markerBase),
    source: configured ? "config" : "legacy",
  };
}

// ── TOML ──────────────────────────────────────────────────────────────
//
// ADE carries no TOML parser (Codex's `config.toml` is read with section
// regexes), and Kimi's `providers."managed:kimi-code".oauth` can be written as
// a sub-table, an inline table, or dotted keys, so a section regex would miss
// hand-edited files. This reader covers the TOML Kimi writes (smol-toml's
// `stringify`) and what a hand edit adds: comments, `[table]` and
// `[[array]]` headers, dotted and quoted keys, the four string forms, inline
// tables, and arrays. Numbers, booleans, and dates are stepped over and read
// as null. It throws on anything else, a bare word (`k = hello`) included,
// which the caller reads as no config — what Kimi's own lenient loader does
// with a file smol-toml cannot parse.

type TomlTable = Record<string, unknown>;

/** A null-prototype table, so a `__proto__` key in the file is plain data. */
function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const LINE_ENDING_BACKSLASH = /\\[ \t]*\r?\n/y;
const TOML_DEC_INT = "[+-]?(?:0|[1-9](?:_?[0-9])*)";
const TOML_DIGITS = "[0-9](?:_?[0-9])*";
const TOML_EXPONENT = `[eE][+-]?${TOML_DIGITS}`;
const TOML_TIME = "[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\\.[0-9]+)?)?";
const TOML_DATE_TIME = `[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[Tt ]${TOML_TIME}(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?)?`;
/**
 * A boolean, number, date, or time; a date-time may use a space before its
 * time. Anything else, a bare word included, is not a TOML value.
 */
const SCALAR = new RegExp(
  `(?:true|false|${TOML_DATE_TIME}|${TOML_TIME}`
    + `|${TOML_DEC_INT}(?:\\.${TOML_DIGITS}(?:${TOML_EXPONENT})?|${TOML_EXPONENT})|[+-]?(?:inf|nan)`
    + `|${TOML_DEC_INT}|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)`
    + "(?![0-9A-Za-z_.:+-])",
  "y",
);

/** Kimi's `config.toml`, as far as ADE reads it. Exported for tests. */
export function parseKimiConfigToml(source: string): TomlTable {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const root = newTable();
  const headerTables = new Set<TomlTable>();
  let index = 0;

  const fail = (): never => {
    throw new Error(`Unreadable TOML at offset ${index}`);
  };
  const skipSpaces = (): void => {
    while (text[index] === " " || text[index] === "\t") index += 1;
  };
  const skipComment = (): void => {
    if (text[index] !== "#") return;
    while (index < text.length && text[index] !== "\n") index += 1;
  };
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (text[index] === "\n" || text[index] === "\r") {
        index += 1;
        continue;
      }
      return;
    }
  };
  const endStatement = (): void => {
    skipSpaces();
    skipComment();
    if (index >= text.length) return;
    if (text[index] === "\r") index += 1;
    if (text[index] !== "\n") fail();
    index += 1;
  };

  const readEscape = (): string => {
    const code = text[index + 1];
    index += 2;
    switch (code) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case "e": return "\u001b";
      case "\"": return "\"";
      case "\\": return "\\";
      case "u":
      case "U": {
        const length = code === "u" ? 4 : 8;
        const hex = text.slice(index, index + length);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) fail();
        index += length;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        return fail();
    }
  };

  const readString = (): string => {
    const quote = text[index]!;
    const multiline = text.startsWith(quote.repeat(3), index);
    index += multiline ? 3 : 1;
    if (multiline && text[index] === "\n") index += 1;
    else if (multiline && text.startsWith("\r\n", index)) index += 2;
    let value = "";
    for (;;) {
      if (index >= text.length) fail();
      const char = text[index]!;
      if (multiline && text.startsWith(quote.repeat(3), index)) {
        // A delimiter may be preceded by up to two quotes that belong to the content.
        let run = 3;
        while (text[index + run] === quote && run < 5) run += 1;
        value += quote.repeat(run - 3);
        index += run;
        return value;
      }
      if (!multiline && char === quote) {
        index += 1;
        return value;
      }
      if (!multiline && (char === "\n" || char === "\r")) fail();
      if (quote === "\"" && char === "\\") {
        LINE_ENDING_BACKSLASH.lastIndex = index;
        if (multiline && LINE_ENDING_BACKSLASH.test(text)) {
          index += 1;
          while (/[ \t\r\n]/.test(text[index] ?? "")) index += 1;
          continue;
        }
        value += readEscape();
        continue;
      }
      value += char;
      index += 1;
    }
  };

  const readMatch = (pattern: RegExp): string => {
    pattern.lastIndex = index;
    const match = pattern.exec(text)?.[0];
    if (!match) return fail();
    index += match.length;
    return match;
  };

  const readKey = (): string[] => {
    const keys: string[] = [];
    for (;;) {
      skipSpaces();
      const char = text[index];
      if (char === "\"" || char === "'") {
        if (text.startsWith(char.repeat(3), index)) fail();
        keys.push(readString());
      } else {
        keys.push(readMatch(BARE_KEY));
      }
      skipSpaces();
      if (text[index] !== ".") return keys;
      index += 1;
    }
  };

  const tableAt = (table: TomlTable, key: string): TomlTable => {
    const existing = table[key];
    if (existing === undefined) {
      const created = newTable();
      table[key] = created;
      return created;
    }
    if (Array.isArray(existing) && existing.length > 0 && isRecord(existing[existing.length - 1])) {
      return existing[existing.length - 1] as TomlTable;
    }
    return isRecord(existing) ? existing : fail();
  };

  const assign = (table: TomlTable, keys: string[], value: unknown): void => {
    let target = table;
    for (const key of keys.slice(0, -1)) target = tableAt(target, key);
    const last = keys[keys.length - 1]!;
    if (Object.prototype.hasOwnProperty.call(target, last)) fail();
    target[last] = value;
  };

  const readValue = (): unknown => {
    const char = text[index];
    if (char === "\"" || char === "'") return readString();
    if (char === "{") {
      index += 1;
      const table = newTable();
      skipBlank();
      while (text[index] !== "}") {
        const keys = readKey();
        if (text[index] !== "=") fail();
        index += 1;
        skipSpaces();
        assign(table, keys, readValue());
        skipBlank();
        if (text[index] === ",") {
          index += 1;
          skipBlank();
        } else if (text[index] !== "}") {
          fail();
        }
      }
      index += 1;
      return table;
    }
    if (char === "[") {
      index += 1;
      const items: unknown[] = [];
      skipBlank();
      while (text[index] !== "]") {
        items.push(readValue());
        skipBlank();
        if (text[index] === ",") {
          index += 1;
          skipBlank();
        } else if (text[index] !== "]") {
          fail();
        }
      }
      index += 1;
      return items;
    }
    // A number, boolean, or date: stepped over, not decoded.
    readMatch(SCALAR);
    return null;
  };

  let current = root;
  for (;;) {
    skipBlank();
    if (index >= text.length) return root;
    if (text[index] === "[") {
      const arrayTable = text[index + 1] === "[";
      index += arrayTable ? 2 : 1;
      const keys = readKey();
      if (!text.startsWith(arrayTable ? "]]" : "]", index)) fail();
      index += arrayTable ? 2 : 1;
      let parent = root;
      for (const key of keys.slice(0, -1)) parent = tableAt(parent, key);
      const last = keys[keys.length - 1]!;
      if (arrayTable) {
        const existing = parent[last] ?? [];
        if (!Array.isArray(existing)) fail();
        const table = newTable();
        (existing as unknown[]).push(table);
        parent[last] = existing;
        current = table;
      } else {
        current = tableAt(parent, last);
        if (headerTables.has(current)) fail();
        headerTables.add(current);
      }
    } else {
      const keys = readKey();
      if (text[index] !== "=") fail();
      index += 1;
      skipSpaces();
      assign(current, keys, readValue());
    }
    endStatement();
  }
}
