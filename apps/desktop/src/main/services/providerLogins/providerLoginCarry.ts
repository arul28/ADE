/**
 * The carry table: for each provider, where its login lives on this computer,
 * how ADE reads a login out of it, and whether ADE copies it into the account.
 *
 * Rules every row keeps:
 * - Each locator honours the provider's own env override, as the CLI does
 *   (`providerConfigHomes.ts`), so ADE reads the file the CLI reads.
 * - A file is named by a root token and a relative path, never an absolute
 *   path, so a sign-in from a Mac applies on Linux (P5 step 2).
 * - `parse` returns secrets only inside `files`, `parts` and `familySecret`.
 *   The caller hashes `familySecret` and never logs any of them.
 * - A login in an OS keychain or keyring is never read here. `osStore` only
 *   says that one exists, for `status`.
 * - Claude's own login and Pi's Anthropic login are never carried.
 *
 * A row with `carry: "fallback"` is built where the format is known and stays
 * off until a real test passes; turning one on is a one-line change here.
 */

import fs from "node:fs";
import path from "node:path";

import type { ProviderLoginCarry, ProviderLoginClass, ProviderLoginLocalState, ProviderLoginProvider } from "../../../shared/types/providerLogins";
import {
  codexConfigHome,
  devinCredentialFiles,
  factoryConfigHome,
  ghHostsFiles,
  grokConfigHome,
  kimiCodeConfigHome,
  piAgentDir,
  qwenConfigHome,
} from "../shared/providerConfigHomes";
import { kimiCodeLoginInKeyring, parseKimiConfigToml, resolveKimiCodeLogin } from "../shared/kimiCodeLogin";
import { parseQwenUserSettings } from "../ai/qwenUserSettings";
import { isRecord } from "../shared/utils";

/**
 * Whether the gh login (`hosts.yml`) also counts as a Copilot sign-in to carry.
 * Off: the owner decides (P5 open question 5). A yes is this one line.
 */
export const CARRY_GH_HOSTS_FOR_COPILOT = false;

/** Symbolic roots. Apply resolves each one with the same locator on the target computer. */
export type CarryRoot =
  | "codexHome"
  | "grokHome"
  | "kimiHome"
  | "factoryHome"
  | "devinData"
  | "cursorSdk"
  | "copilotHome"
  | "ghConfig"
  | "qwenHome"
  | "geminiHome"
  | "piAgent";

export type CarryContext = {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  /** True on an ADE Cloud computer (`isCloudMachine()`). */
  cloudComputer: boolean;
};

export type CarryFileSpec = {
  root: CarryRoot;
  rel: string;
  abs: string;
  /** False: read for its fields (they go in `parts`), not carried as a file. */
  carry: boolean;
  /** A bundle with a required file missing is "not signed in". */
  required: boolean;
};

/** Files read together in one stable pass. One bundle can hold several sign-ins (Pi). */
export type CarryBundle = {
  /** Stable id for the local state file, `<provider>/<name>`. */
  id: string;
  files: CarryFileSpec[];
};

export type CarriedFile = { root: CarryRoot; rel: string; enc: "utf8" | "base64"; data: string };

export type ParsedLogin = {
  slot: string;
  class: ProviderLoginClass;
  /** The token family's stable secret (the refresh token, or the whole Fixed login). Hashed, never stored. */
  familySecret: string;
  account: { email: string | null; id: string | null } | null;
  expiresAt: number | null;
  files: CarriedFile[];
  parts?: Record<string, unknown>;
};

export type CarryParseResult = {
  logins: ParsedLogin[];
  /** Sign-ins in the bundle that are seen but not carried, with the reason. */
  skipped: Array<{ slot: string; state: ProviderLoginLocalState }>;
} | { unreadable: true };

