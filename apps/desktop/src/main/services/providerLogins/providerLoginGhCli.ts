/**
 * This computer's GitHub CLI login for Copilot on ADE Cloud (P5 G1): where gh
 * keeps it, and the one `gh` process that reads a token gh keeps in the OS
 * store (the Keychain on a Mac, the Credential Manager on Windows, the Secret
 * Service on Linux).
 *
 * - Only github.com (Q5). Another host's login is not read.
 * - `hosts.yml` gives the user and, with gh's plain-text storage (a headless
 *   Linux, `--insecure-storage`), the token itself: a file read, no process.
 * - The process runs `gh auth token --hostname github.com` with every env
 *   token gh would print instead (`GH_TOKEN`, `GITHUB_TOKEN` and the
 *   enterprise names) taken out, so ADE never carries a CI or shell token.
 *   It is reaped (a Keychain helper gh starts dies with it), with a time limit.
 * - Nothing here logs, and no result holds the token outside `token`.
 */

import path from "node:path";

import { getPathEnvValue, mergePathEntries, resolveExecutableFromKnownLocations, setPathEnvValue } from "../ai/cliExecutableResolver";
import { runReapedCommand } from "../shared/runReapedCommand";

/** Env names gh reads before its stored login; never passed to the read. */
const GH_ENV_TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** The github.com entry of `hosts.yml`: the active user, and the token when gh keeps it in the file. */
export function readGhHostsGithubCom(raw: string | null): { user: string | null; token: string | null } {
  if (!raw) return { user: null, token: null };
  let inGithub = false;
  let indent: number | null = null;
  let user: string | null = null;
  let token: string | null = null;
  const value = (text: string) => text.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "").trim() || null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      inGithub = /^["']?github\.com["']?\s*:\s*$/.test(line.trim());
      indent = null;
      continue;
    }
    if (!inGithub) continue;
    const lead = line.length - line.trimStart().length;
    indent ??= lead;
    // Only the host's own fields: `users:` lists every account gh knows, the active one is `user`.
    if (lead !== indent) continue;
    const match = /^\s+(user|oauth_token)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "user") user = value(match[2]!);
    else token = value(match[2]!);
  }
  return { user, token };
}

/** A classic personal token: Copilot does not take it (shared/cloudSignIns.ts). */
export function isClassicGitHubToken(token: string): boolean {
  return token.startsWith("ghp_");
}

export type GhTokenRead =
  | { ok: true; token: string }
  /**
   * - `no_token`: gh answered that github.com has no login (signed out).
   * - `not_installed`: no `gh` was found.
   * - `timeout`: gh did not answer in time (a locked Keychain or keyring waiting on a prompt).
   * - `failed`: any other error.
   */
  | { ok: false; reason: "no_token" | "not_installed" | "timeout" | "failed" };

export type GhTokenRunner = (options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<GhTokenRead>;

/** A copy of `env` without the env tokens gh would print instead of its stored login (any spelling on Windows). */
export function ghReadEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const drop = new Set<string>(GH_ENV_TOKEN_NAMES);
  const next: NodeJS.ProcessEnv = {};
  for (const [key, val] of Object.entries(env)) {
    if (!drop.has(platform === "win32" ? key.toUpperCase() : key)) next[key] = val;
  }
  return next;
}

/** The real read: one reaped `gh auth token --hostname github.com`. */
export const runGhAuthToken: GhTokenRunner = async ({ env, timeoutMs }) => {
  const resolved = resolveExecutableFromKnownLocations("gh", env);
  if (!resolved?.path) return { ok: false, reason: "not_installed" };
  // The PATH key keeps its spelling (`Path` on Windows), so the child gets one PATH, not two.
  const childEnv = ghReadEnv(env);
  setPathEnvValue(childEnv, mergePathEntries(getPathEnvValue(env), path.dirname(resolved.path)));
  const result = await runReapedCommand(resolved.path, ["auth", "token", "--hostname", "github.com"], {
    timeoutMs,
    maxBuffer: 64 * 1024,
    env: childEnv,
  });
  if (result.timedOut) return { ok: false, reason: "timeout" };
  const token = result.stdout.trim();
  if (result.exitCode === 0 && token && !/\s/.test(token)) return { ok: true, token };
  // gh says "no oauth token found for github.com" when that host has no login.
  if (/no oauth token/i.test(result.stderr)) return { ok: false, reason: "no_token" };
  return { ok: false, reason: "failed" };
};

/** Plain words for the tile when the read did not give a token. */
export const GH_READ_MESSAGES: Record<Exclude<GhTokenRead, { ok: true }>["reason"], string> = {
  no_token: "The GitHub CLI on this computer is not signed in to github.com.",
  not_installed: "ADE couldn't find the GitHub CLI (gh) on this computer.",
  timeout: "The GitHub CLI did not answer in time. If your computer asked to unlock its keychain, allow it, then turn this on again.",
  failed: "ADE couldn't read the GitHub CLI login. Run `gh auth status` to check it, then turn this on again.",
};
