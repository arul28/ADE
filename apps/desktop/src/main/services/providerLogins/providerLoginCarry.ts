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
 *   says that one exists, for `status`. It is read only when the person
 *   allows it (Antigravity's Allow, `providerLoginAllow.ts`), never in a pass.
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
import { isClassicGitHubToken, readGhHostsGithubCom } from "./providerLoginGhCli";
import { parseQwenUserSettings } from "../ai/qwenUserSettings";
import { ANTIGRAVITY_TOKEN_FILE, peekAntigravityKeyringPresent } from "../ai/antigravityAuth";
import { isRecord } from "../shared/utils";

/**
 * Copilot's carried sign-in is this computer's GitHub CLI login for
 * github.com (P5 G1), and only after the person allows it on this computer
 * (the sync skips the row until then). `hosts.yml` is the marker and gives the
 * user; the token comes from the file (gh's plain-text storage) or from the
 * sync's one `gh auth token` read, which it passes in under `GH_TOKEN_PART`.
 * A failed read comes in under `GH_READ_PART`.
 */
export const GH_BUNDLE_ID = "copilot/gh";
export const GH_TOKEN_PART = "\u0000gh:token";
export const GH_READ_PART = "\u0000gh:read";

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
  | "antigravityHome"
  | "piAgent";

export type CarryContext = {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  /** True on an ADE Cloud computer (`isAdeCloudComputer()`). */
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

/**
 * Antigravity's `settings.json`, read leniently: comments and trailing commas
 * out, then JSON, so ADE can still take out fields it wrote. agy itself reads
 * strict JSON and ignores a file with a comment (`antigravityAuth.ts`).
 * Anything still unreadable is null.
 */
export function parseAntigravitySettings(raw: string): Record<string, unknown> | null {
  try {
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
    const parsed = JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The agy CLI's own folder under `<home>/.gemini` (the `antigravityHome`
 * root): its settings (read, never written) and, when it uses its file
 * store, the Google sign-in.
 * Not Gemini CLI's `<GEMINI_HOME>/settings.json`; agy ignores GEMINI_HOME.
 */
export const ANTIGRAVITY_SETTINGS_REL = "antigravity-cli/settings.json";
export const ANTIGRAVITY_TOKEN_REL = `antigravity-cli/${ANTIGRAVITY_TOKEN_FILE}`;

/**
 * agy's stored sign-in (verified, 1.5.6 on Windows): `{ token: { access_token,
 * refresh_token, expiry, … }, auth_method, id_token_email }`, the same JSON in
 * the keyring item and in the file store. `auth_method` is `consumer` for a
 * Google account; anything naming a business or enterprise login is the
 * Gemini Enterprise slot. agy keeps one item for both, so this picks the slot.
 */
export function antigravitySlotFromLogin(login: Record<string, unknown> | null): "personal" | "business" {
  const method = typeof login?.auth_method === "string" ? login.auth_method.toLowerCase() : "";
  return /business|enterprise/.test(method) ? "business" : "personal";
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
function carriedFile(spec: CarryFileSpec, buffer: Buffer): CarriedFile {
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
    carry: "carried",
    message: "ADE copies this computer's GitHub CLI login for Copilot only when you turn it on here. The login also gives access to your GitHub repos. "
      + "A Copilot sign-in made with `copilot login` is not copied.",
    locate: (ctx) => [copilotGhBundle(ctx)],
    parse: (_bundle, contents) => {
      const host = readGhHostsGithubCom(text(contents, "hosts.yml"));
      // No github.com login (another host's only, or none): not signed in here.
      if (!host.user && !host.token) return { logins: [], skipped: [{ slot: "gh", state: "not_signed_in" }] };
      const token = host.token ?? text(contents, GH_TOKEN_PART)?.trim() ?? null;
      if (!token) {
        const reason = text(contents, GH_READ_PART);
        if (reason === "no_token") return { logins: [], skipped: [{ slot: "gh", state: "not_signed_in" }] };
        // The last read gave a classic token and the file has not changed since: still not carried.
        if (reason === "classic_token") return { logins: [], skipped: [{ slot: "gh", state: "not_checked" }] };
        // gh is missing, timed out or failed: the login may still be there, so nothing leaves the account.
        return { unreadable: true };
      }
      // A classic token: Copilot refuses it, so it is never carried (the status says why).
      if (isClassicGitHubToken(token)) return { logins: [], skipped: [{ slot: "gh", state: "not_checked" }] };
      return {
        logins: [{
          slot: "gh",
          class: "fixed",
          familySecret: token,
          account: host.user ? { email: null, id: host.user } : null,
          expiresAt: null,
          files: [],
          parts: { githubToken: token },
        }],
        skipped: [],
      };
    },
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
    message: "ADE copies Antigravity's Google sign-in. When the agy CLI keeps it in this computer's OS keyring "
      + "(the Keychain, Credential Manager or the keyring), ADE reads it only when you allow it.",
    locate: (ctx) => {
      // The file store (no working keyring, WSL, a container, every cloud
      // computer) is read in the background like any login file.
      const bundle = antigravityBundle(ctx);
      if (ctx.cloudComputer || exists(bundle.files[0]!.abs)) return [bundle];
      // No file: the sign-in may be in the OS keyring, read only on the
      // person's Allow (`provider_logins.allowKeychain`). Not looked at, so an
      // allowed copy is not "gone from this computer". Only a keyring known
      // to be empty makes the missing file "not signed in".
      return peekAntigravityKeyringPresent() === false ? [bundle] : [];
    },
    parse: (bundle, contents) => {
      const tokenSpec = bundle.files[0]!;
      const raw = text(contents, tokenSpec.rel);
      const data = json(contents, tokenSpec.rel);
      if (!raw || !data) return { unreadable: true };
      const token = isRecord(data.token) ? data.token : null;
      // A damaged item (no token agy could use) must not replace a working copy.
      if (!str(token, "refresh_token") && !str(token, "access_token")) return { unreadable: true };
      // The Allow names its slot in the bundle id; otherwise the login says.
      const slot = bundle.id.endsWith("/business") ? "business"
        : bundle.id.endsWith("/personal") ? "personal"
          : antigravitySlotFromLogin(data);
      // agy on Windows records the address; on macOS (1.4.7) only the ID token carries it.
      const email = str(data, "id_token_email") ?? str(jwtClaims(str(data, "id_token")), "email");
      return {
        logins: [{
          slot,
          class: "fixed",
          familySecret: str(token, "refresh_token") ?? raw,
          account: email ? { email, id: null } : null,
          expiresAt: null,
          files: carriedFiles(bundle, contents),
        }],
        skipped: [],
      };
    },
    // A keyring item, known from the cached presence check (no secret read, no process here).
    osStore: (ctx) => !ctx.cloudComputer && peekAntigravityKeyringPresent() === true,
  },
  {
    provider: "muse",
    carry: "fallback",
    message: "Sign in to Muse on the cloud computer, or add a key. ADE does not copy Muse sign-ins.",
  },
];

export const PROVIDER_LOGIN_CARRY: ReadonlyArray<CarryRow> = ROWS;

/**
 * Antigravity's bundle: the agy CLI's token file. agy keeps one sign-in for
 * both Google methods. Without a slot it is the background bundle (the login
 * names its slot); the Allow names its slot and fills the token file's part
 * from the OS keyring item instead of the file.
 */
export function antigravityBundle(ctx: CarryContext, slot?: "personal" | "business"): CarryBundle {
  const home = carryRootDir("antigravityHome", ctx)!;
  return {
    id: `antigravity/${slot ?? "google"}`,
    files: [
      file("antigravityHome", home, ANTIGRAVITY_TOKEN_REL),
    ],
  };
}

/**
 * Copilot's GitHub CLI login (G1): the file gh reads, or where it would be.
 * A logout that deletes it is "not signed in", so the item leaves.
 */
export function copilotGhBundle(ctx: CarryContext): CarryBundle {
  const candidates = ghHostsFiles({ env: ctx.env, homeDir: ctx.homeDir, platform: ctx.platform });
  const hosts = candidates.find(exists) ?? candidates[0]!;
  return { id: GH_BUNDLE_ID, files: [file("ghConfig", path.dirname(hosts), "hosts.yml", { carry: false })] };
}

/** The path of gh's `hosts.yml` on this computer (present or not). */
export function copilotGhHostsPath(ctx: CarryContext): string {
  return copilotGhBundle(ctx).files[0]!.abs;
}

export function carryRow(provider: ProviderLoginProvider): CarryRow {
  return ROWS.find((row) => row.provider === provider)!;
}

// ── apply: where a carried file goes on this computer (P5 step 2) ─────

/**
 * The folder a root token names on this computer, with the same locator
 * capture uses, or null for a root no carried row writes.
 */
export function carryRootDir(root: CarryRoot, ctx: CarryContext): string | null {
  const args = { env: ctx.env, homeDir: ctx.homeDir };
  switch (root) {
    case "codexHome": return codexConfigHome(args);
    case "grokHome": return grokConfigHome(args);
    case "kimiHome": return kimiCodeConfigHome(args);
    case "factoryHome": return factoryConfigHome(args);
    case "qwenHome": return qwenConfigHome(args);
    case "piAgent": return piAgentDir(args);
    case "cursorSdk": return path.join(ctx.homeDir, ".cursor", "sdk");
    // agy keeps its folder under `<home>/.gemini` whatever GEMINI_HOME says.
    case "antigravityHome": return path.join(ctx.homeDir, ".gemini");
    case "devinData": {
      const credentials = devinCredentialFiles({ env: ctx.env, homeDir: ctx.homeDir, platform: ctx.platform });
      return path.dirname(credentials.find(exists) ?? credentials[0]!);
    }
    default: return null;
  }
}

/**
 * The only files apply may write for each provider: root and relative path.
 * A vault item comes from any computer of the account, so a name outside this
 * list (a `..`, an absolute path, another provider's folder) is refused.
 */
const APPLY_FILES: Partial<Record<ProviderLoginProvider, { root: CarryRoot; rel: RegExp }[]>> = {
  codex: [{ root: "codexHome", rel: /^auth\.json$/ }],
  cursor: [{ root: "cursorSdk", rel: /^auth\.json$/ }],
  grok: [{ root: "grokHome", rel: /^auth\.json$/ }],
  droid: [{ root: "factoryHome", rel: /^auth\.v2\.(file|key)$/ }],
  kimi: [{ root: "kimiHome", rel: /^credentials\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/ }, { root: "kimiHome", rel: /^device_id$/ }],
  qwen: [{ root: "qwenHome", rel: /^settings\.json$/ }, { root: "qwenHome", rel: /^\.env$/ }],
  devin: [{ root: "devinData", rel: /^credentials\.toml$/ }],
  antigravity: [{ root: "antigravityHome", rel: /^antigravity-cli\/antigravity-oauth-token$/ }],
};

export function isApplyFileAllowed(provider: ProviderLoginProvider, root: string, rel: string): boolean {
  return (APPLY_FILES[provider] ?? []).some((entry) => entry.root === root && entry.rel.test(rel));
}

/**
 * What a cloud computer that does not renew a sign-in writes: the login with
 * its refresh token taken out, so the CLI there can never renew it and split
 * the family. `renewalSafe: false` means no refresh field could be found (a
 * full copy is written; the status says renewal safety is unknown).
 */
export function accessOnlyFile(provider: ProviderLoginProvider, rel: string, data: Buffer): { data: Buffer; renewalSafe: boolean } {
  const asJson = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(data.toString("utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (provider === "codex" && rel === "auth.json") {
    const parsed = asJson();
    const tokens = parsed && isRecord(parsed.tokens) ? parsed.tokens : null;
    // Keep the field, empty, so the file still reads as a ChatGPT login.
    if (!parsed || !tokens || typeof tokens.refresh_token !== "string") return { data, renewalSafe: true };
    return { data: encode({ ...parsed, tokens: { ...tokens, refresh_token: "" } }), renewalSafe: true };
  }
  if (provider === "kimi" && rel.startsWith("credentials/")) {
    const parsed = asJson();
    if (!parsed || !("refresh_token" in parsed)) return { data, renewalSafe: true };
    const { refresh_token: _refresh, ...rest } = parsed;
    return { data: encode(rest), renewalSafe: true };
  }
  if (provider === "grok" && rel === "auth.json") {
    const parsed = asJson();
    if (!parsed) return { data, renewalSafe: false };
    let removed = false;
    const next: Record<string, unknown> = {};
    for (const [issuer, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        next[issuer] = value;
        continue;
      }
      const entry: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(value)) {
        if (/refresh/i.test(name)) removed = true;
        else entry[name] = field;
      }
      next[issuer] = entry;
    }
    return removed ? { data: encode(next), renewalSafe: true } : { data, renewalSafe: false };
  }
  // Droid's file is encrypted: it cannot be cut, so it goes whole.
  if (provider === "droid") return { data, renewalSafe: false };
  return { data, renewalSafe: true };
}

/** Pi's entry without its refresh token, for the same reason as `accessOnlyFile`. */
export function accessOnlyPiEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.type !== "oauth" || !("refresh" in entry)) return entry;
  const { refresh: _refresh, ...rest } = entry;
  return rest;
}
