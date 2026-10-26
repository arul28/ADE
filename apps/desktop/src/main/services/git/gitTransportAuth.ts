import type { GitHubGitTransportStatus } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { gitCommonDirFor, gitStdoutOrThrow, runGit, runGitOrThrow, type GitRunOptions, type GitRunResult } from "./git";

/**
 * Git transport sign-in for GitHub: push, fetch and pull.
 *
 * ADE's GitHub credential ladder (environment, App, gh, PAT) covers API calls
 * only. Git is a subprocess and signs in with this machine's own credential
 * (keychain, gh's helper, SSH). When that is missing, a push fails with
 * "could not read Username" even though ADE holds a working token. So ADE's
 * pushes and fetches go through {@link runGitWithGithubAuthFallback}:
 * git's own credential first, and on a sign-in failure the same command again
 * with ADE's token, passed through git's config environment and never written
 * anywhere. The outcome is remembered per repository and reported as
 * `GitHubStatus.gitTransport`, which drives the "Git can't sign in" banner.
 */

/** Resolves ADE's GitHub credential for git, or null when it has none. */
export type GitTransportTokenReader = () => Promise<string | null | undefined>;

/**
 * The reader every remote git call falls back to. ADE's GitHub credentials
 * (environment, gh, the stored PAT) belong to the machine, not to a project,
 * so one reader serves every repository in this process. Each GitHub service
 * registers its own when it is built; any of them gives the same answer.
 */
let registeredTokenReader: GitTransportTokenReader | null = null;
let transportLogger: Logger | null = null;

export function setGitTransportTokenReader(reader: GitTransportTokenReader | null, logger?: Logger | null): void {
  registeredTokenReader = reader;
  if (logger !== undefined) transportLogger = logger;
}

/** Fallback options: `readToken` overrides the registered reader; `null` turns the fallback off. */
export type GitAuthFallbackOptions = GitRunOptions & { readToken?: GitTransportTokenReader | null };

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
  const env: NodeJS.ProcessEnv = { ...GIT_HEADLESS_PROMPT_ENV, GCM_INTERACTIVE: "Never" };
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

/**
 * No prompt of any kind. `GIT_TERMINAL_PROMPT=0` stops only the terminal one;
 * an askpass helper ADE inherited (an editor's, a GUI's) would still open, and
 * git would wait on it until the time limit. Git skips askpass when the
 * variable is set but empty.
 */
const GIT_HEADLESS_PROMPT_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** Git had no credential, or GitHub rejected the one it sent. */
const GIT_SIGN_IN_FAILURE_PATTERNS = [
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /authentication failed/i,
  /invalid username or (password|token)/i,
  /the requested url returned error: 401/i,
  /support for password authentication was removed/i,
];

/**
 * Git signed in, but that account may not write here (a clone of someone
 * else's repository). Worth retrying with ADE's credential, which may be a
 * different account; never reported as "can't sign in", because pulls work.
 */
const GIT_ACCESS_DENIED_PATTERNS = [
  /permission to \S+ denied/i,
  /the requested url returned error: 403/i,
];

