import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { captureError, captureProblem } from "../../../shared/sentry/capture";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import {
  githubRepoRefFromSlug,
  isGithubRemoteHost,
  parseGithubRemoteUrl,
  type GithubRepoSlug,
} from "../../../shared/githubRemote";
import type { GitHubRepoRef } from "../../../shared/types/git";

/**
 * Resolves SSH host aliases that point at GitHub.
 *
 * People with two GitHub accounts often clone through an `~/.ssh/config`
 * alias (`Host github.com-work` with `HostName github.com`), so origin reads
 * `git@github.com-work:org/repo.git`. Git pushes and fetches through the alias
 * fine, but the URL alone does not say the repository is on GitHub. `ssh -G`
 * prints the configuration ssh would use for the host, including the real
 * `hostname`, without opening a connection.
 *
 * This runs in the process that owns the repository (desktop main for a local
 * project, the brain for a runtime-bound or remote one), because the alias
 * lives in that machine's ssh config.
 */

const SSH_CONFIG_TIMEOUT_MS = 3_000;
// The synchronous lookup blocks its process, so it gets a shorter limit. It
// runs once for each alias host; later reads use the cache.
const SSH_CONFIG_SYNC_TIMEOUT_MS = 1_500;
const SSH_CONFIG_MAX_OUTPUT_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60_000;
// A failed lookup (timeout, broken config) is retried sooner than an answer.
const FAILED_LOOKUP_TTL_MS = 10_000;
const CACHE_CAPACITY = 128;
// Host and user must not start with "-", so ssh cannot read them as options.
const SAFE_SSH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type SshRemote = {
  user: string | null;
  host: string;
  port: string | null;
  /** The URL with the host replaced by `github.com`. */
  withGithubHost: string;
};

type CacheEntry = { hostname: string | null; failed: boolean; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();

function parseSshRemote(remoteUrl: string): SshRemote | null {
  const value = remoteUrl.trim();
  if (/^ssh:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!url.hostname) return null;
    const rest = `${url.pathname}${url.search}${url.hash}`;
    const userPart = url.username ? `${url.username}@` : "";
    return {
      // Left percent-encoded: an encoded user fails SAFE_SSH_TOKEN and is not
      // passed to ssh, which is the same lookup ssh would make without it.
      user: url.username || null,
      host: url.hostname,
      port: url.port || null,
      // GitHub serves SSH on port 22 at github.com; the alias's port belonged to
      // the alias, so the canonical form drops it.
      withGithubHost: `ssh://${userPart}github.com${rest}`,
    };
  }
  // scp-like `[user@]host:path`. Git treats a one-letter "host" as a Windows
  // drive (`C:/repo`) and anything with a slash before the colon as a path.
  const scp = value.match(/^(?:([^@/:]+)@)?([^@/:]+):(?!\/\/)(.+)$/);
  if (!scp) return null;
  const [, user, host, path] = scp;
  if (!host || host.length < 2 || !path) return null;
  return {
    user: user ?? null,
    host,
    port: null,
    withGithubHost: `${user ? `${user}@` : ""}github.com:${path}`,
  };
}

function readHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^hostname\s+(\S+)$/i);
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

type SshConfigLookup = { hostname: string | null; failed: boolean };

/**
 * No ssh on PATH (a Windows host without the OpenSSH client) is an expected
 * setup and a final answer: no alias can resolve on this machine.
 */
function isMissingSsh(error: { code?: unknown } | null | undefined): boolean {
  return error?.code === "ENOENT";
}

function reportLookupFailure(error: { code?: unknown; killed?: boolean }, timedOut = Boolean(error.killed)): void {
  if (isMissingSsh(error)) return;
  const kind = timedOut ? "timeout" : "failed";
  captureProblem(`ssh -G lookup for a git remote alias ${kind}`, {
    fingerprint: ["github-ssh-alias", kind],
    tags: { kind },
    extra: { code: typeof error.code === "string" ? error.code : null, platform: process.platform },
    level: "warning",
  });
}

function sshConfigArgs(remote: SshRemote): string[] {
  const args = ["-G"];
  if (remote.user && SAFE_SSH_TOKEN.test(remote.user)) args.push("-l", remote.user);
  if (remote.port && /^\d+$/.test(remote.port)) args.push("-p", remote.port);
  args.push(remote.host);
  return args;
}

