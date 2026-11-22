import { trustedHttpsOrigin } from "../trustedOrigin";
import { ADE_GITHUB_APP_INSTALL_URL } from "../../../desktop/src/shared/github/githubDirectStateCopy";
import { githubAppRuntime, serveToken, type GithubAppEnv } from "../githubApp/grants";
import { sendCloudEmail } from "./email";
import { logCloud, reportCloudFailure, type CloudEnv } from "./store";

/**
 * What ADE Cloud's server reads from the account's vault on the push relay,
 * and how it tells a person something (C6's git check, C9's automations).
 *
 * The vault is the push relay's; the directory reads it through the
 * `ACTIVITY_RELAY` service binding it already has, with the caller's own
 * bearer token, so the relay derives the account from the token and the
 * directory can never read another account's. With no token (the minute
 * cron) nothing is read. Values pass through memory only: never stored,
 * never logged.
 */

export type RelayEnv = CloudEnv & {
  PUSH_RELAY_URL?: string;
  ACTIVITY_RELAY?: { fetch: typeof fetch };
  DIRECTORY_AUTH_SECRET?: string;
};

/** The vault items a cloud computer's git can use (`ACCOUNT_GIT_CREDENTIAL_ITEMS` in cloudGitCredential.ts). */
const GIT_CREDENTIAL_KEYS = ["github", "github-cli"] as const;
/** The agent limits' vault item (`CLOUD_AGENT_LIMITS_VAULT_KEY` in cloudSleep.ts). */
export const AGENT_LIMITS_KEY = "cloud-budget";
const VAULT_PAGES = 4;
const RELAY_TIMEOUT_MS = 8_000;
const GITHUB_TIMEOUT_MS = 5_000;

/** What an unattended agent may spend (`CloudAgentLimits` in the desktop's adeCloud.ts). */
export type CloudAgentLimits = {
  unattendedSpend: boolean;
  machinesPerDay: number;
  maxShape: string;
  /** Older apps' limit on paid extra disk (no longer sold, Pricing v2), cents a month: kept as saved, never read as a limit. */
  extraDiskMonthCents?: number | null;
};
/** The desktop's default (`CLOUD_DEFAULT_AGENT_LIMITS`, "balanced"). */
export const DEFAULT_AGENT_LIMITS: CloudAgentLimits = { unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", extraDiskMonthCents: null };

export type VaultFacts = {
  /** `ok`: a git-capable credential follows the account; `none`: none does; `unknown`: the vault didn't answer. */
  git: "ok" | "none" | "unknown";
  /**
   * The agent limits: the stored ones, the default when the vault answered
   * with none stored, or null when the vault didn't answer (unknown, which
   * a caller must not read as permission to spend).
   */
  limits: CloudAgentLimits | null;
};

const UNKNOWN: VaultFacts = { git: "unknown", limits: null };

/** The push relay through the service binding, or null when it isn't set up. The vault proxy (`accountSignIns.ts`) uses it too. */
export function relayFetch(env: RelayEnv): { base: string; fetch: typeof fetch } | null {
  const base = trustedHttpsOrigin(env.PUSH_RELAY_URL);
  const relay = env.ACTIVITY_RELAY;
  return base && relay ? { base, fetch: relay.fetch.bind(relay) } : null;
}

function tokenOf(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parsed?.v === 1 && typeof parsed.token === "string" && parsed.token.trim().length > 0;
  } catch {
    return false;
  }
}

/** The most `extraDiskMonthCents` may be (as `cloudAgentExtraDiskCentsOf` in the desktop's shared/adeCloud/accountCalls.ts). */
export const AGENT_EXTRA_DISK_MAX_CENTS = 100_000;

/** A whole number of cents from 0 to the max, or null (the account's own limit), like the desktop's `cloudAgentExtraDiskCentsOf`. */
export function extraDiskCentsOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= AGENT_EXTRA_DISK_MAX_CENTS ? raw : null;
}