/** True when git's output says it could not sign in, as opposed to any other failure. */
export function isGitAuthFailure(output: string): boolean {
  return GIT_SIGN_IN_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function isGitAccessDenied(output: string): boolean {
  return GIT_ACCESS_DENIED_PATTERNS.some((pattern) => pattern.test(output));
}

function resultOutput(result: GitRunResult): string {
  return `${result.stderr}\n${result.stdout}`;
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
/** How long a check is trusted: long while healthy (or unknowable), short while broken. */
const PROBE_OK_TTL_MS = 10 * 60_000;
const PROBE_FAILED_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
/** How long a status read waits on a running check before answering with the last known state. */
const PROBE_STATUS_WAIT_MS = 4_000;
/** How long the origin's push URL is remembered; it rarely changes. */
const ORIGIN_TTL_MS = 10 * 60_000;

type RepoTransportRecord = {
  status: GitHubGitTransportStatus | null;
  recordedAtMs: number;
  /** When git's own credential last failed to sign in, so the next command can go straight to ADE's. */
  systemFailedAtMs: number | null;
  /** When the last check ran, whatever it found, so a repo ADE cannot check is not re-checked on every read. */
  checkedAtMs: number;
  /** Whether origin pushes to https GitHub, the only remote ADE's token can sign in to. */
  githubOrigin: boolean | null;
  /** The same for origin's fetch URL, which can differ (https fetch, SSH push). */
  githubFetchOrigin: boolean | null;
  githubOriginCheckedAtMs: number;
};

const records = new Map<string, RepoTransportRecord>();
const probesInFlight = new Map<string, Promise<GitHubGitTransportStatus | null>>();

async function repoKey(cwd: string): Promise<string> {
  return (await gitCommonDirFor(cwd).catch(() => "")) || cwd;
}

function record(key: string, patch: Partial<RepoTransportRecord>): void {
  const previous = records.get(key) ?? {
    status: null,
    recordedAtMs: 0,
    systemFailedAtMs: null,
    checkedAtMs: 0,
    githubOrigin: null,
    githubFetchOrigin: null,
    githubOriginCheckedAtMs: 0,
  };
  records.set(key, { ...previous, ...patch });
}

function statusFor(state: GitHubGitTransportStatus["state"], via: GitHubGitTransportStatus["via"], adeCredentialTried: boolean): GitHubGitTransportStatus {
  return { state, via, adeCredentialTried, checkedAt: new Date().toISOString() };
}

/**
 * Whether `origin` talks to https GitHub for this command, cached per
 * repository. A push uses origin's push URL and everything else its fetch URL:
 * an https-fetch / SSH-push setup takes ADE's token for fetches only.
 */
async function originIsGithubHttps(key: string, cwd: string, direction: "push" | "fetch"): Promise<boolean> {
  const cached = records.get(key);
  if (
    cached?.githubOrigin != null
    && cached.githubFetchOrigin != null
    && Date.now() - cached.githubOriginCheckedAtMs < ORIGIN_TTL_MS
  ) {
    return direction === "push" ? cached.githubOrigin : cached.githubFetchOrigin;
  }
  const [pushUrl, fetchUrl] = await Promise.all([
    runGit(["remote", "get-url", "--push", "origin"], { cwd, timeoutMs: 5_000 }),
    // `ls-remote --get-url` prints the fetch URL (insteadOf applied) without
    // touching the network.
    runGit(["ls-remote", "--get-url", "origin"], { cwd, timeoutMs: 5_000 }),
  ]);
  const githubOrigin = pushUrl.exitCode === 0 && isGithubHttpsRemote(pushUrl.stdout);
  const githubFetchOrigin = fetchUrl.exitCode === 0 && isGithubHttpsRemote(fetchUrl.stdout);
  record(key, { githubOrigin, githubFetchOrigin, githubOriginCheckedAtMs: Date.now() });
  return direction === "push" ? githubOrigin : githubFetchOrigin;
}

function commandDirection(args: string[]): "push" | "fetch" {
  return args[0] === "push" ? "push" : "fetch";
}

async function readTokenSafely(readToken: GitTransportTokenReader): Promise<string> {
  try {
    return (await readToken())?.trim() ?? "";
  } catch (error) {
    transportLogger?.warn("git.transport_token_read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

function withTokenEnv(opts: GitRunOptions, token: string): GitRunOptions {
  return { ...opts, env: { ...(opts.env ?? {}), ...githubExtraHeaderGitEnv(token) } };
}

/**
 * Runs a git command that talks to the remote. Git's own credential goes
 * first, so a machine that signs in on its own is never changed. On a sign-in
 * failure (or an access denial, which ADE's credential may get past) the
 * command runs once more with ADE's GitHub token, and after a sign-in failure
 * the next ten minutes go straight to the token. Only for an https GitHub
 * origin; anything else runs as plain `runGit`. Other failures are returned
 * untouched. The caller treats the result exactly like `runGit`'s.
 */
export async function runGitWithGithubAuthFallback(
  args: string[],
  opts: GitAuthFallbackOptions,
): Promise<GitRunResult> {
  const { readToken: explicitReader, ...runOpts } = opts;
  const readToken = explicitReader === undefined ? registeredTokenReader : explicitReader;
  if (!readToken) return await runGit(args, runOpts);
  const key = await repoKey(runOpts.cwd);
  if (!(await originIsGithubHttps(key, runOpts.cwd, commandDirection(args)))) return await runGit(args, runOpts);

  // Set when ADE's token already failed to sign in during this call, so it is
  // not run a second time below.
  let refusedTokenResult: GitRunResult | null = null;
  const systemFailedAtMs = records.get(key)?.systemFailedAtMs ?? null;
  if (systemFailedAtMs != null && Date.now() - systemFailedAtMs < SYSTEM_CREDENTIAL_FAILED_TTL_MS) {
    const token = await readTokenSafely(readToken);
    if (token) {
      const result = await runGit(args, withTokenEnv(runOpts, token));
      if (!isGitAuthFailure(resultOutput(result))) {
        recordOutcome(key, result, "ade", true);
        return result;
      }
      // ADE's token failed too; git's own sign-in may have been fixed since,
      // so fall through and give it another try.
      refusedTokenResult = result;
      record(key, { systemFailedAtMs: null });
    }
  }

  const first = await runGit(args, runOpts);
  const firstOutput = resultOutput(first);
  const signInFailed = isGitAuthFailure(firstOutput);
  if (first.exitCode === 0 || first.timedOut || first.cancelled || (!signInFailed && !isGitAccessDenied(firstOutput))) {
    recordOutcome(key, first, "system", false);
    return first;
  }
  if (signInFailed) record(key, { systemFailedAtMs: Date.now() });
  if (refusedTokenResult) {
    if (!signInFailed) {
      // Git's own sign-in works now and was only denied; ADE's refused token
      // says nothing about this machine signing in.
      recordOutcome(key, first, "system", false);
      return first;
    }
    recordOutcome(key, refusedTokenResult, "ade", true);
    return refusedTokenResult;
  }
  const token = await readTokenSafely(readToken);
  if (!token) {
    recordOutcome(key, first, "system", false);
    return first;
  }
  const retried = await runGit(args, withTokenEnv(runOpts, token));
  transportLogger?.info("git.transport_ade_credential_used", {
    command: args[0] ?? null,
    reason: signInFailed ? "sign_in_failed" : "access_denied",
    succeeded: retried.exitCode === 0,
  });
  if (!signInFailed && !retried.timedOut && !retried.cancelled && isGitAuthFailure(resultOutput(retried))) {
    // Git signed in and was denied; only ADE's token is broken. The denial is
    // the answer, and it is not a "can't sign in".
    recordOutcome(key, first, "system", false);
    return first;
  }
  recordOutcome(key, retried, "ade", true);
  return retried;
}

/** {@link runGitWithGithubAuthFallback} with `runGitOrThrow`'s errors. */
export async function runGitWithGithubAuthFallbackOrThrow(
  args: string[],
  opts: GitAuthFallbackOptions,
): Promise<string> {
  const { readToken: explicitReader, ...runOpts } = opts;
  if ((explicitReader === undefined ? registeredTokenReader : explicitReader) == null) {
    return await runGitOrThrow(args, runOpts);
  }
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
  if (isGitAuthFailure(resultOutput(result))) {
    record(key, { status: statusFor("auth_failed", null, adeCredentialTried), recordedAtMs: Date.now() });
  }
  // Any other failure (rejected, denied, no network) says nothing about sign-in.
}

/** The dry-run push behind a status check: HEAD to a branch that is never created. */
async function probeGitTransport(
  key: string,
  projectRoot: string,
  readToken: GitTransportTokenReader | null | undefined,
  forceRefresh: boolean,
): Promise<GitHubGitTransportStatus | null> {
  record(key, { checkedAtMs: Date.now(), ...(forceRefresh ? { githubOriginCheckedAtMs: 0 } : {}) });
  if (!(await originIsGithubHttps(key, projectRoot, "push"))) {
    record(key, { status: null });
    return null;
  }
  if (forceRefresh) record(key, { systemFailedAtMs: null });
  // `--dry-run` sends nothing and `--no-verify` skips the user's pre-push
  // hook. A background check must never open a sign-in window (Git Credential
  // Manager or an askpass helper would); a person's own push still may.
  await runGitWithGithubAuthFallback(
    ["push", "--dry-run", "--no-verify", "--porcelain", "origin", "HEAD:refs/heads/ade-push-sign-in-check"],
    { cwd: projectRoot, timeoutMs: PROBE_TIMEOUT_MS, env: { ...GIT_HEADLESS_PROMPT_ENV, GCM_INTERACTIVE: "Never" }, readToken: readToken ?? null },
  );
  // The run recorded its outcome. A non-auth failure (no network, no commits
  // yet) recorded nothing, which leaves the last known answer in place.
  return records.get(key)?.status ?? null;
}

/**
 * A status read should not wait on the network for long: past the cap the
 * last known answer goes back now and the check finishes in the background
 * for the next read.
 */
async function waitForProbe(
  probe: Promise<GitHubGitTransportStatus | null>,
  lastKnown: GitHubGitTransportStatus | null,
): Promise<GitHubGitTransportStatus | null> {
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
}

/**
 * Whether git can sign in to push to this project's GitHub origin, from the
 * last real push/fetch/pull or, when that is stale, a dry-run push. Cached per
 * repository: ten minutes while healthy, two while broken, so the banner
 * clears soon after a fix, and at once when a credential appears. "Check
 * again" (`forceRefresh`) waits for the real answer.
 *
 * Null when ADE cannot say: no origin, an SSH or non-GitHub origin (ADE's
 * token cannot help there and SSH may block on a passphrase), or a check that
 * failed for a reason other than sign-in.
 */
export async function readGitTransportStatus(
  projectRoot: string,
  readToken: GitTransportTokenReader | null | undefined,
  opts: { forceRefresh?: boolean } = {},
): Promise<GitHubGitTransportStatus | null> {
  const key = await repoKey(projectRoot);
  const cached = records.get(key);
  if (!opts.forceRefresh && cached && cached.checkedAtMs > 0) {
    if (cached.githubOrigin === false && Date.now() - cached.githubOriginCheckedAtMs < ORIGIN_TTL_MS) return null;
    const ttl = cached.status?.state === "auth_failed" ? PROBE_FAILED_TTL_MS : PROBE_OK_TTL_MS;
    const fresh = Date.now() - Math.max(cached.recordedAtMs, cached.checkedAtMs) < ttl;
    // A failure from before ADE had a credential to try is stale the moment
    // one appears (a PAT just saved), so check again rather than wait it out.
    const credentialAppeared = cached.status?.state === "auth_failed"
      && !cached.status.adeCredentialTried
      && readToken != null
      && Boolean(await readTokenSafely(readToken));
    if (fresh && !credentialAppeared) return cached.status;
  }
  const lastKnown = cached?.status ?? null;
  let probe = probesInFlight.get(key);
  if (!probe) {
    const started = probeGitTransport(key, projectRoot, readToken, opts.forceRefresh === true).finally(() => {
      if (probesInFlight.get(key) === started) probesInFlight.delete(key);
    });
    probesInFlight.set(key, started);
    probe = started;
  }
  return opts.forceRefresh ? await probe : await waitForProbe(probe, lastKnown);
}
