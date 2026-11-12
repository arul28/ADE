import { trustedHttpsOrigin } from "../trustedOrigin";
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
const AGENT_LIMITS_KEY = "cloud-budget";
const VAULT_PAGES = 4;
const RELAY_TIMEOUT_MS = 8_000;
const GITHUB_TIMEOUT_MS = 5_000;

/** What an unattended agent may spend (`CloudAgentLimits` in the desktop's adeCloud.ts). */
export type CloudAgentLimits = { unattendedSpend: boolean; machinesPerDay: number; maxShape: string };
/** The desktop's default (`CLOUD_DEFAULT_AGENT_LIMITS`, "balanced"). */
export const DEFAULT_AGENT_LIMITS: CloudAgentLimits = { unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16" };

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

function relayFetch(env: RelayEnv): { base: string; fetch: typeof fetch } | null {
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

function limitsOf(raw: unknown): CloudAgentLimits | null {
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
    };
  } catch {
    return null;
  }
}

/**
 * The git credential and the agent limits, read once from the account-wide
 * (`all`) part of the vault with the caller's own token. Never throws.
 */
export async function readVaultFacts(env: RelayEnv, authorization: string | null): Promise<VaultFacts> {
  const relay = relayFetch(env);
  if (!relay || !authorization) return UNKNOWN;
  let git = false;
  let limits: CloudAgentLimits | null = null;
  let since: string | null = null;
  try {
    for (let page = 0; page < VAULT_PAGES; page += 1) {
      const url = `${relay.base}/attention/account/vault?scope=all${since ? `&since=${encodeURIComponent(since)}` : ""}`;
      const response = await relay.fetch(url, {
        headers: { accept: "application/json", authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        logCloud("cloud.vault_read_refused", { status: response.status });
        return UNKNOWN;
      }
      const body = await response.json() as { items?: Array<Record<string, unknown>>; truncated?: unknown; cursor?: unknown };
      for (const item of body.items ?? []) {
        if (item.kind !== "integration" || item.deleted === true) continue;
        if (GIT_CREDENTIAL_KEYS.includes(item.key as typeof GIT_CREDENTIAL_KEYS[number]) && tokenOf(item.value)) git = true;
        if (item.key === AGENT_LIMITS_KEY) limits = limitsOf(item.value) ?? limits;
      }
      if (body.truncated !== true || typeof body.cursor !== "string") break;
      since = body.cursor;
    }
  } catch (error) {
    logCloud("cloud.vault_read_failed", { error: error instanceof Error ? error.name : "unknown" });
    return UNKNOWN;
  }
  return { git: git ? "ok" : "none", limits: limits ?? DEFAULT_AGENT_LIMITS };
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

/**
 * C4 on the server: can a new computer clone this repository? Refused only on
 * a clear no (no credential follows the account and GitHub says the repository
 * isn't public). Anything unknown goes on, with a log line.
 */
export async function serverGitCheck(env: RelayEnv, authorization: string | null, origin: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const facts = await readVaultFacts(env, authorization);
  if (facts.git !== "none") {
    if (facts.git === "unknown") logCloud("cloud.git_check_unknown", { reason: "vault" });
    return { ok: true };
  }
  const visibility = await githubRepoVisibility(origin);
  if (visibility === "private") return { ok: false, message: connectGitHubSentence(origin) };
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
