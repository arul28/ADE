import fs from "node:fs";
import path from "node:path";
import { ghConfigDir } from "../../../../../ade-cli/src/services/credentials/ghConfigDir";
import type { AppGrantReader } from "./githubAppGrant";

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
 * The value is the token current when the process starts. A process that
 * outlives the server's renewal (about 8 hours at most) keeps a dead token
 * and `gh` answers "Bad credentials"; a new shell or chat gets the new one.
 *
 * `ADE_GH_TOKEN_SOURCE=account_app` marks the value, so an ADE process
 * started from such a shell does not take it as an "environment" token.
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
  hasOwnGhLogin?: (env: NodeJS.ProcessEnv) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const hasOwnGhLogin = deps.hasOwnGhLogin ?? ghHasOwnGithubLogin;
  let lastOwner: string | null = null;
  let warming: Promise<unknown> | null = null;

  const envFor = (token: string): GithubSessionEnv => ({
    GH_TOKEN: token,
    [GH_TOKEN_SOURCE_ENV]: GH_TOKEN_SOURCE_ACCOUNT_APP,
  });

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
      return grant?.installed ? envFor(token) : null;
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
   * For a synchronous environment build (a chat's): cached values only. A cold
   * cache answers null and fills itself for the next process.
   */
  const peekForSession = (env: NodeJS.ProcessEnv): GithubSessionEnv | null => {
    try {
      if (!needsToken(env)) return null;
      const owner = lastOwner;
      const token = deps.peekAccountAppToken();
      const cached = owner ? deps.readGrant.peek?.(owner, "account_app") ?? null : null;
      if (!owner || !token || !cached || now() - cached.checkedAt > GRANT_STALE_MAX_MS) {
        warm(env);
        return null;
      }
      if (cached.stale) warm(env);
      return cached.grant?.installed ? envFor(token) : null;
    } catch {
      return null;
    }
  };

  return { forSession, peekForSession };
}

export type GithubSessionEnvProvider = ReturnType<typeof createGithubSessionEnv>;
