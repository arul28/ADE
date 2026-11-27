/**
 * Contract C4: "does this account have a credential git can use", checked
 * before a cloud computer is made for a lane (the launch's start, in the
 * desktop app and in a brain, so `ade chat create --machine cloud` too).
 *
 * A new cloud computer has no GitHub sign-in of its own: its brain clones
 * with what follows the ADE account. That is read here from the account
 * vault, data-driven (`ACCOUNT_GIT_CREDENTIAL_ITEMS`, keys and value format
 * in `github/accountGithubTokenItem.ts`):
 *
 * - `integration/github`: a pasted token (PAT), `githubPatAccountSync.ts`.
 * - `integration/github-cli`: a `gh` CLI login copied to the account, which
 *   PR #2186 writes. Nothing writes it yet, so today only a PAT answers; the
 *   check reads the item already, so it passes unchanged once #2186 lands.
 *
 * A tombstone, a missing item and a `removed` value are "none". With
 * neither, the ADE account's GitHub App sign-in answers: a cloud computer's
 * git credential helper falls back to the App's token, which the account
 * serves to every machine (`accountApp`, one status read).
 *
 * The check does not ask GitHub whether the token still works: a revoked
 * token passes here and the clone says so.
 *
 * Only a definite "none" refuses. A vault this process can't read (the
 * desktop's background service down) is not "none": the new computer reads
 * the account's vault itself, so that launch goes on with a warning.
 *
 * A public repository needs no credential. With none in the account, ADE
 * asks GitHub's API about the repository once, without a token: public goes
 * on, not visible (private, or gone) is refused with the way out, and no
 * answer (offline, rate limited) goes on with a warning the launch shows. No
 * token from this computer goes with the question.
 */
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import {
  CONNECT_GITHUB_HINT,
  type AccountGitCredential,
  type AccountGitCredentialSource,
  type CloudGitPreflight,
} from "../../../shared/cloudGitCredential";
import { createAccountAppTokenClient } from "../../../shared/github/accountAppTokenClient";
import { GITHUB_CLI_VAULT_KEY, GITHUB_PAT_VAULT_KEY, decodeAccountGithubToken } from "../github/accountGithubTokenItem";
import type { CloudVault } from "./cloudAccess";
import { BRAND } from "../../../shared/brand";

/** The account vault items a cloud computer's git can use, in the order they are tried. Kind `integration`, scope `all`. */
const ACCOUNT_GIT_CREDENTIAL_ITEMS: ReadonlyArray<{ key: string; source: AccountGitCredentialSource }> = [
  { key: GITHUB_PAT_VAULT_KEY, source: "pat" },
  { key: GITHUB_CLI_VAULT_KEY, source: "gh" },
];

export type AccountGitCredentialDeps = {
  /**
   * One account-wide `integration` item of the vault (`cloudVaultFromStore`
   * in a brain, `cloudVaultFromBridge` in the desktop), or null when this
   * process has no signed-in account.
   */
  vault: (key: string) => CloudVault | null;
  /** Whether the account's ADE GitHub App sign-in is connected (`accountAppConnection`). Left out: not asked. */
  accountApp?: () => Promise<AccountAppConnection>;
};

export type AccountAppConnection = "connected" | "not_connected" | "unknown";

/**
 * Whether the ADE account's GitHub App sign-in is connected: one status read
 * (`GET /github/app/status`) through the account App client, with the
 * account token. No GitHub token is read or kept. Never throws; anything
 * unclear is `unknown`, and a read that fails is logged.
 */
