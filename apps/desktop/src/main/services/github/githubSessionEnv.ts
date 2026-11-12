import fs from "node:fs";
import path from "node:path";
import { ghConfigDir } from "../../../../../ade-cli/src/services/credentials/ghConfigDir";
import type { AppGrantReader } from "../../../shared/github/githubAppGrant";
import { githubShellShimEnv, setGithubShellTokenAnswer } from "./githubShellShim";

/**
 * `GH_TOKEN` for the `gh` CLI in agent shells, CLI sessions and chats, from
 * the ADE account's GitHub App sign-in (`account_app`).
 *
 * ADE adds it only when `gh` would otherwise have no GitHub sign-in at all:
 * - the session's environment has no GitHub token of its own, and
 * - `gh` has no login for github.com on this machine (its `hosts.yml` does
 *   not list the host; a keyring login is listed there too), and
 * - the account App token is current, and
 * - the owner of the project's repository has an installation of the App
 *   that the user can reach. Read rights are enough: on a write the
 *   installation refuses, `gh` prints GitHub's own message.
 *
 * How the token reaches `gh` and `git`:
 * - Normally through the per-call shim (githubShellShim.ts): a `gh` first on
 *   PATH and a git credential helper, which ask this process for the CURRENT
 *   token on every run. A shell that runs for days keeps working across the
 *   server's renewals. No token is in the session's environment.
 * - Where the shim is off (the process did not turn it on, its folder is not
 *   private, or the Windows launcher is missing), `GH_TOKEN` is the token
 *   current when the process starts. It dies at the server's renewal (8
 *   hours at most); a new shell or chat gets the new one.
 *
 * `ADE_GH_TOKEN_SOURCE=account_app` marks a `GH_TOKEN` ADE set (the fallback,
 * or the shim for its child), so an ADE process started from such a shell
 * does not take it as an "environment" token.
 */

export const GH_TOKEN_SOURCE_ENV = "ADE_GH_TOKEN_SOURCE";
export const GH_TOKEN_SOURCE_ACCOUNT_APP = "account_app";

/** Every variable `gh` reads a token from (`gh help environment`). */
const GH_TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** A cached installation answer the synchronous path may still use. */
const GRANT_STALE_MAX_MS = 24 * 60 * 60_000;

