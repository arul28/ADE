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
// Public forges that are never an alias of GitHub: their origins skip ssh.
const KNOWN_FORGE_HOSTS = new Set([
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "ssh.dev.azure.com",
  "vs-ssh.visualstudio.com",
  "git.sr.ht",
]);
// Host and user must not start with "-", so ssh cannot read them as options.
const SAFE_SSH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type SshRemote = {
  user: string | null;
  host: string;
  port: string | null;
  /** The URL with the host replaced by `github.com`. */
  withGithubHost: string;
};

type CacheEntry = SshConfigLookup & { expiresAt: number };

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
    // `host:/org/repo` is the same repository as `host:org/repo`.
    withGithubHost: `${user ? `${user}@` : ""}github.com:${path.replace(/^\/+/, "")}`,
  };
}

function readHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^hostname\s+(\S+)$/i);
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

type SshConfigLookup = {
  hostname: string | null;
  /** The lookup failed (timeout, broken config): retry soon. */
  failed: boolean;
  /** No ssh on PATH: no alias can resolve on this machine for now. */
  missing: boolean;
};

/**
 * No ssh on PATH (a Windows host without the OpenSSH client) is an expected
 * setup: no alias resolves until ssh appears, so it is not reported.
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
      return { hostname: null, failed: !isMissingSsh(error), missing: isMissingSsh(error) };
    }
    return { hostname: readHostname(String(result.stdout ?? "")), failed: false, missing: false };
  } catch (error) {
    captureError(error, { fingerprint: ["github-ssh-alias", "spawn"], tags: { kind: "spawn" } });
    return { hostname: null, failed: true, missing: false };
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
            resolve({ hostname: null, failed: !isMissingSsh(error), missing: isMissingSsh(error) });
            reportLookupFailure(error);
            return;
          }
          resolve({ hostname: readHostname(String(stdout ?? "")), failed: false, missing: false });
        },
      );
    } catch (error) {
      resolve({ hostname: null, failed: true, missing: false });
      captureError(error, { fingerprint: ["github-ssh-alias", "spawn"], tags: { kind: "spawn" } });
    }
  });
}

function cacheKey(remote: SshRemote): string {
  return `${remote.user ?? ""}\u0000${remote.host.toLowerCase()}\u0000${remote.port ?? ""}`;
}

function storeLookup(key: string, result: SshConfigLookup): void {
  const previous = cache.get(key);
  // A failed refresh keeps the last answer, so the repository key does not
  // flip back to the alias while ssh is briefly unable to answer.
  const kept = (result.failed || result.missing) && previous?.hostname
    ? { ...previous, failed: false, missing: false }
    : result;
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
  // Missing ssh retries soon too, so a newly installed ssh is used promptly.
  const retrySoon = result.failed || result.missing;
  cache.set(key, { ...kept, expiresAt: Date.now() + (retrySoon ? FAILED_LOOKUP_TTL_MS : CACHE_TTL_MS) });
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
      // The kept answer: a failed refresh still returns the last good one.
      return cache.get(key)?.hostname ?? result.hostname;
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
  if (isGithubRemoteHost(remote.host) || KNOWN_FORGE_HOSTS.has(remote.host.toLowerCase())) return null;
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
    return { hostname: cached.hostname, failed: cached.failed, missing: cached.missing };
  }
  const result = runSshConfigLookupSync(remote);
  storeLookup(key, result);
  return result;
}

export type CanonicalGitOrigin = {
  /** The origin with an alias host replaced by `github.com`, else the input. */
  url: string | null;
  /**
   * True when ssh could not answer (a failed lookup, or no ssh on PATH), so
   * `url` may still be an unresolved alias.
   */
  lookupFailed: boolean;
};

type CanonicalLookupMode = {
  /**
   * "none" never resolves an alias: for an origin another machine sent. Its
   * host names that machine's ssh config, and the same alias name can point
   * somewhere else here.
   */
  lookup?: "spawn" | "none";
};

/** {@link canonicalGitOriginUrl}, and whether the ssh lookup failed. */
export function resolveCanonicalGitOrigin(
  remoteUrl: string | null | undefined,
  mode: CanonicalLookupMode = {},
): CanonicalGitOrigin {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!value) return { url: null, lookupFailed: false };
  const remote = parseSshRemote(value);
  if (parseGithubRemoteUrl(value)) {
    // GitHub's port-443 host is the same service: one repository, one key.
    const viaSshHost = remote && remote.host.toLowerCase() === "ssh.github.com" && parseGithubRemoteUrl(remote.withGithubHost);
    return { url: viaSshHost ? remote.withGithubHost : value, lookupFailed: false };
  }
  if (
    !remote
    || !SAFE_SSH_TOKEN.test(remote.host)
    || isGithubRemoteHost(remote.host)
    || KNOWN_FORGE_HOSTS.has(remote.host.toLowerCase())
  ) {
    return { url: value, lookupFailed: false };
  }
  if (mode.lookup === "none") return { url: value, lookupFailed: false };
  const lookup = resolveSshHostnameSync(remote);
  if (lookup.hostname && isGithubRemoteHost(lookup.hostname) && parseGithubRemoteUrl(remote.withGithubHost)) {
    return { url: remote.withGithubHost, lookupFailed: false };
  }
  return { url: value, lookupFailed: lookup.failed || lookup.missing };
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

/**
 * The identity of an origin that another machine sent. It never resolves an
 * alias: the host belongs to the sender's ssh config, and a current sender
 * already sends the canonical form. `ssh.github.com` still folds to GitHub.
 */
export function peerGitRemoteIdentity(remoteUrl: string | null | undefined): string | null {
  return normalizeGitRemoteIdentity(resolveCanonicalGitOrigin(remoteUrl, { lookup: "none" }).url);
}

/**
 * True when this machine's origin and an origin from another machine name one
 * repository. The raw comparison keeps an older ADE working: it sends the
 * alias as written, which matches a checkout here that uses the same alias.
 */
export function isSameGitRepository(
  localOrigin: string | null | undefined,
  peerOrigin: string | null | undefined,
): boolean {
  const local = gitRemoteIdentity(localOrigin);
  if (local && local === peerGitRemoteIdentity(peerOrigin)) return true;
  const rawLocal = normalizeGitRemoteIdentity(localOrigin);
  return Boolean(rawLocal && rawLocal === normalizeGitRemoteIdentity(peerOrigin));
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
