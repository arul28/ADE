/**
 * The one place a Copilot token from the account joins a process: the env of
 * a Copilot process at its start, on a cloud computer (P5 G1).
 *
 * Apply sets the token ADE Cloud uses for Copilot: a person's GitHub CLI login
 * carried from their computer, or the saved ADE Cloud key (Q3). It lives in
 * this module's memory only. Every sink that starts Copilot (the SDK pool, and
 * the tracked terminal Copilot CLI) calls `withCopilotCarriedEnv` on the env it
 * is about to spawn with, so the token never sits in the brain's own
 * `process.env`, a file, an env patch, a tracked command line, the context
 * preview, a log, a status or an action result.
 *
 * An env that brings its own Copilot token (`COPILOT_GITHUB_TOKEN`,
 * `GH_TOKEN` or `GITHUB_TOKEN`: a harness preset key) keeps it.
 *
 * On a person's own computer apply never runs, nothing is set, and the helper
 * returns the env it was given. No runtime imports: the pool and the terminal
 * read it without loading the sign-in sync.
 */

/** The Copilot runtime's token variables, in the order it reads them (`COPILOT_TOKEN_ENV_KEYS`). */
const TOKEN_NAMES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const TOKEN_NAME = "COPILOT_GITHUB_TOKEN";

let carried: { token: string; hash: string } | null = null;

/** Apply only. `hash` names the copy (the payload's content hash, or the key's short hash); null clears it. */
export function setCopilotCarriedToken(next: { token: string; hash: string } | null): void {
  carried = next && next.token ? { token: next.token, hash: next.hash } : null;
}

/** The hash of the copy in use here, or null: apply's "the same copy". Never the token. */
export function copilotCarriedHash(): string | null {
  return carried?.hash ?? null;
}

function hasToken(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return TOKEN_NAMES.some((name) => Boolean(env[name]?.trim()));
  const names = new Set<string>(TOKEN_NAMES);
  return Object.entries(env).some(([key, value]) => names.has(key.toUpperCase()) && Boolean(value?.trim()));
}

/**
 * The env a Copilot process starts with: a copy with the carried token as
 * `COPILOT_GITHUB_TOKEN` when one is set here and `env` has no Copilot token
 * of its own; else `env` itself. Never logs, never throws.
 */
export function withCopilotCarriedEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (!carried || hasToken(env, platform)) return env;
  return { ...env, [TOKEN_NAME]: carried.token };
}