export function limitsOf(raw: unknown): CloudAgentLimits | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; agents?: Record<string, unknown> } | null;
    if ((parsed?.v !== 2 && parsed?.v !== 3) || !parsed.agents || typeof parsed.agents !== "object") return null;
    const agents = parsed.agents;
    const perDay = agents.machinesPerDay;
    return {
      unattendedSpend: typeof agents.unattendedSpend === "boolean" ? agents.unattendedSpend : DEFAULT_AGENT_LIMITS.unattendedSpend,
      machinesPerDay: typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 0 && perDay <= 100 ? perDay : DEFAULT_AGENT_LIMITS.machinesPerDay,
      maxShape: typeof agents.maxShape === "string" && /^\d+x\d+$/.test(agents.maxShape) ? agents.maxShape : DEFAULT_AGENT_LIMITS.maxShape,
      extraDiskMonthCents: extraDiskCentsOf(agents.extraDiskMonthCents),
    };
  } catch {
    return null;
  }
}

/** One vault row as the relay returns it. `value` is null for a tombstone or a row the relay can't open. */
/** `updatedAt` is the row's revision. `refreshOwner`: the device that renews a rotating grant (rotatingCredentialOwner.ts). */
export type VaultRecord = { scope: string; kind: string; key: string; value: string | null; updatedAt: string; refreshOwner?: string | null; deleted?: boolean };
/** One live key with no value (`GET vault/keys`). */
export type VaultKeyRecord = { scope: string; kind: string; key: string; updatedAt: string };
/** `no_route`: a relay from before the narrow reads (it answers 404), so the caller reads the old way. */
export type VaultRead<T> = { ok: true; value: T } | { ok: false; reason: "no_route" | "failed" };

