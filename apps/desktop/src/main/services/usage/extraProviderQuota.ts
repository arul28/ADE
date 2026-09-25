/**
 * Live quota for Kimi, Cursor, Copilot, Grok, and OpenCode: credentials,
 * requests, and polling. The response parsers are in `providerQuotaParsers.ts`.
 *
 * The request shapes follow the public CodexBar provider notes. ADE does not
 * copy that app, does not import browser cookies, and does not log credentials.
 * A provider with no local credential returns `not_signed_in` before any
 * network call, so an unsigned install never becomes an error chip.
 */
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import type {
  UsageProvider,
  UsageProviderErrorKind,
  UsageWindow,
} from "../../../shared/types";
import { getApiKey } from "../ai/apiKeyStore";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { resolveKimiCodeLogin } from "../shared/kimiCodeLogin";
import { copilotConfigHome, grokConfigHome, openCodeDataDirs } from "../shared/providerConfigHomes";
import { asRecord, finiteNumberOrNull, sha256Hex, toOptionalString } from "../shared/utils";
import {
  parseCopilotIdentity,
  parseCopilotQuota,
  parseCursorUsageSummary,
  parseFactorySessionCredits,
  parseGrokCredits,
  parseKimiIdentity,
  parseKimiUsage,
  parseOpenCodeConsoleGoStatus,
  parseOpenCodeGoUsage,
  stringField,
} from "./providerQuotaParsers";
import type { UsageProviderPollContext, UsageProviderPollResult } from "./usageProviderStrategies";

const HTTP_TIMEOUT_MS = 4_000;
const GH_TOKEN_TTL_MS = 15 * 60_000;

const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const COPILOT_USER_URL = "https://api.github.com/user";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_CONSOLE_GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
const FACTORY_SESSIONS_URL = "https://api.factory.ai/api/v0/sessions";

type QuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The OpenCode CLI's own console login, kept in `opencode.db`: the session
 * token that reads the Go subscription meters, the workspace it is scoped to,
 * and the account email for display.
 */
export type OpenCodeConsoleAccount = {
  accessToken: string;
  orgId: string | null;
  email: string | null;
};

export type ExtraQuotaIo = {
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: QuotaFetch;
  readText?: (filePath: string) => Promise<string | null>;
  readCursorSession?: (dbPath: string) => Promise<{ token: string | null; unreadable: boolean }>;
  readGhToken?: (force: boolean) => Promise<string | null>;
  readFactoryApiKey?: () => string | null;
  readOpenCodeConsoleAccount?: (dbPath: string, nowMs: number) => Promise<OpenCodeConsoleAccount | null>;
};

type ResolvedIo = {
  nowMs: number;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  fetchImpl: QuotaFetch;
  readText: (filePath: string) => Promise<string | null>;
  readCursorSession: (dbPath: string) => Promise<{ token: string | null; unreadable: boolean }>;
  readGhToken: (force: boolean) => Promise<string | null>;
  readFactoryApiKey: () => string | null;
  readOpenCodeConsoleAccount: (dbPath: string, nowMs: number) => Promise<OpenCodeConsoleAccount | null>;
};

function resolveIo(io: ExtraQuotaIo = {}): ResolvedIo {
  return {
    nowMs: io.nowMs ?? Date.now(),
    env: io.env ?? process.env,
    homeDir: io.homeDir ?? homedir(),
    platform: io.platform ?? process.platform,
    fetchImpl: io.fetchImpl ?? ((input, init) => fetch(input, init)),
    readText: io.readText ?? readTextFile,
    readCursorSession: io.readCursorSession ?? readCursorSessionToken,
    readGhToken: io.readGhToken ?? readCachedGhAuthToken,
    readFactoryApiKey: io.readFactoryApiKey ?? readStoredFactoryApiKey,
    readOpenCodeConsoleAccount: io.readOpenCodeConsoleAccount ?? readOpenCodeConsoleAccountFromDisk,
  };
}

function notSignedIn(): UsageProviderPollResult {
  return { disposition: "not_signed_in", windows: [], errors: [] };
}

type IdentityProvider = "kimi" | "copilot";
type QuotaIdentity = { email: string | null };

