/**
 * Live quota for Cursor, Copilot, Grok, and OpenCode.
 *
 * The request shapes follow the public CodexBar provider notes. ADE does not
 * copy that app, does not import browser cookies, and does not log credentials.
 * A provider with no local credential returns `not_signed_in` before any
 * network call, so an unsigned install never becomes an error chip.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import type {
  UsageProvider,
  UsageProviderErrorKind,
  UsageWindow,
  UsageWindowType,
} from "../../../shared/types";
import { grokConfigHome } from "../shared/providerConfigHomes";
import type { UsageProviderPollContext, UsageProviderPollResult } from "./usageProviderStrategies";

const HTTP_TIMEOUT_MS = 4_000;
const GH_TOKEN_TTL_MS = 15 * 60_000;

const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

type QuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ExtraQuotaIo = {
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: QuotaFetch;
  readText?: (filePath: string) => Promise<string | null>;
  readCursorSession?: (dbPath: string) => Promise<{ token: string | null; unreadable: boolean }>;
  readGhToken?: (force: boolean) => Promise<string | null>;
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
  };
}

function notSignedIn(): UsageProviderPollResult {
  return { disposition: "not_signed_in", windows: [], errors: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Whole-number percents. 1 means 1%, never 100%. */
export function wholePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function ratioPercent(used: unknown, limit: unknown): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return wholePercent((used / limit) * 100);
}

function isoField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function expiryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string" || !value.trim()) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1e9) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Matches `accountIdFor` in the usage tracker: email when known, else this machine. */
export function localQuotaAccountId(provider: UsageProvider, email?: string | null): string {
  const trimmed = email?.trim();
  return trimmed ? `${provider}:${trimmed.toLowerCase()}` : `${provider}:local`;
}

function quotaWindow(input: {
  provider: UsageProvider;
  windowType: UsageWindowType;
  percentUsed: number;
  resetsAt: string | null;
  nowMs: number;
  email?: string | null;
  windowDurationMs?: number;
}): UsageWindow {
  const resetsAt = input.resetsAt ?? "";
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return {
    provider: input.provider,
    windowType: input.windowType,
    accountId: localQuotaAccountId(input.provider, input.email),
    percentUsed: input.percentUsed,
    resetsAt,
    resetsInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - input.nowMs) : 0,
    ...(input.windowDurationMs && input.windowDurationMs > 0 ? { windowDurationMs: input.windowDurationMs } : {}),
  };
}

function resetFromSeconds(seconds: unknown, nowMs: number): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

function windowFromUsageNode(
  provider: UsageProvider,
  windowType: UsageWindowType,
  node: Record<string, unknown> | null,
  nowMs: number,
  email?: string | null,
  windowDurationMs?: number,
): UsageWindow | null {
  if (!node) return null;
  const percent = wholePercent(node.percent)
    ?? wholePercent(node.usagePercent)
    ?? wholePercent(node.percentUsed);
  if (percent == null) return null;
  const resetsAt = isoField(node, "resetsAt", "resets_at")
    ?? resetFromSeconds(node.resetInSec ?? node.reset_in_sec, nowMs);
  return quotaWindow({ provider, windowType, percentUsed: percent, resetsAt, nowMs, email, windowDurationMs });
}

export function parseCursorUsageSummary(payload: unknown, nowMs: number): {
  windows: UsageWindow[];
  plan: string | null;
  email: string | null;
} {
  const root = asRecord(payload);
  const individual = asRecord(root?.individualUsage) ?? asRecord(root?.individual_usage);
  const planNode = asRecord(individual?.plan) ?? asRecord(root?.plan);
  const percent = wholePercent(planNode?.totalPercentUsed)
    ?? wholePercent(planNode?.total_percent_used)
    ?? ratioPercent(planNode?.used, planNode?.limit);
  if (!root || percent == null) return { windows: [], plan: null, email: null };
  const email = stringField(root, "email");
  const plan = stringField(root, "membershipType", "membership_type");
  const resetsAt = isoField(root, "billingCycleEnd", "billing_cycle_end");
  return {
    windows: [quotaWindow({
      provider: "cursor",
      windowType: "monthly",
      percentUsed: percent,
      resetsAt,
      nowMs,
      email,
    })],
    plan,
    email,
  };
}

export function parseCopilotQuota(payload: unknown, nowMs: number): {
  windows: UsageWindow[];
  plan: string | null;
} {
  const root = asRecord(payload);
  const snapshots = asRecord(root?.quotaSnapshots) ?? asRecord(root?.quota_snapshots);
  const premium = asRecord(snapshots?.premiumInteractions) ?? asRecord(snapshots?.premium_interactions);
  const remaining = wholePercent(premium?.percentRemaining) ?? wholePercent(premium?.percent_remaining);
  const percent = remaining == null ? null : wholePercent(100 - remaining);
  if (percent == null) return { windows: [], plan: null };
  const plan = stringField(root, "copilotPlan", "copilot_plan");
  const resetsAt = isoField(premium, "resetAt", "reset_at")
    ?? isoField(root, "quotaResetAt", "quota_reset_at");
  return {
    windows: [quotaWindow({
      provider: "copilot",
      windowType: "monthly",
      percentUsed: percent,
      resetsAt,
      nowMs,
    })],
    plan,
  };
}

function grokWindowType(startIso: string | null, endIso: string | null): {
  windowType: UsageWindowType;
  windowDurationMs?: number;
} {
  if (!startIso || !endIso) return { windowType: "monthly" };
  const duration = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(duration) || duration <= 0) return { windowType: "monthly" };
  const days = duration / 86_400_000;
  if (days >= 5 && days <= 9) return { windowType: "weekly", windowDurationMs: duration };
  return { windowType: "monthly", windowDurationMs: duration };
}