/** True when `env` carries a GitHub token that ADE did not add. */
export function envHasOwnGithubToken(env: NodeJS.ProcessEnv): boolean {
  if (env[GH_TOKEN_SOURCE_ENV] === GH_TOKEN_SOURCE_ACCOUNT_APP) {
    return GH_TOKEN_ENV_KEYS.some((key) => key !== "GH_TOKEN" && Boolean(env[key]?.trim()));
  }
  return GH_TOKEN_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/**
 * True when `gh` has a login for github.com: `hosts.yml` lists the host. The
 * file holds the user name for a keyring login and the token for a file
 * login; either way `gh` uses it.
 */
export function ghHasOwnGithubLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const raw = fs.readFileSync(path.join(ghConfigDir(env), "hosts.yml"), "utf8");
    return raw.split(/\r?\n/).some((line) => /^["']?github\.com["']?\s*:/.test(line));
  } catch {
    return false;
  }
}

/** The environment token value for the "environment" credential, ignoring one ADE added for `gh`. */
export function readOwnEnvironmentGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromAde = env[GH_TOKEN_SOURCE_ENV] === GH_TOKEN_SOURCE_ACCOUNT_APP;
  for (const key of ["ADE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const) {
    if (key === "GH_TOKEN" && fromAde) continue;
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export type GithubSessionEnv = Record<string, string>;

export function createGithubSessionEnv(deps: {
  /** The account App token, asking the server when the cache is stale. */
  readAccountAppToken: () => Promise<string | null>;
  /** The cached account App token, no request. */
  peekAccountAppToken: () => string | null;
  readGrant: AppGrantReader;
  /** The owner of the project's GitHub repository, or null. */
  readRepoOwner: () => Promise<string | null>;
  /**
   * The owner from the repository's own config file, no process started; null
   * when it does not say. Lets the first chat of a project know the owner.
   */
  peekRepoOwner?: () => string | null;
  hasOwnGhLogin?: (env: NodeJS.ProcessEnv) => boolean;
  now?: () => number;
  /**
   * False for a service with no account App client (a repository lookup with
   * no account). It must not replace the process-wide shell answer: running
   * shells would then get no token while the account is still connected.
   */
  answersShells?: boolean;
}) {
  const now = deps.now ?? (() => Date.now());
  const hasOwnGhLogin = deps.hasOwnGhLogin ?? ghHasOwnGithubLogin;
  let lastOwner: string | null = null;
  let warming: Promise<unknown> | null = null;

  /** The per-call shim for `owner`, or null when the shim is off. */
  const shimFor = (env: NodeJS.ProcessEnv, owner: string): GithubSessionEnv | null => {
    const shim = githubShellShimEnv(env, owner);
    if (!shim) return null;
    // A frozen token an older ADE parent left would outlive its renewal: empty it.
    if (env[GH_TOKEN_SOURCE_ENV] === GH_TOKEN_SOURCE_ACCOUNT_APP) {
      return { ...shim, GH_TOKEN: "", [GH_TOKEN_SOURCE_ENV]: "" };
    }
    return shim;
  };
  const envFor = (token: string, env: NodeJS.ProcessEnv, owner: string): GithubSessionEnv =>
    shimFor(env, owner) ?? { GH_TOKEN: token, [GH_TOKEN_SOURCE_ENV]: GH_TOKEN_SOURCE_ACCOUNT_APP };

  /**
   * The shim's question, on every `gh` or `git` run: the current account App
   * token when the owner's installation is reachable, else null (the shim
   * steps aside). Cached answers mostly: the token client and the grant
   * reader keep theirs, so a run costs no request.
   */
  const tokenForOwner = async (requestedOwner: string | null): Promise<string | null> => {
    try {
      const owner = requestedOwner ?? lastOwner;
      if (!owner) return null;
      const token = await deps.readAccountAppToken();
      if (!token) return null;
      const grant = await deps.readGrant(owner, token, { identity: "account_app" });
      return grant?.installed ? token : null;
    } catch {
      return null;
    }
  };
  if (deps.answersShells !== false) setGithubShellTokenAnswer(tokenForOwner);

  const needsToken = (env: NodeJS.ProcessEnv): boolean => !envHasOwnGithubToken(env) && !hasOwnGhLogin(env);

  /** For a process about to start (a shell or a CLI session). Never throws. */
  const forSession = async (env: NodeJS.ProcessEnv): Promise<GithubSessionEnv | null> => {
    try {
      if (!needsToken(env)) return null;
      const owner = await deps.readRepoOwner();
      lastOwner = owner;
      if (!owner) return null;
      const token = await deps.readAccountAppToken();
      if (!token) return null;
      const grant = await deps.readGrant(owner, token, { identity: "account_app" });
      return grant?.installed ? envFor(token, env, owner) : null;
    } catch {
      return null;
    }
  };

  const warm = (env: NodeJS.ProcessEnv): void => {
    if (warming) return;
    warming = forSession(env).finally(() => {
      warming = null;
    });
  };

  /**
   * For a synchronous environment build (a chat's): cached values only. With
   * the owner known but the token or the installation answer not cached, the
   * chat still gets the shim, which asks for the token on each run (and steps
   * aside while ADE has none). With no owner yet, or the shim off, a cold
   * cache answers null. Either way the cache fills itself for the next process.
   */
  const peekForSession = (env: NodeJS.ProcessEnv): GithubSessionEnv | null => {
    try {
      if (!needsToken(env)) return null;
      if (!lastOwner) lastOwner = deps.peekRepoOwner?.() ?? null;
      const owner = lastOwner;
      if (!owner) {
        warm(env);
        return null;
      }
      const token = deps.peekAccountAppToken();
      const cached = token ? deps.readGrant.peek?.(owner, "account_app", token) ?? null : null;
      if (!token || !cached || now() - cached.checkedAt > GRANT_STALE_MAX_MS) {
        warm(env);
        return shimFor(env, owner);
      }
      if (cached.stale) warm(env);
      return cached.grant?.installed ? envFor(token, env, owner) : null;
    } catch {
      return null;
    }
  };

  return { forSession, peekForSession, tokenForOwner };
}

export type GithubSessionEnvProvider = ReturnType<typeof createGithubSessionEnv>;