/**
 * The last identity each provider's identity call returned, and a fingerprint
 * of the credential it was read with. The account id is `<provider>:<email>`
 * only while that call answers; one failed call used to stamp the windows
 * `<provider>:local`, a different account to the burn-rate history, which then
 * restarted its samples and lost the turn join for its whole retention window.
 *
 * The remembered email is reused only for the same credential. A different
 * credential may be a different account, and stamping it with the old email
 * would file one account's quota under another. Kimi rotates its access token
 * on refresh, so a refresh that lands on a failed `/me` reads as unknown for
 * that one poll — never as the wrong account. The fingerprint is a truncated
 * SHA-256, in memory only, never logged, and forgotten on sign-out.
 */
const lastQuotaIdentity = new Map<IdentityProvider, { fingerprint: string; identity: QuotaIdentity }>();

function signedOut(provider: IdentityProvider): UsageProviderPollResult {
  lastQuotaIdentity.delete(provider);
  return notSignedIn();
}

async function quotaIdentity(
  provider: IdentityProvider,
  credential: string,
  request: Promise<HttpJson>,
  parse: (body: unknown) => QuotaIdentity,
): Promise<QuotaIdentity> {
  const fingerprint = sha256Hex(credential).slice(0, 16);
  const response = await request;
  if (!response.ok) {
    const remembered = lastQuotaIdentity.get(provider);
    return remembered?.fingerprint === fingerprint ? remembered.identity : { email: null };
  }
  const identity = { email: parse(response.body).email };
  lastQuotaIdentity.set(provider, { fingerprint, identity });
  return identity;
}

/** Test seam: forget every remembered identity. */
export function resetQuotaIdentityCacheForTests(): void {
  lastQuotaIdentity.clear();
}

function expiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string" || !value.trim()) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1e9) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function appDataDir(io: ResolvedIo): string {
  const configured = io.env.APPDATA?.trim();
  return configured && configured.length > 0
    ? configured
    : path.join(io.homeDir, "AppData", "Roaming");
}

function xdgConfigDir(io: ResolvedIo): string {
  const configured = io.env.XDG_CONFIG_HOME?.trim();
  return configured && configured.length > 0 ? configured : path.join(io.homeDir, ".config");
}