export type CarryRow = {
  provider: ProviderLoginProvider;
  carry: ProviderLoginCarry;
  /** Plain words for the person: what ADE does with this provider's sign-in. */
  message: string;
  locate?: (ctx: CarryContext) => CarryBundle[];
  parse?: (bundle: CarryBundle, contents: ReadonlyMap<string, Buffer>, ctx: CarryContext) => CarryParseResult;
  /** True when a login exists in an OS store ADE does not read. May read one small config file. */
  osStore?: (ctx: CarryContext) => boolean;
};

// ── small readers ─────────────────────────────────────────────────────

function text(contents: ReadonlyMap<string, Buffer>, rel: string): string | null {
  const buffer = contents.get(rel);
  return buffer ? buffer.toString("utf8") : null;
}

function json(contents: ReadonlyMap<string, Buffer>, rel: string): Record<string, unknown> | null {
  const raw = text(contents, rel);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function str(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jwtClaims(token: string | null): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Carry the bytes as they are: UTF-8 text when it round-trips, else base64. */
export function carriedFile(spec: CarryFileSpec, buffer: Buffer): CarriedFile {
  const asText = buffer.toString("utf8");
  return Buffer.from(asText, "utf8").equals(buffer)
    ? { root: spec.root, rel: spec.rel, enc: "utf8", data: asText }
    : { root: spec.root, rel: spec.rel, enc: "base64", data: buffer.toString("base64") };
}

function carriedFiles(bundle: CarryBundle, contents: ReadonlyMap<string, Buffer>): CarriedFile[] {
  const files: CarriedFile[] = [];
  for (const spec of bundle.files) {
    if (!spec.carry) continue;
    const buffer = contents.get(spec.rel);
    if (buffer) files.push(carriedFile(spec, buffer));
  }
  return files;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function file(root: CarryRoot, dir: string, rel: string, options: { carry?: boolean; required?: boolean } = {}): CarryFileSpec {
  return { root, rel, abs: path.join(dir, rel), carry: options.carry ?? true, required: options.required ?? true };
}

// ── Kimi: the login slot comes from config.toml, read only when it changes ──

let kimiMemo: { configPath: string; mark: string; envKey: string; credentialRel: string | null } | null = null;

function statMark(target: string): string {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "-";
  }
}

function kimiCredentialRel(ctx: CarryContext): string | null {
  const home = kimiCodeConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
  const configPath = path.join(home, "config.toml");
  // The config names the slot; a new token file changes the folder. No config
  // is Kimi's legacy layout, which `resolveKimiCodeLogin` still reads.
  const mark = `${statMark(configPath)}|${statMark(path.join(home, "credentials"))}`;
  const envKey = [ctx.env.KIMI_CODE_BASE_URL, ctx.env.KIMI_CODE_OAUTH_HOST, ctx.env.KIMI_OAUTH_HOST, ctx.env.KIMI_CODE_REGION_MARKER].join("|");
  if (kimiMemo && kimiMemo.configPath === configPath && kimiMemo.mark === mark && kimiMemo.envKey === envKey) {
    return kimiMemo.credentialRel;
  }
  const login = resolveKimiCodeLogin({ env: ctx.env, homeDir: ctx.homeDir });
  const credentialRel = login ? path.relative(home, login.credentialPath).split(path.sep).join("/") : null;
  kimiMemo = { configPath, mark, envKey, credentialRel };
  return credentialRel;
}

/** The `managed:kimi-code` provider entry, only the fields a login needs (never `api_key` or env). */
function kimiProviderPart(configText: string | null): Record<string, unknown> | null {
  if (!configText) return null;
  let providers: unknown;
  try {
    providers = parseKimiConfigToml(configText).providers;
  } catch {
    return null;
  }
  const entry = isRecord(providers) ? providers["managed:kimi-code"] : null;
  if (!isRecord(entry)) return null;
  const oauth = isRecord(entry.oauth) ? entry.oauth : null;
  const type = str(entry, "type");
  const baseUrl = str(entry, "base_url") ?? str(entry, "baseUrl");
  const key = str(oauth, "key");
  const storage = str(oauth, "storage");
  const oauthHost = str(oauth, "oauth_host") ?? str(oauth, "oauthHost");
  return {
    ...(type ? { type } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(key && storage ? { oauth: { storage, key, ...(oauthHost ? { oauthHost } : {}) } } : {}),
  };
}

// ── Pi ────────────────────────────────────────────────────────────────

/** Pi sub-providers whose OAuth sign-in is carried. Only xAI is tested (P5 brief). */
const PI_RENEWING_SUBPROVIDERS: ReadonlySet<string> = new Set(["xai"]);
/** A Pi sub-provider id that also fits a vault key slot. */
const PI_SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parsePi(contents: ReadonlyMap<string, Buffer>): CarryParseResult {
  const data = json(contents, "auth.json");
  if (!data) return { unreadable: true };
  const logins: ParsedLogin[] = [];
  const skipped: Array<{ slot: string; state: ProviderLoginLocalState }> = [];
  for (const [subProvider, value] of Object.entries(data)) {
    // Never Pi's Anthropic login (a Claude login), in any form.
    if (subProvider === "anthropic" || !isRecord(value) || !PI_SLOT.test(subProvider)) continue;
    if (value.type === "api_key") {
      const key = str(value, "key");
      // A `!command` or an env reference runs or resolves on the computer that reads it: never carried.
      if (!key || key.startsWith("!") || value.env !== undefined) {
        skipped.push({ slot: subProvider, state: "not_checked" });
        continue;
      }
      logins.push({
        slot: subProvider,
        class: "fixed",
        familySecret: key,
        account: null,
        expiresAt: null,
        files: [],
        parts: { piEntry: value },
      });
      continue;
    }
    if (value.type === "oauth") {
      const refresh = str(value, "refresh");
      const access = str(value, "access");
      if (!PI_RENEWING_SUBPROVIDERS.has(subProvider) || !access) {
        skipped.push({ slot: subProvider, state: "not_checked" });
        continue;
      }
      const expires = typeof value.expires === "number" ? value.expires : null;
      const accountId = str(value, "accountId");
      logins.push({
        slot: subProvider,
        class: "renewing",
        familySecret: refresh ?? access,
        account: accountId ? { email: null, id: accountId } : null,
        expiresAt: expires,
        files: [],
        parts: { piEntry: value },
      });
    }
  }
  return { logins, skipped };
}

// ── the table ─────────────────────────────────────────────────────────

const ROWS: CarryRow[] = [
  {
    provider: "claude",
    carry: "never",
    message: "ADE never copies Claude's own login. ADE Cloud uses the Claude pass instead.",
  },
  {
    provider: "codex",
    carry: "carried",
    message: "ADE copies this computer's Codex login (the file login, not one kept in the OS keyring).",
    locate: (ctx) => {
      const home = codexConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      return [{ id: "codex/base", files: [file("codexHome", home, "auth.json")] }];
    },
    parse: (bundle, contents, ctx) => {
      const data = json(contents, "auth.json");
      if (!data) return { unreadable: true };
      const tokens = isRecord(data.tokens) ? data.tokens : null;
      const access = str(tokens, "access_token");
      const apiKey = str(data, "OPENAI_API_KEY");
      if (!access && apiKey) {
        // On a cloud computer this file came from a saved ADE Cloud key; it stays a key.
        if (ctx.cloudComputer) return { logins: [], skipped: [{ slot: "base", state: "from_saved_key" }] };
        return {
          logins: [{ slot: "base", class: "fixed", familySecret: apiKey, account: null, expiresAt: null, files: carriedFiles(bundle, contents) }],
          skipped: [],
        };
      }
      if (!access) return { unreadable: true };
      const exp = jwtClaims(access)?.exp;
      const email = str(jwtClaims(str(tokens, "id_token")), "email");
      const accountId = str(tokens, "account_id");
      return {
        logins: [{
          slot: "base",
          class: "renewing",
          familySecret: str(tokens, "refresh_token") ?? access,
          account: email || accountId ? { email, id: accountId } : null,
          expiresAt: typeof exp === "number" ? exp * 1000 : null,
          files: carriedFiles(bundle, contents),
        }],
        skipped: [],
      };
    },
    osStore: (ctx) => {
      const home = codexConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      if (exists(path.join(home, "auth.json"))) return false;
      try {
        return /^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"/m.test(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
      } catch {
        return false;
      }
    },
  },
  {
    provider: "cursor",
    carry: "carried",
    message: "ADE copies the Cursor key the Cursor sign-in made. It ends after 90 days.",
    locate: (ctx) => [{ id: "cursor/base", files: [file("cursorSdk", path.join(ctx.homeDir, ".cursor", "sdk"), "auth.json")] }],
    parse: (bundle, contents) => {
      const data = json(contents, "auth.json");
      const apiKey = str(data, "apiKey");
      if (!apiKey) return { unreadable: true };
      const expires = typeof data?.apiKeyExpiresAtMs === "number" ? data.apiKeyExpiresAtMs : null;
      const email = str(data, "email");
      return {
        logins: [{ slot: "base", class: "fixed", familySecret: apiKey, account: email ? { email, id: null } : null, expiresAt: expires, files: carriedFiles(bundle, contents) }],
        skipped: [],
      };
    },
  },
  {
    provider: "opencode",
    carry: "fallback",
    message: "Sign in to OpenCode on the cloud computer, or add a key. ADE does not copy OpenCode sign-ins yet.",
  },
  {
    provider: "pi",
    carry: "carried",
    message: "ADE copies Pi's xAI sign-in and Pi's saved keys. It never copies Pi's Anthropic login. Other Pi sign-ins: sign in on the cloud computer.",
    locate: (ctx) => [{ id: "pi/auth", files: [file("piAgent", piAgentDir({ env: ctx.env, homeDir: ctx.homeDir }), "auth.json", { carry: false })] }],
    parse: (_bundle, contents) => parsePi(contents),
  },
  {
    provider: "copilot",
    // Where `copilot login` keeps its token in config.json is not known yet (P5 §14).
    carry: CARRY_GH_HOSTS_FOR_COPILOT ? "carried" : "fallback",
    message: CARRY_GH_HOSTS_FOR_COPILOT
      ? "ADE copies the GitHub CLI login that Copilot uses."
      : "Sign in to Copilot on the cloud computer, or add a token. ADE does not copy Copilot sign-ins yet.",
    ...(CARRY_GH_HOSTS_FOR_COPILOT
      ? {
        locate: (ctx: CarryContext): CarryBundle[] => {
          const hosts = ghHostsFiles({ env: ctx.env, homeDir: ctx.homeDir, platform: ctx.platform }).find(exists);
          return hosts ? [{ id: "copilot/gh", files: [file("ghConfig", path.dirname(hosts), "hosts.yml")] }] : [];
        },
        parse: (bundle: CarryBundle, contents: ReadonlyMap<string, Buffer>): CarryParseResult => {
          const raw = text(contents, "hosts.yml") ?? "";
          // A plain-text token only; gh's default keeps it in the OS keyring.
          const token = /^\s*oauth_token:\s*(\S+)/m.exec(raw)?.[1] ?? null;
          const user = /^\s*user:\s*(\S+)/m.exec(raw)?.[1] ?? null;
          if (!token) return { logins: [], skipped: [{ slot: "gh", state: "os_store" }] };
          return {
            logins: [{ slot: "gh", class: "fixed", familySecret: token, account: user ? { email: null, id: user } : null, expiresAt: null, files: carriedFiles(bundle, contents) }],
            skipped: [],
          };
        },
      }
      : {}),
  },
  {
    provider: "grok",
    carry: "carried",
    message: "ADE copies this computer's Grok login.",
    locate: (ctx) => [{ id: "grok/base", files: [file("grokHome", grokConfigHome({ env: ctx.env, homeDir: ctx.homeDir }), "auth.json")] }],
    parse: (bundle, contents) => {
      const data = json(contents, "auth.json");
      if (!data) return { unreadable: true };
      for (const value of Object.values(data)) {
        const entry = isRecord(value) ? value : null;
        const key = str(entry, "key");
        if (!entry || !key) continue;
        const refresh = Object.entries(entry).find(([name, field]) => /refresh/i.test(name) && typeof field === "string" && field.trim());
        const expires = Date.parse(str(entry, "expires_at") ?? "");
        const email = str(entry, "email");
        return {
          logins: [{
            slot: "base",
            class: "renewing",
            familySecret: (refresh?.[1] as string | undefined) ?? key,
            account: email ? { email, id: null } : null,
            expiresAt: Number.isNaN(expires) ? null : expires,
            files: carriedFiles(bundle, contents),
          }],
          skipped: [],
        };
      }
      return { unreadable: true };
    },
  },
  {
    provider: "droid",
    carry: "carried",
    message: "ADE copies Droid's file sign-in (auth.v2.file and its key). A sign-in kept in the OS keyring stays on this computer.",
    locate: (ctx) => {
      const home = factoryConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      return [{ id: "droid/base", files: [file("factoryHome", home, "auth.v2.file"), file("factoryHome", home, "auth.v2.key")] }];
    },
    parse: (bundle, contents) => {
      const key = contents.get("auth.v2.key");
      const sealed = contents.get("auth.v2.file");
      if (!key?.length || !sealed?.length) return { unreadable: true };
      // Encrypted: no account, no expiry. The key file stands for the family.
      return {
        logins: [{ slot: "base", class: "renewing", familySecret: key.toString("base64"), account: null, expiresAt: null, files: carriedFiles(bundle, contents) }],
        skipped: [],
      };
    },
    osStore: (ctx) => {
      const home = factoryConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      return !exists(path.join(home, "auth.v2.file"))
        && (exists(path.join(home, "auth.v2.keyring")) || exists(path.join(home, "auth.v2.loginkeychain")));
    },
  },
  {
    provider: "kimi",
    carry: "carried",
    message: "ADE copies this computer's Kimi Code login (the file login, not one kept in the OS keyring).",
    locate: (ctx) => {
      const rel = kimiCredentialRel(ctx);
      if (!rel) return [];
      const home = kimiCodeConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      return [{
        id: "kimi/base",
        files: [
          file("kimiHome", home, rel),
          file("kimiHome", home, "device_id", { required: false }),
          file("kimiHome", home, "config.toml", { carry: false, required: false }),
        ],
      }];
    },
    parse: (bundle, contents) => {
      const tokenSpec = bundle.files[0]!;
      const data = json(contents, tokenSpec.rel);
      const access = str(data, "access_token");
      if (!data || !access) return { unreadable: true };
      const expiresAt = typeof data.expires_at === "number" && data.expires_at > 0 ? data.expires_at * 1000 : null;
      return {
        logins: [{
          slot: "base",
          class: "renewing",
          familySecret: str(data, "refresh_token") ?? access,
          account: null,
          expiresAt,
          files: carriedFiles(bundle, contents),
          parts: { kimiProvider: kimiProviderPart(text(contents, "config.toml")) },
        }],
        skipped: [],
      };
    },
    osStore: (ctx) => kimiCodeLoginInKeyring({ env: ctx.env, homeDir: ctx.homeDir }),
  },
  {
    provider: "qwen",
    carry: "carried",
    message: "ADE copies Qwen's key settings (settings.json and .env). For a Qwen OAuth sign-in, sign in on the cloud computer.",
    locate: (ctx) => {
      const home = qwenConfigHome({ env: ctx.env, homeDir: ctx.homeDir });
      return [{
        id: "qwen/base",
        files: [
          file("qwenHome", home, "settings.json", { required: false }),
          file("qwenHome", home, ".env", { required: false }),
        ],
      }];
    },
    parse: (bundle, contents) => {
      const settingsText = text(contents, "settings.json");
      const dotenv = text(contents, ".env");
      const settings = parseQwenUserSettings(settingsText ?? "");
      // Qwen OAuth (oauth_creds.json) is not tested: fallback.
      if (settings.selectedType === "qwen-oauth") return { logins: [], skipped: [{ slot: "base", state: "not_checked" }] };
      const hasKey = settings.authenticated || Boolean(dotenv?.trim());
      if (!hasKey) return { logins: [], skipped: [] };
      return {
        logins: [{
          slot: "base",
          class: "fixed",
          familySecret: `${settingsText ?? ""}\u0000${dotenv ?? ""}`,
          account: null,
          expiresAt: null,
          files: carriedFiles(bundle, contents),
        }],
        skipped: [],
      };
    },
  },
  {
    provider: "devin",
    carry: "carried",
    message: "ADE copies this computer's Devin login.",
    locate: (ctx) => {
      const credentials = devinCredentialFiles({ env: ctx.env, homeDir: ctx.homeDir, platform: ctx.platform });
      const found = credentials.find(exists) ?? credentials[0]!;
      return [{ id: "devin/base", files: [file("devinData", path.dirname(found), "credentials.toml")] }];
    },
    parse: (bundle, contents) => {
      const token = /^\s*windsurf_api_key\s*=\s*"([^"]+)"/m.exec(text(contents, "credentials.toml") ?? "")?.[1]?.trim();
      if (!token) return { unreadable: true };
      return {
        logins: [{ slot: "base", class: "fixed", familySecret: token, account: null, expiresAt: null, files: carriedFiles(bundle, contents) }],
        skipped: [],
      };
    },
  },
  {
    provider: "antigravity",
    carry: "carried",
    message: "ADE copies Antigravity's Google sign-in. On a Mac it is in the Keychain, and ADE reads it only when you allow it.",
    locate: (ctx) => {
      // macOS keeps it in the Keychain: never read in the background (the Allow action is P5 step 3).
      if (ctx.platform === "darwin") return [];
      const geminiHome = ctx.env.GEMINI_HOME?.trim() ? path.resolve(ctx.env.GEMINI_HOME.trim()) : path.join(ctx.homeDir, ".gemini");
      return (["personal", "business"] as const).map((slot) => ({
        id: `antigravity/${slot}`,
        files: [
          file("geminiHome", geminiHome, slot === "personal" ? "antigravity-acp/acp_token.json" : "antigravity-acp/acp_business_token.json"),
          file("geminiHome", geminiHome, "settings.json", { carry: false, required: false }),
        ],
      }));
    },
    parse: (bundle, contents) => {
      const slot = bundle.id.endsWith("business") ? "business" : "personal";
      const tokenSpec = bundle.files[0]!;
      const raw = text(contents, tokenSpec.rel);
      const data = json(contents, tokenSpec.rel);
      if (!raw || !data) return { unreadable: true };
      const settings = json(contents, "settings.json");
      const auth = isRecord(settings?.auth) ? settings.auth : null;
      const gcp = isRecord(settings?.gcp) ? settings.gcp : null;
      return {
        logins: [{
          slot,
          class: "fixed",
          familySecret: str(data, "refresh_token") ?? raw,
          account: null,
          expiresAt: null,
          files: carriedFiles(bundle, contents),
          parts: {
            antigravitySettings: {
              authType: slot === "personal" ? "oauth-personal" : "oauth-business",
              ...(str(auth, "type") ? { selected: str(auth, "type") } : {}),
              ...(str(gcp, "project") ? { gcpProject: str(gcp, "project") } : {}),
              ...(str(gcp, "location") ? { gcpLocation: str(gcp, "location") } : {}),
            },
          },
        }],
        skipped: [],
      };
    },
    osStore: (ctx) => ctx.platform === "darwin",
  },
  {
    provider: "muse",
    carry: "fallback",
    message: "Sign in to Muse on the cloud computer, or add a key. ADE does not copy Muse sign-ins.",
  },
];

export const PROVIDER_LOGIN_CARRY: ReadonlyArray<CarryRow> = ROWS;

export function carryRow(provider: ProviderLoginProvider): CarryRow {
  return ROWS.find((row) => row.provider === provider)!;
}
