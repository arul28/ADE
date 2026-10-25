import { execFile } from "node:child_process";
import { captureError, captureProblem } from "../../../shared/sentry/capture";
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

type CacheEntry = { hostname: string | null; expiresAt: number };

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

function reportLookupFailure(error: NodeJS.ErrnoException & { killed?: boolean }): void {
  // No ssh on PATH (a Windows host without the OpenSSH client) is an expected
  // setup: the alias stays unresolved, as it was before ADE read ssh config.
  if (error.code === "ENOENT") return;
  const kind = error.killed ? "timeout" : "failed";
  captureProblem(`ssh -G lookup for a git remote alias ${kind}`, {
    fingerprint: ["github-ssh-alias", kind],
    tags: { kind },
    extra: { code: typeof error.code === "string" ? error.code : null, platform: process.platform },
    level: "warning",
  });
}

function runSshConfigLookup(remote: SshRemote): Promise<SshConfigLookup> {
  const args = ["-G"];
  if (remote.user && SAFE_SSH_TOKEN.test(remote.user)) args.push("-l", remote.user);
  if (remote.port && /^\d+$/.test(remote.port)) args.push("-p", remote.port);
  args.push(remote.host);
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
            reportLookupFailure(error);
            resolve({ hostname: null, failed: true });
            return;
          }
          resolve({ hostname: readHostname(String(stdout ?? "")), failed: false });
        },
      );
    } catch (error) {
      captureError(error, { fingerprint: ["github-ssh-alias", "spawn"], tags: { kind: "spawn" } });
      resolve({ hostname: null, failed: true });
    }
  });
}

async function resolveSshHostname(remote: SshRemote): Promise<string | null> {
  const key = `${remote.user ?? ""}\u0000${remote.host.toLowerCase()}\u0000${remote.port ?? ""}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.hostname;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const lookup = runSshConfigLookup(remote)
    .then(({ hostname, failed }) => {
      for (const [entryKey, entry] of cache) {
        if (entry.expiresAt <= Date.now()) cache.delete(entryKey);
      }
      if (cache.size >= CACHE_CAPACITY) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { hostname, expiresAt: Date.now() + (failed ? FAILED_LOOKUP_TTL_MS : CACHE_TTL_MS) });
      return hostname;
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
