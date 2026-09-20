import { normalizeGitRemoteIdentity } from "./crossMachineHandoff";
import type { SettingScope } from "./types/settingsScope";

/**
 * Turns ADE's four-value setting scope into the key the account store files a
 * row under.
 *
 * Only the two account scopes reach the store at all. A machine-scoped value
 * holds a path, a port, or a fact about hardware, so it is meaningless on
 * another computer and never leaves this one — that is the placement rule, and
 * this function is where it is enforced rather than merely described.
 *
 * Repo identity comes from `normalizeGitRemoteIdentity`, which is already the
 * host-agnostic normalizer the handoff and lane-matching paths share. ADE has
 * four remote normalizers with slightly different rules; adding a fifth for
 * settings would guarantee that two parts of the product eventually disagree
 * about whether two checkouts are the same repository.
 */

/** Every project, on this account. */
export const ACCOUNT_SCOPE_ALL = "all";

const REPO_SCOPE_PREFIX = "repo:";

/**
 * Strips anything credential-shaped before a host.
 *
 * `normalizeGitRemoteIdentity` preserves `user@` when the URL is malformed
 * enough to fall through to its last branch, and a remote of the form
 * `https://<token>@github.com/owner/repo` is a real thing people have in
 * `.git/config`. This key is sent to a Worker and stored in D1, so a token must
 * not be able to ride along inside it.
 */
function stripCredential(identity: string): string {
  return identity.replace(/^[^/@]+@/, "");
}

/**
 * The account-store key for one repository, or null when the project has no
 * usable remote.
 *
 * Null is a real answer, not a failure: a repository with no GitHub origin has
 * no identity that means anything on a second machine, so its repo-scoped
 * settings stay local until it gets one.
 */
export function accountRepoScopeKey(gitOriginUrl: string | null | undefined): string | null {
  const identity = normalizeGitRemoteIdentity(gitOriginUrl);
  if (!identity) return null;
  const cleaned = stripCredential(identity).replace(/\/+$/, "");
  // A bare host is not a repository. Requiring a path segment stops
  // `github.com` becoming one shared bucket for every remote ADE cannot parse.
  if (!cleaned.includes("/")) return null;
  return `${REPO_SCOPE_PREFIX}${cleaned}`;
}

/**
 * The key a setting saves under, or null when it does not belong in the account
 * store at all.
 *
 * Two different nulls, deliberately collapsed into one: a machine-scoped
 * setting never syncs, and a repo-scoped setting with no remote cannot yet. The
 * caller's behaviour is identical in both cases — keep it local — so making
 * them one answer removes a branch nobody would get right twice.
 */
export function accountSettingScopeKey(
  scope: SettingScope,
  gitOriginUrl: string | null | undefined,
): string | null {
  if (scope === "account") return ACCOUNT_SCOPE_ALL;
  if (scope === "account-repo") return accountRepoScopeKey(gitOriginUrl);
  return null;
}

/** True when this scope is the account's to carry between machines. */
export function isAccountScope(scope: SettingScope): boolean {
  return scope === "account" || scope === "account-repo";
}

/** True when this scope is filed under one repository rather than globally. */
export function isRepoScope(scope: SettingScope): boolean {
  return scope === "account-repo" || scope === "machine-repo";
}