export function cursorStateDbPath(io: Pick<ResolvedIo, "homeDir" | "platform" | "env">): string {
  if (io.platform === "darwin") {
    return path.join(io.homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (io.platform === "win32") {
    return path.join(appDataDir(io as ResolvedIo), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(xdgConfigDir(io as ResolvedIo), "Cursor", "User", "globalStorage", "state.vscdb");
}

export function copilotHostsPath(io: Pick<ResolvedIo, "homeDir" | "platform" | "env">): string {
  if (io.platform === "win32") return path.join(appDataDir(io as ResolvedIo), "github-copilot", "hosts.json");
  return path.join(xdgConfigDir(io as ResolvedIo), "github-copilot", "hosts.json");
}

/** OpenCode's `auth.json` candidates, in the lookup order every OpenCode reader shares. */
export function openCodeAuthPaths(io: Pick<ResolvedIo, "homeDir" | "platform" | "env">): string[] {
  return openCodeDataDirs({ env: io.env, homeDir: io.homeDir, platform: io.platform })
    .map((dir) => path.join(dir, "auth.json"));
}

/** OpenCode's `opencode.db` candidates, the store its console account lives in. */
export function openCodeConsoleDbPaths(io: Pick<ResolvedIo, "homeDir" | "platform" | "env">): string[] {
  return openCodeDataDirs({ env: io.env, homeDir: io.homeDir, platform: io.platform })
    .map((dir) => path.join(dir, "opencode.db"));
}

function sqliteText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.replace(/\0/g, "").trim();
    return text.length > 0 ? text : null;
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString("utf8").replace(/\0/g, "").trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function jwtPayload(token: string): { exp?: unknown; sub?: unknown } | null {
  const jwt = token.includes("::") ? token.slice(token.lastIndexOf("::") + 2) : token;
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown; sub?: unknown };
  } catch {
    return null;
  }
}

function jwtExpiryMs(token: string): number | null {
  const exp = finiteNumberOrNull(jwtPayload(token)?.exp);
  return exp == null ? null : exp * 1000;
}

/**
 * `cursor.com` rejects the bare access token as `WorkosCursorSessionToken`.
 * The cookie value is `userId::accessToken`. The user id is the JWT `sub`
 * after the last `|` (`github|12345678` → `12345678`). A token that already
 * contains `::` is already in that shape.
 */
export function cursorSessionCookie(token: string): string {
  const trimmed = token.trim();
  if (!trimmed || trimmed.includes("::")) return trimmed;
  const sub = jwtPayload(trimmed)?.sub;
  if (typeof sub !== "string" || !sub.trim()) return trimmed;
  const userId = sub.includes("|") ? sub.slice(sub.lastIndexOf("|") + 1) : sub.trim();
  if (!userId || userId.includes(".")) return trimmed;
  return `${userId}::${trimmed}`;
}

export function usableSessionToken(token: string | null, nowMs: number): string | null {
  if (!token) return null;
  const exp = jwtExpiryMs(token);
  if (exp != null && exp <= nowMs + 60_000) return null;
  return token;
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readCursorSessionToken(dbPath: string): Promise<{ token: string | null; unreadable: boolean }> {
  try {
    await access(dbPath);
  } catch {
    return { token: null, unreadable: false };
  }
  let db: DatabaseSync | null = null;
  try {
    // Loads `node:sqlite` only now, when a Cursor session file is actually there.
    db = openReadOnlyDatabase(dbPath);
    const row = db.prepare("select value from ItemTable where key = ?").get("cursorAuth/accessToken") as { value?: unknown } | undefined;
    return { token: sqliteText(row?.value ?? null), unreadable: false };
  } catch {
    return { token: null, unreadable: true };
  } finally {
    db?.close();
  }
}

/**
 * The OpenCode CLI's console account, read from the `account` table of its
 * `opencode.db`.
 *
 * `auth.json` holds provider credentials (an Anthropic or OpenAI OAuth login),
 * never the OpenCode subscription itself. The Go plan is the console session:
 * `account.access_token` + `account_state.active_org_id` are what OpenCode sends
 * to `opencode.ai/console/api/go/status`. A token past its own `token_expiry` is
 * skipped rather than refreshed — ADE does not own the login, and OpenCode will
 * refresh it on its next run. Only the three fields the request and display need
 * are read; the token is never logged. An `opencode.db` that is missing,
 * locked, or shaped differently reads as no account (never an error).
 */
export async function readOpenCodeConsoleAccountFromDisk(
  dbPath: string,
  nowMs: number,
): Promise<OpenCodeConsoleAccount | null> {
  try {
    await access(dbPath);
  } catch {
    return null;
  }
  let db: DatabaseSync | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    // A running OpenCode may hold the write lock; answer at once rather than wait.
    db.exec("PRAGMA busy_timeout = 0");
    const account = db.prepare(`
      SELECT access_token AS accessToken, token_expiry AS tokenExpiry, email AS email
        FROM account
       ORDER BY time_updated DESC
       LIMIT 1
    `).get() as { accessToken?: unknown; tokenExpiry?: unknown; email?: unknown } | undefined;
    const accessToken = sqliteText(account?.accessToken ?? null);
    if (!accessToken) return null;
    const expiry = finiteNumberOrNull(account?.tokenExpiry);
    if (expiry != null && expiry <= nowMs + 60_000) return null;
    const state = db.prepare("SELECT active_org_id AS orgId FROM account_state LIMIT 1")
      .get() as { orgId?: unknown } | undefined;
    return {
      accessToken,
      orgId: sqliteText(state?.orgId ?? null),
      email: sqliteText(account?.email ?? null),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

function rejectedGrokToken(token: string): boolean {
  if (token.startsWith("xai-")) return true;
  if (/^cookie\s*:/i.test(token)) return true;
  if (token.includes("=") && !token.includes(".")) return true;
  return false;
}

export function readGrokBearer(auth: unknown, nowMs: number, envToken?: string | null): {
  token: string;
  email: string | null;
} | null {
  const root = asRecord(auth);
  const entries: Array<Record<string, unknown>> = [];
  if (root) {
    if (typeof root.key === "string") entries.push(root);
    const ranked = Object.entries(root)
      .filter(([, value]) => asRecord(value)?.key)
      .sort(([left], [right]) => Number(right.includes("auth.x.ai")) - Number(left.includes("auth.x.ai")));
    for (const [, value] of ranked) {
      const entry = asRecord(value);
      if (entry) entries.push(entry);
    }
  }
  for (const entry of entries) {
    const token = stringField(entry, "key");
    if (!token || rejectedGrokToken(token)) continue;
    const expires = expiryMs(entry.expires_at ?? entry.expiresAt);
    if (expires != null && expires <= nowMs + 60_000) continue;
    return { token, email: stringField(entry, "email") };
  }
  const pasted = envToken?.trim() ?? "";
  if (!pasted || rejectedGrokToken(pasted)) return null;
  return { token: pasted, email: null };
}

export function readCopilotTokenFromHosts(raw: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    for (const value of Object.values(parsed)) {
      const token = stringField(asRecord(value), "oauth_token", "oauthToken");
      if (token) return token;
    }
    return null;
  } catch {
    return null;
  }
}

export function readOpenCodeApiKey(auth: unknown): string | null {
  const root = asRecord(auth);
  if (!root) return null;
  for (const [id, value] of Object.entries(root)) {
    const name = id.toLowerCase();
    if (!name.includes("opencode") && !name.includes("zen") && name !== "go") continue;
    const key = stringField(asRecord(value), "key");
    if (key) return key;
  }
  return null;
}

export function readKimiAccessToken(auth: unknown, nowMs: number): string | null {
  const root = asRecord(auth);
  const credentials = asRecord(root?.tokens) ?? root;
  if (!credentials) return null;
  const token = stringField(credentials, "access_token");
  if (!token) return null;
  const expires = expiryMs(credentials.expires_at ?? credentials.expiresAt);
  if (expires != null && expires <= nowMs + 60_000) return null;
  return token;
}

function readStoredFactoryApiKey(): string | null {
  try {
    return getApiKey("droid")?.trim() || null;
  } catch {
    return null;
  }
}

function factoryApiKey(io: ResolvedIo): string | null {
  const key = io.readFactoryApiKey()?.trim() || envToken(io.env, "FACTORY_API_KEY");
  return key?.startsWith("fk-") ? key : null;
}

type HttpJson =
  | { ok: true; body: unknown }
  | { ok: false; errorKind: UsageProviderErrorKind; detail: string };

async function fetchJson(
  fetchImpl: QuotaFetch,
  url: string,
  headers: Record<string, string>,
): Promise<HttpJson> {
  try {
    const response = await fetchImpl(url, {
      headers,
      credentials: "omit",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, errorKind: "auth", detail: String(response.status) };
    }
    if (response.status === 429) return { ok: false, errorKind: "rate_limited", detail: "429" };
    if (!response.ok) return { ok: false, errorKind: "unavailable", detail: String(response.status) };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, errorKind: "invalid_response", detail: "unreadable" };
    }
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { ok: false, errorKind: timeout ? "timeout" : "network", detail: timeout ? "timeout" : "network" };
  }
}

function httpFailure(provider: UsageProvider, failure: Extract<HttpJson, { ok: false }>): UsageProviderPollResult {
  const detail = failure.detail === "network" || failure.detail === "timeout" || failure.detail === "unreadable"
    ? failure.detail
    : failure.detail;
  return {
    windows: [],
    errors: [`${provider}: usage request failed (${detail})`],
    errorKind: failure.errorKind,
    source: "http",
  };
}

function freshResult(
  provider: UsageProvider,
  windows: UsageWindow[],
  facts: { email?: string | null; plan?: string | null },
  emptyDetail: string,
): UsageProviderPollResult {
  if (windows.length === 0) {
    return {
      windows: [],
      errors: [`${provider}: ${emptyDetail}`],
      errorKind: "invalid_response",
      source: "http",
    };
  }
  return {
    windows,
    errors: [],
    source: "http",
    ...(facts.email ? { accountEmail: facts.email } : {}),
    ...(facts.plan ? { accountPlan: facts.plan } : {}),
  };
}

export async function pollCursorQuota(
  context: UsageProviderPollContext = { reason: "automatic" },
  io: ExtraQuotaIo = {},
): Promise<UsageProviderPollResult> {
  const resolved = resolveIo(io);
  const dbPath = cursorStateDbPath(resolved);
  let session: { token: string | null; unreadable: boolean };
  try {
    session = await resolved.readCursorSession(dbPath);
  } catch {
    session = { token: null, unreadable: true };
  }
  const token = usableSessionToken(session.token, resolved.nowMs);
  if (!token) {
    if (!session.unreadable) return notSignedIn();
    const hadWindows = context.previousSnapshot?.windows.some((window) => window.provider === "cursor") ?? false;
    if (!hadWindows) return notSignedIn();
    return {
      windows: [],
      errors: ["cursor: local session unreadable"],
      errorKind: "unavailable",
      source: "http",
    };
  }
  const response = await fetchJson(resolved.fetchImpl, CURSOR_USAGE_URL, {
    Accept: "application/json",
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(cursorSessionCookie(token))}`,
  });
  if (!response.ok) return httpFailure("cursor", response);
  const parsed = parseCursorUsageSummary(response.body, resolved.nowMs);
  return freshResult("cursor", parsed.windows, { email: parsed.email, plan: parsed.plan }, "usage response had no plan percentage");
}

function envToken(env: NodeJS.ProcessEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = toOptionalString(env[name]);
    if (value) return value;
  }
  return null;
}

export async function pollKimiQuota(
  _context: UsageProviderPollContext = { reason: "automatic" },
  io: ExtraQuotaIo = {},
): Promise<UsageProviderPollResult> {
  const resolved = resolveIo(io);
  // The slot and API base Kimi Code itself would use: `config.toml`'s managed
  // login first (a `--region global` login lives in its own scoped file), then
  // the default `kimi-code.json` with the region marker.
  const login = resolveKimiCodeLogin({ env: resolved.env, homeDir: resolved.homeDir });
  const raw = login ? await resolved.readText(login.credentialPath) : null;
  let auth: unknown = null;
  if (raw) {
    try {
      auth = JSON.parse(raw);
    } catch {
      auth = null;
    }
  }
  const token = readKimiAccessToken(auth, resolved.nowMs);
  if (!login || !token) return signedOut("kimi");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const response = await fetchJson(resolved.fetchImpl, `${login.baseUrl}/usages`, headers);
  if (!response.ok) return httpFailure("kimi", response);
  const identity = await quotaIdentity(
    "kimi",
    token,
    fetchJson(resolved.fetchImpl, `${login.baseUrl}/me`, headers),
    parseKimiIdentity,
  );
  const windows = parseKimiUsage(response.body, resolved.nowMs, identity.email);
  return freshResult("kimi", windows, { email: identity.email }, "usage response had no recognized windows");
}

export async function pollCopilotQuota(
  context: UsageProviderPollContext = { reason: "automatic" },
  io: ExtraQuotaIo = {},
): Promise<UsageProviderPollResult> {
  const resolved = resolveIo(io);
  let token = envToken(resolved.env, "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN");
  if (!token) {
    const hosts = await resolved.readText(copilotHostsPath(resolved));
    token = hosts ? readCopilotTokenFromHosts(hosts) : null;
  }
  if (!token) {
    const copilotHome = copilotConfigHome({ env: resolved.env, homeDir: resolved.homeDir });
    const ghHosts = path.join(xdgConfigDir(resolved), "gh", "hosts.yml");
    const [copilotConfig, ghConfig] = await Promise.all([
      resolved.readText(path.join(copilotHome, "config.json")),
      resolved.readText(ghHosts),
    ]);
    if (copilotConfig == null && ghConfig == null) return signedOut("copilot");
    token = await resolved.readGhToken(context.reason === "user");
  }
  if (!token) return signedOut("copilot");
  const response = await fetchJson(resolved.fetchImpl, COPILOT_USAGE_URL, {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "Editor-Version": "vscode/1.96.2",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-Github-Api-Version": "2025-04-01",
  });
  if (!response.ok) return httpFailure("copilot", response);
  const identity = await quotaIdentity(
    "copilot",
    token,
    fetchJson(resolved.fetchImpl, COPILOT_USER_URL, {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "X-Github-Api-Version": "2025-04-01",
    }),
    parseCopilotIdentity,
  );
  const parsed = parseCopilotQuota(response.body, resolved.nowMs, identity.email);
  return freshResult("copilot", parsed.windows, { email: identity.email, plan: parsed.plan }, "usage response had no premium quota");
}

export async function pollGrokQuota(
  _context: UsageProviderPollContext = { reason: "automatic" },
  io: ExtraQuotaIo = {},
): Promise<UsageProviderPollResult> {
  const resolved = resolveIo(io);
  const authPath = path.join(grokConfigHome({ env: resolved.env, homeDir: resolved.homeDir }), "auth.json");
  const raw = await resolved.readText(authPath);
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const bearer = readGrokBearer(parsed, resolved.nowMs, resolved.env.GROK_OAUTH_TOKEN);
  if (!bearer) return notSignedIn();
  const response = await fetchJson(resolved.fetchImpl, GROK_BILLING_URL, {
    Authorization: `Bearer ${bearer.token}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
  });
  if (!response.ok) return httpFailure("grok", response);
  const credits = parseGrokCredits(response.body, resolved.nowMs, bearer.email);
  return freshResult("grok", credits.windows, { email: bearer.email, plan: credits.plan }, "billing response had no usage percent");
}

export async function pollOpenCodeQuota(
  _context: UsageProviderPollContext = { reason: "automatic" },
  io: ExtraQuotaIo = {},
): Promise<UsageProviderPollResult> {
  const resolved = resolveIo(io);
  let key = envToken(resolved.env, "OPENCODE_API_KEY");
  if (!key) {
    for (const authPath of openCodeAuthPaths(resolved)) {
      const raw = await resolved.readText(authPath);
      if (!raw) continue;
      try {
        key = readOpenCodeApiKey(JSON.parse(raw));
      } catch {
        key = null;
      }
      if (key) break;
    }
  }
  if (key) {
    const response = await fetchJson(resolved.fetchImpl, OPENCODE_USAGE_URL, {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    });
    if (!response.ok) return httpFailure("opencode", response);
    return freshResult("opencode", parseOpenCodeGoUsage(response.body, resolved.nowMs), {}, "usage response had no windows");
  }
  // No API key. The Go plan rides on the OpenCode CLI's own console login, so
  // read that account out of `opencode.db` and use the console meters.
  for (const dbPath of openCodeConsoleDbPaths(resolved)) {
    const account = await resolved.readOpenCodeConsoleAccount(dbPath, resolved.nowMs);
    if (!account) continue;
    const response = await fetchJson(resolved.fetchImpl, OPENCODE_CONSOLE_GO_STATUS_URL, {
      Authorization: `Bearer ${account.accessToken}`,
      Accept: "application/json",
      ...(account.orgId ? { "x-org-id": account.orgId } : {}),
    });
    if (!response.ok) return httpFailure("opencode", response);
    const windows = parseOpenCodeConsoleGoStatus(response.body, resolved.nowMs, account.email);
    // A console account without a Go plan answers `access: null`: a signed-in
    // machine that simply has no subscription, so no row rather than an error.
    if (windows.length === 0 && !asRecord(asRecord(response.body)?.access)) return notSignedIn();
    return freshResult("opencode", windows, { email: account.email }, "usage response had no windows");
  }
  return notSignedIn();
}

/** Returns one completed Droid session's provider-recorded Factory credits. */
export async function fetchFactorySessionCredits(
  sessionId: string,
  io: ExtraQuotaIo = {},
): Promise<number | null> {
  const resolved = resolveIo(io);
  const key = factoryApiKey(resolved);
  const id = sessionId.trim();
  if (!key || !id) return null;
  const response = await fetchJson(
    resolved.fetchImpl,
    `${FACTORY_SESSIONS_URL}/${encodeURIComponent(id)}`,
    {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  );
  return response.ok ? parseFactorySessionCredits(response.body) : null;
}

let ghTokenCache: { at: number; token: string | null } | null = null;

async function readCachedGhAuthToken(force: boolean): Promise<string | null> {
  const now = Date.now();
  if (!force && ghTokenCache && now - ghTokenCache.at < GH_TOKEN_TTL_MS) return ghTokenCache.token;
  const token = await spawnGhAuthToken();
  ghTokenCache = { at: now, token };
  return token;
}

function spawnGhAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      resolve(token);
    };
    const child = spawn("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 2_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const token = Buffer.concat(chunks).toString("utf8").trim();
      finish(token.length > 0 ? token : null);
    });
  });
}
