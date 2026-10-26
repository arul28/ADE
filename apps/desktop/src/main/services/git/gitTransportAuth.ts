import type { GitHubGitTransportStatus } from "../../../shared/types";
import { gitCommonDirFor, gitStdoutOrThrow, runGit, runGitOrThrow, type GitRunOptions, type GitRunResult } from "./git";

/**
 * Git transport sign-in for GitHub: push, fetch and pull.
 *
 * ADE's GitHub credential ladder (environment, App, gh, PAT) covers API calls
 * only. Git is a subprocess and signs in with this machine's own credential
 * (keychain, gh's helper, SSH). When that is missing, a push fails with
 * "could not read Username" even though ADE holds a working token. So every
 * ADE push, fetch and pull goes through {@link runGitWithGithubAuthFallback}:
 * git's own credential first, and on a sign-in failure the same command again
 * with ADE's token, passed through git's config environment and never written
 * anywhere. The outcome is remembered per repository and reported as
 * `GitHubStatus.gitTransport`, which drives the "Git can't sign in" banner.
 */

/** Resolves ADE's GitHub credential for git, or null when it has none. */
export type GitTransportTokenReader = () => Promise<string | null | undefined>;

/**
 * Git environment for a headless fetch or push to GitHub with ADE's own token:
 * prompts off, and the token as an extraheader through Git's config
 * environment, so it stays out of command arguments, remote URLs and anything
 * persisted. extraheader is multi-valued: the empty entry first resets any
 * header a clone left in .git/config, so GitHub never sees two Authorization
 * headers ("Duplicate header"). Without a token, a credential helper may still
 * authorize Git, and a missing one fails clearly instead of hanging.
 */