async function relayGet(env: RelayEnv, authorization: string, path: string, event: string): Promise<VaultRead<Record<string, unknown>>> {
  const relay = relayFetch(env);
  if (!relay) return { ok: false, reason: "failed" };
  try {
    const response = await relay.fetch(`${relay.base}${path}`, {
      headers: { accept: "application/json", authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "no_route" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      logCloud(`${event}_refused`, { status: response.status });
      return { ok: false, reason: "failed" };
    }
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      logCloud(`${event}_refused`, { status: response.status });
      return { ok: false, reason: "failed" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    logCloud(`${event}_failed`, { error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, reason: "failed" };
  }
}

/** `scope`: the scope that was read, for a row that does not name it (the older readers never needed it). */
function vaultRecordOf(raw: unknown, scope?: string): VaultRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const rowScope = typeof item.scope === "string" ? item.scope : scope;
  if (rowScope === undefined || typeof item.kind !== "string" || typeof item.key !== "string") return null;
  return {
    scope: rowScope,
    kind: item.kind,
    key: item.key,
    value: typeof item.value === "string" ? item.value : null,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    refreshOwner: typeof item.refreshOwner === "string" && item.refreshOwner.trim() ? item.refreshOwner.trim() : null,
    ...(item.deleted === true ? { deleted: true } : {}),
  };
}

/** Every row of one vault scope (the full read, which opens every item), or null when it didn't answer or ran past `maxPages`. */
export async function readVaultScope(env: RelayEnv, authorization: string, scope: string, maxPages: number, options: { partial?: boolean } = {}): Promise<VaultRecord[] | null> {
  const rows: VaultRecord[] = [];
  let since: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const read = await relayGet(env, authorization, `/attention/account/vault?scope=${encodeURIComponent(scope)}${since ? `&since=${encodeURIComponent(since)}` : ""}`, "cloud.vault_read");
    if (!read.ok) return null;
    for (const raw of Array.isArray(read.value.items) ? read.value.items : []) {
      const row = vaultRecordOf(raw, scope);
      if (row) rows.push(row);
    }
    if (read.value.truncated !== true || typeof read.value.cursor !== "string") return rows;
    since = read.value.cursor;
  }
  // `partial`: the caller has always read only the first pages (the facts read).
  if (options.partial) return rows;
  logCloud("cloud.vault_read_too_long", { pages: maxPages });
  return null;
}

/**
 * One named item through the relay's narrow read (`GET vault/item`), which
 * opens only that item. `value: null` when there is no live row.
 */
export async function readVaultItem(env: RelayEnv, authorization: string, item: { scope: string; kind: string; key: string }): Promise<VaultRead<VaultRecord | null>> {
  const query = new URLSearchParams({ scope: item.scope, kind: item.kind, key: item.key });
  const read = await relayGet(env, authorization, `/attention/account/vault/item?${query.toString()}`, "cloud.vault_item_read");
  if (!read.ok) return read;
  // A relay that knows the route always names `item` (null when absent); any other answer is not that route.
  if (!("item" in read.value)) return { ok: false, reason: "no_route" };
  const row = vaultRecordOf(read.value.item);
  return { ok: true, value: row && !row.deleted ? row : null };
}

/**
 * The live keys of one scope (and kind), with no value (`GET vault/keys`).
 * On a relay without that route it falls back to the full read and drops the
 * values here, so a caller never holds a value it did not ask for.
 */
export async function readVaultKeys(env: RelayEnv, authorization: string, scope: string, kind?: string): Promise<VaultKeyRecord[] | null> {
  const read = await readVaultKeyList(env, authorization, scope, kind);
  if (read.ok) return read.value;
  if (read.reason !== "no_route") return null;
  const rows = await readVaultScope(env, authorization, scope, LEGACY_SCOPE_PAGES);
  return rows?.flatMap((row) => (row.deleted || (kind && row.kind !== kind) ? [] : [{ scope: row.scope, kind: row.kind, key: row.key, updatedAt: row.updatedAt }])) ?? null;
}

/** The relay's keys read alone (`GET vault/keys`): `no_route` on a relay without it. */
export async function readVaultKeyList(env: RelayEnv, authorization: string, scope: string, kind?: string): Promise<VaultRead<VaultKeyRecord[]>> {
  const query = new URLSearchParams({ scope, ...(kind ? { kind } : {}) });
  const read = await relayGet(env, authorization, `/attention/account/vault/keys?${query.toString()}`, "cloud.vault_keys_read");
  if (!read.ok) return read;
  if (!Array.isArray(read.value.items)) return { ok: false, reason: "no_route" };
  const keys: VaultKeyRecord[] = [];
  for (const raw of read.value.items) {
    const row = vaultRecordOf(raw);
    if (row) keys.push({ scope: row.scope, kind: row.kind, key: row.key, updatedAt: row.updatedAt });
  }
  return { ok: true, value: keys };
}

/** The relay's pages include tombstones, so a long-lived vault takes several (the sign-ins read's cap). */
const LEGACY_SCOPE_PAGES = 25;

/**
 * One write of one item through the relay, with the revision it replaces
 * (`absent` for "no row"). `stale`: the row changed since that revision.
 */
export async function writeVaultItem(
  env: RelayEnv,
  authorization: string,
  item: { scope: string; kind: string; key: string; value: string; ifRevision: string; refreshOwner?: string | null },
  writer: string,
): Promise<"ok" | "stale" | "failed"> {
  const relay = relayFetch(env);
  if (!relay) return "failed";
  const at = new Date().toISOString();
  try {
    const response = await relay.fetch(`${relay.base}/attention/account/vault`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json", authorization },
      body: JSON.stringify({ deviceId: writer, sentAt: at, itemResults: true, items: [{ ...item, writtenAt: at }] }),
      redirect: "manual",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      logCloud("cloud.vault_write_refused", { status: response.status });
      return "failed";
    }
    const body = await response.json() as { results?: Array<{ status?: unknown }> };
    // The relay answers `written` for a write that went in (`accountWriteResults`).
    const status = body.results?.[0]?.status;
    if (status === "written") return "ok";
    if (status === "stale") return "stale";
    logCloud("cloud.vault_write_refused", { status: typeof status === "string" ? status : "unknown" });
    return "failed";
  } catch (error) {
    logCloud("cloud.vault_write_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

function factsOf(rows: Array<VaultRecord | null>): VaultFacts {
  let git = false;
  let limits: CloudAgentLimits | null = null;
  let limitsStored = false;
  for (const item of rows) {
    if (!item || item.kind !== "integration" || item.deleted === true) continue;
    if (GIT_CREDENTIAL_KEYS.includes(item.key as typeof GIT_CREDENTIAL_KEYS[number]) && tokenOf(item.value)) git = true;
    if (item.key === AGENT_LIMITS_KEY) {
      limitsStored = true;
      const parsed = limitsOf(item.value);
      if (parsed) limits = parsed;
      else logCloud("cloud.vault_limits_unreadable", {});
    }
  }
  // Limits stored but unreadable (a newer ADE's format, a broken value) are unknown,
  // and unknown never spends; the defaults apply only when none are stored.
  return { git: git ? "ok" : "none", limits: limits ?? (limitsStored ? null : DEFAULT_AGENT_LIMITS) };
}

/**
 * The git credential and the agent limits, read from the account-wide
 * (`all`) part of the vault with the caller's own token: three named items
 * through the relay's narrow read, or the old paged read of the whole scope
 * on a relay without it. Never throws.
 */
export async function readVaultFacts(env: RelayEnv, authorization: string | null): Promise<VaultFacts> {
  if (!relayFetch(env) || !authorization) return UNKNOWN;
  const reads = await Promise.all([...GIT_CREDENTIAL_KEYS, AGENT_LIMITS_KEY].map((key) =>
    readVaultItem(env, authorization, { scope: "all", kind: "integration", key })));
  if (reads.every((read) => read.ok)) return factsOf(reads.map((read) => (read.ok ? read.value : null)));
  if (reads.some((read) => !read.ok && read.reason === "failed")) return UNKNOWN;
  const rows = await readVaultScope(env, authorization, "all", VAULT_PAGES, { partial: true });
  return rows ? factsOf(rows) : UNKNOWN;
}

export type RepoVisibility = "public" | "private" | "unknown";

/** Whether GitHub shows `github.com/owner/repo` to anyone: one read without a token. */
export async function githubRepoVisibility(origin: string): Promise<RepoVisibility> {
  const [, owner, repo] = origin.split("/");
  if (!owner || !repo) return "unknown";
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ADE" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (response.status === 404) return "private";
    if (!response.ok) return "unknown";
    const body = await response.json().catch(() => null) as { private?: unknown; visibility?: unknown } | null;
    if (body?.private === false || body?.visibility === "public") return "public";
    return body?.private === true ? "private" : "unknown";
  } catch {
    return "unknown";
  }
}

/** The plain sentence a refused launch gives (the desktop's `cloudGitPreflight`). */
export function connectGitHubSentence(origin: string): string {
  const name = origin.replace(/^github\.com\//, "");
  return `${name} isn't public on GitHub, and your ADE account has no GitHub sign-in a cloud computer can clone it with. Connect GitHub in Settings › GitHub so your sign-in follows your ADE account, then send again.`;
}

/** The plain sentence a launch refused for a missing App installation gives. */
export function giveAdeAccessSentence(origin: string): string {
  const [, owner = "", repo = ""] = origin.split("/");
  return `Give ADE access to ${owner}: install the ADE GitHub App on ${owner} with ${repo} selected, then send again.`;
}

export type ServerGitCheck = { ok: true } | { ok: false; code: "git_credential_missing" | "github_app_not_installed"; message: string; installUrl?: string };

/**
 * Whether the account's ADE GitHub App sign-in reaches this repository: one
 * read of `GET /repos/{owner}/{repo}` with the App's user token. A user
 * token sees a private repository only where the App is installed with it,
 * so 200 is yes and 404 is "not installed there". A public repository
 * answers 200 either way; it clones without the App. `off`: no App here (or
 * no repository to ask about). `unknown`: the App was asked and didn't answer
 * clearly. Never throws.
 */
async function githubAppRepoAccess(env: GithubAppEnv, userId: string, origin: string): Promise<"ok" | "not_installed" | "not_connected" | "unknown" | "off"> {
  const [, owner, repo] = origin.split("/");
  if (!owner || !repo) return "off";
  try {
    const rt = await githubAppRuntime(env);
    if (!rt) return "off";
    const outcome = await serveToken(rt, userId, { rejectedSha256: null });
    if (outcome.kind === "not_connected" || outcome.kind === "needs_reauth") return "not_connected";
    if (outcome.kind !== "token") return "unknown";
    const response = await fetch(`${rt.config.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${outcome.token.accessToken}`, "user-agent": "ADE" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return "ok";
    if (response.status === 404) return "not_installed";
    return "unknown";
  } catch (error) {
    logCloud("cloud.git_check_app_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "unknown";
  }
}

/**
 * C4 on the server: can a new computer clone this repository? The account's
 * git credentials first (a pasted token or a `gh` login in the vault), then
 * the ADE GitHub App sign-in, which the computer's git also uses. Refused
 * only on a clear no: the App is connected but not installed where it can
 * see a private repository ("Give ADE access to <owner>"), or nothing follows
 * the account and GitHub says the repository isn't public. Anything unknown
 * goes on, with a log line.
 */
export async function serverGitCheck(env: RelayEnv & GithubAppEnv, authorization: string | null, origin: string, userId: string): Promise<ServerGitCheck> {
  const facts = await readVaultFacts(env, authorization);
  if (facts.git === "ok") return { ok: true };
  const app = await githubAppRepoAccess(env, userId, origin);
  if (app === "ok") return { ok: true };
  // Refused only when the vault surely has no git credential: an unreadable vault may hold one.
  if (app === "not_installed" && facts.git === "none") {
    const visibility = await githubRepoVisibility(origin);
    if (visibility !== "public") {
      return { ok: false, code: "github_app_not_installed", message: giveAdeAccessSentence(origin), installUrl: ADE_GITHUB_APP_INSTALL_URL };
    }
    // A public repository clones without the App; only a push would need it.
    logCloud("cloud.git_check_app_not_installed_public", {});
    return { ok: true };
  }
  if (facts.git === "unknown" || app === "unknown") {
    // Inconclusive: the vault or the App may hold access, so the launch goes on.
    logCloud("cloud.git_check_unknown", { reason: facts.git === "unknown" ? "vault" : "github_app" });
    return { ok: true };
  }
  const visibility = await githubRepoVisibility(origin);
  if (visibility === "private") return { ok: false, code: "git_credential_missing", message: connectGitHubSentence(origin) };
  if (visibility === "unknown") logCloud("cloud.git_check_unknown", { reason: "github" });
  return { ok: true };
}

/**
 * Tells a person something with nobody watching (an automation's run that
 * couldn't start, a paused rule): an Activity notification through the push
 * relay (`POST /directory/accounts/<userId>/notify`, the directory's own
 * secret, as the account purge does), and an email when `email` is set.
 * Best effort: a failure is logged, never thrown.
 */
export async function notifyAccount(env: RelayEnv, userId: string, note: { title: string; body: string; email?: boolean }): Promise<void> {
  const relay = relayFetch(env);
  const secret = env.DIRECTORY_AUTH_SECRET?.trim();
  if (relay && secret) {
    try {
      const response = await relay.fetch(`${relay.base}/directory/accounts/${encodeURIComponent(userId)}/notify`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-ade-directory-auth": secret },
        body: JSON.stringify({ title: note.title.slice(0, 120), body: note.body.slice(0, 900) }),
        redirect: "manual",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) logCloud("cloud.notify_refused", { status: response.status });
    } catch (error) {
      reportCloudFailure("cloud.notify_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  if (note.email) await sendCloudEmail(env, { userId, subject: note.title, text: note.body });
}