export async function accountAppConnection(deps: {
  baseUrl: string | null;
  accessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  logger?: { warn?: (event: string, data?: Record<string, unknown>) => void } | null;
}): Promise<AccountAppConnection> {
  if (!deps.baseUrl) return "unknown";
  const client = createAccountAppTokenClient({
    ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
    getAccountAccessToken: async () => await deps.accessToken().catch((error: unknown) => {
      deps.logger?.warn?.("cloud.git_preflight_app_token_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }),
    // A status read only: no cached token, so no account to key one by.
    getAccountUserId: () => null,
    getDirectoryBaseUrl: () => deps.baseUrl,
    store: null,
    holderId: "cloud-git-preflight",
    // Names the client for a sign-in, which this read never starts.
    clientKind: "desktop",
  });
  const answer = await client.status().catch((error: unknown) => {
    deps.logger?.warn?.("cloud.git_preflight_app_status_failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (!answer) return "unknown";
  if (!answer.ok) {
    if (answer.error !== "signed_out") deps.logger?.warn?.("cloud.git_preflight_app_status_failed", { error: answer.error });
    return "unknown";
  }
  if (answer.status.connected && answer.status.state === "active") return "connected";
  return !answer.status.connected || answer.status.state === "needs_reauth" ? "not_connected" : "unknown";
}

const UNREADABLE_MESSAGE = `${BRAND.NAME} couldn't read your account's GitHub sign-in on this computer. ${CONNECT_GITHUB_HINT}`;
const NONE_MESSAGE = `Your ${BRAND.NAME} account has no GitHub sign-in a cloud computer can clone with. ${CONNECT_GITHUB_HINT}`;

/** Whether the account has a credential git can use on a new cloud computer. Never throws. */
async function accountGitCredential(deps: AccountGitCredentialDeps): Promise<AccountGitCredential> {
  const fromVault = await vaultGitCredential(deps);
  if (fromVault.ok || !deps.accountApp) return fromVault;
  // The App's sign-in follows the account too: the computer's git uses its token.
  const app = await deps.accountApp().catch((): AccountAppConnection => "unknown");
  return app === "connected" ? { ok: true, source: "app" } : fromVault;
}

async function vaultGitCredential(deps: AccountGitCredentialDeps): Promise<AccountGitCredential> {
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
    if (decodeAccountGithubToken(read.value)) return { ok: true, source: item.source };
  }
  return unreadable
    ? { ok: false, reason: "unreadable", message: UNREADABLE_MESSAGE }
    : { ok: false, reason: "none", message: NONE_MESSAGE };
}

type RepoVisibility = "public" | "not_visible" | "unknown";

/** The most one visibility question may take. */
const VISIBILITY_TIMEOUT_MS = 8_000;

/**
 * Whether GitHub shows the repository to anyone (one unauthenticated read of
 * `GET /repos/{owner}/{repo}`). `not_visible`: private, or gone; either way
 * a computer with no credential can't clone it. `unknown`: no answer.
 */
async function githubRepoVisibility(
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
  if (!repo) return { ok: true, via: "unknown", warning: `${BRAND.NAME} couldn't check this repository on GitHub.` };
  const visibility = await githubRepoVisibility(repo, deps);
  if (visibility === "public") return { ok: true, via: "public" };
  if (visibility === "not_visible") {
    const name = `${repo.owner}/${repo.repo}`;
    // This computer couldn't read the vault (its background service is down,
    // or the read failed): that is not "no sign-in". The new computer reads
    // the account's vault itself, so the launch goes on and the card warns.
    if (credential.reason === "unreadable") {
      return {
        ok: true,
        via: "unknown",
        warning: `${name} isn't public on GitHub, and ${BRAND.NAME} couldn't read your account's GitHub sign-in on this computer. The new computer reads it itself; if no sign-in follows your account, its clone fails until GitHub is connected in Settings › GitHub.`,
      };
    }
    return {
      ok: false,
      reason: "none",
      message: `${name} isn't public on GitHub, and your ${BRAND.NAME} account has no GitHub sign-in a cloud computer can clone it with. ${CONNECT_GITHUB_HINT}`,
    };
  }
  return {
    ok: true,
    via: "unknown",
    warning: `${BRAND.NAME} couldn't reach GitHub to check ${repo.owner}/${repo.repo}. If it is private, the new computer can't clone it until GitHub is connected in Settings › GitHub.`,
  };
}