function runSshConfigLookupSync(remote: SshRemote): SshConfigLookup {
  try {
    const result = spawnSync("ssh", sshConfigArgs(remote), {
      timeout: SSH_CONFIG_SYNC_TIMEOUT_MS,
      maxBuffer: SSH_CONFIG_MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) {
      const error = (result.error ?? {}) as { code?: unknown };
      const timedOut = (result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT" || result.signal != null;
      reportLookupFailure(error, timedOut);
      return { hostname: null, failed: !isMissingSsh(error) };
    }
    return { hostname: readHostname(String(result.stdout ?? "")), failed: false };
  } catch (error) {
    captureError(error, { fingerprint: ["github-ssh-alias", "spawn"], tags: { kind: "spawn" } });
    return { hostname: null, failed: true };
  }
}

function runSshConfigLookup(remote: SshRemote): Promise<SshConfigLookup> {
  const args = sshConfigArgs(remote);
  return new Promise((resolve) => {
    try {
      execFile(
        "ssh",
        args,
        {
          timeout: SSH_CONFIG_TIMEOUT_MS,
          maxBuffer: SSH_CONFIG_MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          // The alias stays unresolved and the remote is treated as not
          // GitHub, as before ADE read ssh config.
          if (error) {
            resolve({ hostname: null, failed: !isMissingSsh(error) });
            reportLookupFailure(error);
            return;
          }
          resolve({ hostname: readHostname(String(stdout ?? "")), failed: false });
        },
      );
    } catch (error) {
      resolve({ hostname: null, failed: true });
      captureError(error, { fingerprint: ["github-ssh-alias", "spawn"], tags: { kind: "spawn" } });
    }
  });
}

function cacheKey(remote: SshRemote): string {
  return `${remote.user ?? ""}\u0000${remote.host.toLowerCase()}\u0000${remote.port ?? ""}`;
}

function storeLookup(key: string, { hostname, failed }: SshConfigLookup): void {
  cache.delete(key);
  if (cache.size >= CACHE_CAPACITY) {
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(entryKey);
    }
  }
  if (cache.size >= CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { hostname, failed, expiresAt: Date.now() + (failed ? FAILED_LOOKUP_TTL_MS : CACHE_TTL_MS) });
}

function resolveSshHostname(remote: SshRemote): Promise<string | null> {
  const key = cacheKey(remote);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.hostname);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const lookup = runSshConfigLookup(remote)
    .then((result) => {
      storeLookup(key, result);
      return result.hostname;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, lookup);
  return lookup;
}

/**
 * The remote URL with its host replaced by `github.com` when it is an SSH
 * alias whose ssh config `HostName` is GitHub, or null when it is not one.
 * A URL that already names GitHub returns null: there is nothing to resolve.
 */
export async function resolveGithubSshAliasUrl(remoteUrl: string | null | undefined): Promise<string | null> {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!value || parseGithubRemoteUrl(value)) return null;
  const remote = parseSshRemote(value);
  if (!remote || !SAFE_SSH_TOKEN.test(remote.host)) return null;
  if (isGithubRemoteHost(remote.host)) return null;
  const hostname = await resolveSshHostname(remote);
  if (!hostname || !isGithubRemoteHost(hostname)) return null;
  return parseGithubRemoteUrl(remote.withGithubHost) ? remote.withGithubHost : null;
}

/**
 * The synchronous form of the alias lookup, for code that reads an origin on
 * a synchronous path (recent projects, the project registry, account scope
 * keys). An expired entry is still used while a background lookup refreshes
 * it, so only the first read of an alias host waits for ssh.
 */
function resolveSshHostnameSync(remote: SshRemote): SshConfigLookup {
  const key = cacheKey(remote);
  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt <= Date.now() && !inFlight.has(key)) void resolveSshHostname(remote);
    return { hostname: cached.hostname, failed: cached.failed };
  }
  const result = runSshConfigLookupSync(remote);
  storeLookup(key, result);
  return result;
}

export type CanonicalGitOrigin = {
  /** The origin with an alias host replaced by `github.com`, else the input. */
  url: string | null;
  /** True when the ssh lookup failed, so `url` may still be an unresolved alias. */
  lookupFailed: boolean;
};

/** {@link canonicalGitOriginUrl}, and whether the ssh lookup failed. */
export function resolveCanonicalGitOrigin(remoteUrl: string | null | undefined): CanonicalGitOrigin {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!value) return { url: null, lookupFailed: false };
  if (parseGithubRemoteUrl(value)) return { url: value, lookupFailed: false };
  const remote = parseSshRemote(value);
  if (!remote || !SAFE_SSH_TOKEN.test(remote.host) || isGithubRemoteHost(remote.host)) {
    return { url: value, lookupFailed: false };
  }
  const { hostname, failed } = resolveSshHostnameSync(remote);
  if (hostname && isGithubRemoteHost(hostname) && parseGithubRemoteUrl(remote.withGithubHost)) {
    return { url: remote.withGithubHost, lookupFailed: false };
  }
  return { url: value, lookupFailed: failed };
}

/**
 * The origin URL that names the repository, for identity and display: an SSH
 * alias of GitHub becomes its `github.com` form, and every other value comes
 * back unchanged. Two checkouts of one GitHub repository then get the same
 * repository key (`normalizeGitRemoteIdentity`) whether origin goes through
 * `github.com-work` or `https://github.com`.
 *
 * Run it on the machine that owns the checkout, where the alias is defined.
 * Do not give the result to git as a remote: git on this machine needs the
 * alias to pick the right SSH key.
 */
export function canonicalGitOriginUrl(remoteUrl: string | null | undefined): string | null {
  return resolveCanonicalGitOrigin(remoteUrl).url;
}

/**
 * `normalizeGitRemoteIdentity` of the canonical origin. Main-process and brain
 * code that compares repositories uses this; renderer code gets origins that
 * the owning machine already made canonical.
 */
export function gitRemoteIdentity(remoteUrl: string | null | undefined): string | null {
  return normalizeGitRemoteIdentity(canonicalGitOriginUrl(remoteUrl));
}

/** `parseGithubRemoteUrl`, plus SSH aliases that resolve to GitHub. */
export async function resolveGithubRemoteRepo(remoteUrl: string | null | undefined): Promise<GithubRepoSlug | null> {
  const direct = parseGithubRemoteUrl(remoteUrl);
  if (direct) return direct;
  const aliased = await resolveGithubSshAliasUrl(remoteUrl);
  return aliased ? parseGithubRemoteUrl(aliased) : null;
}

/** `resolveGithubRemoteRepo` in the `{ owner, name }` shape GitHub API code uses. */
export async function resolveGithubRepoRef(remoteUrl: string | null | undefined): Promise<GitHubRepoRef | null> {
  return githubRepoRefFromSlug(await resolveGithubRemoteRepo(remoteUrl));
}