export function parseGrokCredits(payload: unknown, nowMs: number): {
  windows: UsageWindow[];
  plan: string | null;
} {
  const root = asRecord(payload);
  const config = asRecord(root?.config) ?? root;
  if (!config) return { windows: [], plan: null };
  const onDemandUsed = asRecord(config.onDemandUsed) ?? asRecord(config.on_demand_used);
  const onDemandCap = asRecord(config.onDemandCap) ?? asRecord(config.on_demand_cap);
  const percent = wholePercent(config.creditUsagePercent)
    ?? wholePercent(config.credit_usage_percent)
    ?? ratioPercent(onDemandUsed?.val, onDemandCap?.val);
  if (percent == null) return { windows: [], plan: null };
  const period = asRecord(config.currentPeriod) ?? asRecord(config.current_period);
  const start = isoField(period, "start") ?? isoField(config, "billingPeriodStart", "billing_period_start");
  const end = isoField(period, "end")
    ?? isoField(config, "billingPeriodEnd", "billing_period_end");
  const cycle = grokWindowType(start, end);
  const plan = stringField(config, "subscriptionTier", "subscription_tier_display", "subscription_tier");
  return {
    windows: [quotaWindow({
      provider: "grok",
      windowType: cycle.windowType,
      percentUsed: percent,
      resetsAt: end,
      nowMs,
      ...(cycle.windowDurationMs ? { windowDurationMs: cycle.windowDurationMs } : {}),
    })],
    plan,
  };
}

export function parseOpenCodeGoUsage(payload: unknown, nowMs: number): UsageWindow[] {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage) ?? root;
  if (!usage) return [];
  const rolling = asRecord(usage.rolling) ?? asRecord(usage.rollingUsage);
  const weekly = asRecord(usage.weekly) ?? asRecord(usage.weeklyUsage);
  const monthly = asRecord(usage.monthly) ?? asRecord(usage.monthlyUsage);
  return [
    windowFromUsageNode("opencode", "five_hour", rolling, nowMs, null, 5 * 3_600_000),
    windowFromUsageNode("opencode", "weekly", weekly, nowMs),
    windowFromUsageNode("opencode", "monthly", monthly, nowMs),
  ].filter((window): window is UsageWindow => window != null);
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

export function openCodeAuthPaths(io: Pick<ResolvedIo, "homeDir" | "platform" | "env">): string[] {
  const paths: string[] = [];
  const xdgData = io.env.XDG_DATA_HOME?.trim();
  if (xdgData) paths.push(path.join(xdgData, "opencode", "auth.json"));
  paths.push(path.join(io.homeDir, ".local", "share", "opencode", "auth.json"));
  if (io.platform === "darwin") {
    paths.push(path.join(io.homeDir, "Library", "Application Support", "opencode", "auth.json"));
  }
  if (io.platform === "win32") paths.push(path.join(appDataDir(io as ResolvedIo), "opencode", "auth.json"));
  return paths;
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
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
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

function usableSessionToken(token: string | null, nowMs: number): string | null {
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

function openCursorDatabase(dbPath: string): DatabaseSync {
  // `node:sqlite` is a Node builtin. A static import is rewritten by the
  // desktop test bundler into a missing `sqlite` URL, so this stays a runtime
  // require and only runs when a Cursor session file is actually there.
  const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
  const { DatabaseSync: Database } = require("node:sqlite") as {
    DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => DatabaseSync;
  };
  return new Database(dbPath, { readOnly: true });
}

async function readCursorSessionToken(dbPath: string): Promise<{ token: string | null; unreadable: boolean }> {
  try {
    await access(dbPath);
  } catch {
    return { token: null, unreadable: false };
  }
  let db: DatabaseSync | null = null;
  try {
    db = openCursorDatabase(dbPath);
    const row = db.prepare("select value from ItemTable where key = ?").get("cursorAuth/accessToken") as { value?: unknown } | undefined;
    return { token: sqliteText(row?.value ?? null), unreadable: false };
  } catch {
    return { token: null, unreadable: true };
  } finally {
    db?.close();
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
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
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
    const copilotHome = path.join(
      resolved.env.COPILOT_HOME?.trim() || path.join(resolved.homeDir, ".copilot"),
    );
    const ghHosts = path.join(xdgConfigDir(resolved), "gh", "hosts.yml");
    const [copilotConfig, ghConfig] = await Promise.all([
      resolved.readText(path.join(copilotHome, "config.json")),
      resolved.readText(ghHosts),
    ]);
    if (copilotConfig == null && ghConfig == null) return notSignedIn();
    token = await resolved.readGhToken(context.reason === "user");
  }
  if (!token) return notSignedIn();
  const response = await fetchJson(resolved.fetchImpl, COPILOT_USAGE_URL, {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "Editor-Version": "vscode/1.96.2",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-Github-Api-Version": "2025-04-01",
  });
  if (!response.ok) return httpFailure("copilot", response);
  const parsed = parseCopilotQuota(response.body, resolved.nowMs);
  return freshResult("copilot", parsed.windows, { plan: parsed.plan }, "usage response had no premium quota");
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
  const credits = parseGrokCredits(response.body, resolved.nowMs);
  const windows = bearer.email
    ? credits.windows.map((window) => ({ ...window, accountId: localQuotaAccountId("grok", bearer.email) }))
    : credits.windows;
  return freshResult("grok", windows, { email: bearer.email, plan: credits.plan }, "billing response had no usage percent");
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
  if (!key) return notSignedIn();
  const response = await fetchJson(resolved.fetchImpl, OPENCODE_USAGE_URL, {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  });
  if (!response.ok) return httpFailure("opencode", response);
  return freshResult("opencode", parseOpenCodeGoUsage(response.body, resolved.nowMs), {}, "usage response had no windows");
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
