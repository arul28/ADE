/**
 * Contract C4: "does this account have a credential git can use", checked
 * before a cloud computer is made for a lane (the launch's start, in the
 * desktop app and in a brain, so `ade chat create --machine cloud` too).
 *
 * A new cloud computer has no GitHub sign-in of its own: its brain clones
 * with what follows the ADE account. That is read here from the account
 * vault, data-driven (`ACCOUNT_GIT_CREDENTIAL_ITEMS`):
 *
 * - `integration/github`: a pasted token (PAT), `githubPatAccountSync.ts`.
 * - `integration/github-cli`: a `gh` CLI login copied to the account, written
 *   by the project lifecycle lane (PR #2186, `githubGhAccountSync.ts`). Its
 *   value is `{ v: 1, token }`, or `{ v: 1, removed: true }` after "Remove
 *   from my account". Until that lands the item never exists, and the check
 *   passes unchanged once it does.
 *
 * Both values are `{ v: 1, token }`. A tombstone, a missing item and a
 * `removed` value are "none". The ADE GitHub App sign-in is not git-capable
 * and stays on its machine, so it is never an answer (source "app" is kept
 * in the type for when it is).
 *
 * The check does not ask GitHub whether the token still works: a revoked
 * token passes here and the clone says so.
 *
 * A public repository needs no credential. With none in the account, ADE
 * asks GitHub's API about the repository once, without a token: public goes
 * on, not visible (private, or gone) is refused with the way out, and no
 * answer (offline, rate limited) goes on with a warning. No token from this
 * computer goes with the question.
 */
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import {
  CONNECT_GITHUB_HINT,
  type AccountGitCredential,
  type AccountGitCredentialSource,
  type CloudGitPreflight,
} from "../../../shared/cloudGitCredential";
import type { CloudVault } from "./cloudAccess";

/** The account vault items a cloud computer's git can use, in the order they are tried. Kind `integration`, scope `all`. */
export const ACCOUNT_GIT_CREDENTIAL_ITEMS: ReadonlyArray<{ key: string; source: AccountGitCredentialSource }> = [
  { key: "github", source: "pat" },
  { key: "github-cli", source: "gh" },
];

export type AccountGitCredentialDeps = {
  /**
   * One account-wide `integration` item of the vault (`cloudVaultFromStore`
   * in a brain, `cloudVaultFromBridge` in the desktop), or null when this
   * process has no signed-in account.
   */
  vault: (key: string) => CloudVault | null;
};

const UNREADABLE_MESSAGE = `ADE couldn't read your account's GitHub sign-in on this computer. ${CONNECT_GITHUB_HINT}`;
const NONE_MESSAGE = `Your ADE account has no GitHub sign-in a cloud computer can clone with. ${CONNECT_GITHUB_HINT}`;

/** A token in a `{ v: 1, token }` value; null for anything else (`removed`, another format). */
function tokenOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return record.v === 1 && typeof record.token === "string" && record.token.trim() ? record.token : null;
  } catch {
    return null;
  }
}

/** Whether the account has a credential git can use on a new cloud computer. Never throws. */
export async function accountGitCredential(deps: AccountGitCredentialDeps): Promise<AccountGitCredential> {
  let unreadable = false;
  for (const item of ACCOUNT_GIT_CREDENTIAL_ITEMS) {
    let vault: CloudVault | null;
    try {
      vault = deps.vault(item.key);
    } catch {
      vault = null;
    }
    if (!vault) return { ok: false, reason: "unreadable", message: UNREADABLE_MESSAGE };
    const read = await vault.get().catch(() => ({ ok: false as const }));
    if (!read.ok) {
      unreadable = true;
      continue;
    }
    if (tokenOf(read.value)) return { ok: true, source: item.source };
  }
  return unreadable
    ? { ok: false, reason: "unreadable", message: UNREADABLE_MESSAGE }
    : { ok: false, reason: "none", message: NONE_MESSAGE };
}

export type RepoVisibility = "public" | "not_visible" | "unknown";

/** The most one visibility question may take. */
const VISIBILITY_TIMEOUT_MS = 8_000;

/**
 * Whether GitHub shows the repository to anyone (one unauthenticated read of
 * `GET /repos/{owner}/{repo}`). `not_visible`: private, or gone; either way
 * a computer with no credential can't clone it. `unknown`: no answer.
 */
export async function githubRepoVisibility(
  repo: { owner: string; repo: string },
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<RepoVisibility> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") return "unknown";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? VISIBILITY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await doFetch(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "ADE" }, signal: controller.signal },
    );
    if (response.status === 404) return "not_visible";
    if (!response.ok) return "unknown";
    const body = await response.json().catch(() => null) as { private?: unknown; visibility?: unknown } | null;
    if (body?.private === false || body?.visibility === "public") return "public";
    // An unauthenticated read that answers is public; anything else is not a clear answer.
    return body?.private === true ? "not_visible" : "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The launch's preflight: can a new cloud computer clone this repository?
 * The account's credential first (no network), then, only without one, the
 * repository's visibility. Never throws.
 */
export async function cloudGitPreflight(
  deps: AccountGitCredentialDeps & { fetch?: typeof fetch; timeoutMs?: number },
  originUrl: string | null,
): Promise<CloudGitPreflight> {
  const credential = await accountGitCredential(deps);
  if (credential.ok) return { ok: true, via: credential.source };
  const repo = githubRepoOf(originUrl);
  // Not a GitHub origin: the launch's own refusal speaks for it.
  if (!repo) return { ok: true, via: "unknown", warning: "ADE couldn't check this repository on GitHub." };
  const visibility = await githubRepoVisibility(repo, deps);
  if (visibility === "public") return { ok: true, via: "public" };
  if (visibility === "not_visible") {
    const name = `${repo.owner}/${repo.repo}`;
    return {
      ok: false,
      reason: credential.reason,
      message: credential.reason === "unreadable"
        ? `${name} isn't public on GitHub, and ADE couldn't read your account's GitHub sign-in on this computer, so a cloud computer couldn't clone it. ${CONNECT_GITHUB_HINT}`
        : `${name} isn't public on GitHub, and your ADE account has no GitHub sign-in a cloud computer can clone it with. ${CONNECT_GITHUB_HINT}`,
    };
  }
  return {
    ok: true,
    via: "unknown",
    warning: `ADE couldn't reach GitHub to check ${repo.owner}/${repo.repo}. If it is private, the new computer can't clone it until GitHub is connected in Settings › GitHub.`,
  };
}