export function githubExtraHeaderGitEnv(token: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  const trimmed = token?.trim();
  if (!trimmed) return env;
  const basic = Buffer.from(`x-access-token:${trimmed}`, "utf8").toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

const GIT_AUTH_FAILURE_PATTERNS = [
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /authentication failed/i,
  /invalid username or (password|token)/i,
  /permission to \S+ denied/i,
  /the requested url returned error: (401|403)/i,
  /support for password authentication was removed/i,
];

/** True when git's output says it could not sign in, as opposed to any other failure. */
export function isGitAuthFailure(output: string): boolean {
  return GIT_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

/** Only an https GitHub remote can take ADE's token; SSH signs in with keys. */
export function isGithubHttpsRemote(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** How long a known-broken machine credential is skipped before git's own is tried again. */
const SYSTEM_CREDENTIAL_FAILED_TTL_MS = 10 * 60_000;
/** How long a probe result is trusted: long while healthy, short while broken. */
const PROBE_OK_TTL_MS = 10 * 60_000;
const PROBE_FAILED_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
/** How long a status read waits on a running check before answering with the last known state. */
const PROBE_STATUS_WAIT_MS = 4_000;

type RepoTransportRecord = {
  status: GitHubGitTransportStatus | null;
  recordedAtMs: number;
  /** When git's own credential last failed to sign in, so the next command can go straight to ADE's. */
  systemFailedAtMs: number | null;
  /** When the last check ran, whatever it found, so a repo ADE cannot check is not re-checked on every read. */
  checkedAtMs: number;
};

const records = new Map<string, RepoTransportRecord>();
const probesInFlight = new Map<string, Promise<GitHubGitTransportStatus | null>>();

async function repoKey(cwd: string): Promise<string> {
  return (await gitCommonDirFor(cwd).catch(() => "")) || cwd;
}

function record(key: string, patch: Partial<RepoTransportRecord>): void {
  const previous = records.get(key) ?? { status: null, recordedAtMs: 0, systemFailedAtMs: null, checkedAtMs: 0 };
  records.set(key, { ...previous, ...patch });
}

function statusFor(state: GitHubGitTransportStatus["state"], via: GitHubGitTransportStatus["via"], adeCredentialTried: boolean): GitHubGitTransportStatus {
  return { state, via, adeCredentialTried, checkedAt: new Date().toISOString() };
}

/**
 * Runs a git command that talks to the remote. Git's own credential goes
 * first, so a machine that signs in on its own is never changed. On a sign-in
 * failure the command runs once more with ADE's GitHub token, and after that
 * failure the next ten minutes go straight to the token. Non-auth failures are
 * returned untouched. The caller treats the result exactly like `runGit`'s.
 */
export async function runGitWithGithubAuthFallback(
  args: string[],
  opts: GitRunOptions & { readToken?: GitTransportTokenReader | null },
): Promise<GitRunResult> {
  const { readToken, ...runOpts } = opts;
  if (!readToken) return await runGit(args, runOpts);
  const key = await repoKey(runOpts.cwd);
  const readTokenSafely = async (): Promise<string> => {
    try {
      return (await readToken())?.trim() ?? "";
    } catch {
      return "";
    }
  };
  const withToken = (token: string): GitRunOptions => ({
    ...runOpts,
    env: { ...(runOpts.env ?? {}), ...githubExtraHeaderGitEnv(token) },
  });

  const systemFailedAtMs = records.get(key)?.systemFailedAtMs ?? null;
  if (systemFailedAtMs != null && Date.now() - systemFailedAtMs < SYSTEM_CREDENTIAL_FAILED_TTL_MS) {
    const token = await readTokenSafely();
    if (token) {
      const result = await runGit(args, withToken(token));
      recordOutcome(key, result, "ade", true);
      return result;
    }
  }

  const first = await runGit(args, runOpts);
  const firstOutput = `${first.stderr}\n${first.stdout}`;
  if (first.exitCode === 0 || first.timedOut || first.cancelled || !isGitAuthFailure(firstOutput)) {
    recordOutcome(key, first, "system", false);
    return first;
  }
  record(key, { systemFailedAtMs: Date.now() });
  const token = await readTokenSafely();
  if (!token) {
    recordOutcome(key, first, "system", false);
    return first;
  }
  const retried = await runGit(args, withToken(token));
  recordOutcome(key, retried, "ade", true);
  return retried;
}

/** {@link runGitWithGithubAuthFallback} with `runGitOrThrow`'s errors. */
export async function runGitWithGithubAuthFallbackOrThrow(
  args: string[],
  opts: GitRunOptions & { readToken?: GitTransportTokenReader | null },
): Promise<string> {
  const { readToken, ...runOpts } = opts;
  if (!readToken) return await runGitOrThrow(args, runOpts);
  return gitStdoutOrThrow(await runGitWithGithubAuthFallback(args, opts), args, runOpts);
}

function recordOutcome(key: string, result: GitRunResult, via: "system" | "ade", adeCredentialTried: boolean): void {
  if (result.timedOut || result.cancelled) return;
  if (result.exitCode === 0) {
    record(key, {
      status: statusFor("ok", via, adeCredentialTried),
      recordedAtMs: Date.now(),
      ...(via === "system" ? { systemFailedAtMs: null } : {}),
    });
    return;
  }
  if (isGitAuthFailure(`${result.stderr}\n${result.stdout}`)) {
    record(key, { status: statusFor("auth_failed", null, adeCredentialTried), recordedAtMs: Date.now() });
  }
  // Any other failure (rejected, no network) says nothing about sign-in.
}

/**
 * Whether git can sign in to push to this project's GitHub origin, from the
 * last real push/fetch/pull or, when that is stale, a dry-run push of HEAD to a
 * branch name that is never created (`--dry-run` sends nothing, `--no-verify`
 * skips the user's pre-push hook). Cached per repository: ten minutes while
 * healthy, two while broken, so the banner clears soon after a fix.
 *
 * Null when ADE cannot say: no origin, an SSH or non-GitHub origin (ADE's
 * token cannot help there and SSH may block on a passphrase), or a probe that
 * failed for a reason other than sign-in.
 */
export async function readGitTransportStatus(
  projectRoot: string,
  readToken: GitTransportTokenReader | null | undefined,
  opts: { forceRefresh?: boolean } = {},
): Promise<GitHubGitTransportStatus | null> {
  const key = await repoKey(projectRoot);
  const cached = records.get(key);
  if (!opts.forceRefresh && cached) {
    const ttl = cached.status?.state === "ok" ? PROBE_OK_TTL_MS : PROBE_FAILED_TTL_MS;
    const fresh = Date.now() - Math.max(cached.recordedAtMs, cached.checkedAtMs) < ttl;
    // A failure from before ADE had a credential to try is stale the moment
    // one appears (a PAT just saved), so check again rather than wait it out.
    const credentialAppeared = cached.status?.state === "auth_failed"
      && !cached.status.adeCredentialTried
      && Boolean((await readToken?.().catch(() => null))?.trim());
    if (fresh && !credentialAppeared) return cached.status;
  }
  const lastKnown = cached?.status ?? null;
  // Status reads should not wait on the network for long: past the cap the
  // last known answer goes back now and the check finishes in the background
  // for the next read. "Check again" waits for the real answer.
  const waitFor = async (probe: Promise<GitHubGitTransportStatus | null>) => {
    if (opts.forceRefresh) return await probe;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<GitHubGitTransportStatus | null>((resolve) => {
      timer = setTimeout(() => resolve(lastKnown), PROBE_STATUS_WAIT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([probe, cap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const inFlight = probesInFlight.get(key);
  if (inFlight) return await waitFor(inFlight);
  const probe = (async (): Promise<GitHubGitTransportStatus | null> => {
    record(key, { checkedAtMs: Date.now() });
    const origin = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 5_000 });
    if (origin.exitCode !== 0 || !isGithubHttpsRemote(origin.stdout)) return null;
    if (opts.forceRefresh) record(key, { systemFailedAtMs: null });
    // A background check must never open a sign-in window (Git Credential
    // Manager would); a person's own push still may.
    await runGitWithGithubAuthFallback(
      ["push", "--dry-run", "--no-verify", "--porcelain", "origin", "HEAD:refs/heads/ade-push-sign-in-check"],
      { cwd: projectRoot, timeoutMs: PROBE_TIMEOUT_MS, env: { GCM_INTERACTIVE: "Never" }, readToken },
    );
    // The run recorded its outcome. A non-auth failure (no network, no commits
    // yet) recorded nothing, which leaves the last known answer in place.
    return records.get(key)?.status ?? null;
  })().finally(() => {
    if (probesInFlight.get(key) === probe) probesInFlight.delete(key);
  });
  probesInFlight.set(key, probe);
  return await waitFor(probe);
}
