/**
 * The one place a Claude pass token joins a process: the env of a Claude
 * process that starts on a pass account, on a cloud computer.
 *
 * A pass account is an ordinary Claude account whose config home holds no
 * login (claudePassSync.ts makes it). The token lives in this module's memory
 * only, keyed by that config home. Every sink that starts Claude for an
 * account calls `withClaudePassEnv` on the env it is about to spawn with, so
 * the token never sits in an env patch, a tracked CLI command, the context
 * preview, a file, or the brain's own `process.env`.
 *
 * A Claude process that names no account (no `CLAUDE_CONFIG_DIR`: the base
 * account, a one-shot task, an orchestrated worker) gets the "New chats"
 * pass, as it got the boot token before passes, unless its env brings
 * another Claude credential of its own (an API key route, Bedrock, Vertex)
 * or the base Claude home holds a login made on this computer (the
 * reconcile then gives no "New chats" home).
 *
 * On a person's own computer the map is always empty and nothing is managed,
 * so the helper returns the env it was given.
 */

import { pathKey } from "../shared/pathCompare";

/** Names that would make Claude Code use another credential than the pass. */
const PASS_CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const TOKEN_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const CONFIG_DIR_NAME = "CLAUDE_CONFIG_DIR";
/** A Claude credential an env can bring for itself; with one, no pass is added. */
const OWN_CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

let homes: ReadonlyArray<{ configHome: string; token: string }> = [];
/** `homes` by `pathKey`, for the platform it was built for. */
let tokenByHome = new Map<string, string>();
let keyedFor: NodeJS.Platform = process.platform;
/** The token of the "New chats" pass, for a Claude process that names no account. */
let defaultToken: string | null = null;
/**
 * True once the reconcile owns Claude's sign-in on this cloud computer (it
 * read a ready vault and took the boot token into the account). From then on
 * a Claude process never takes a token it was not given.
 */
let managed = false;

/** Called by the reconcile only. `homes` replaces the whole map. */
export function setClaudePassLaunchState(next: {
  homes: ReadonlyArray<{ configHome: string; token: string }>;
  /** The config home of the "New chats" pass, or null. */
  defaultHome: string | null;
  managed: boolean;
}): void {
  homes = next.homes.filter(({ configHome, token }) => Boolean(configHome && token));
  tokenByHome = keyHomes(process.platform);
  defaultToken = next.defaultHome ? tokenByHome.get(pathKey(next.defaultHome)) ?? null : null;
  managed = next.managed;
}

function keyHomes(platform: NodeJS.Platform): Map<string, string> {
  keyedFor = platform;
  return new Map(homes.map(({ configHome, token }) => [pathKey(configHome, platform), token]));
}

/** True when a pass signs Claude in on this computer (a cloud computer with a pass on). */
export function claudePassSignedInHere(): boolean {
  return tokenByHome.size > 0;
}

/** True when `configHome` is a pass account's home with a token here. */
export function isClaudePassHome(configHome: string | null | undefined): boolean {
  return Boolean(configHome && tokenByHome.has(pathKey(configHome)));
}

/** The value of `name` in `env`, by a case-folded name on Windows. */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== "win32") return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

function hasEnvName(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return Object.hasOwn(env, name);
  const upper = name.toUpperCase();
  return Object.keys(env).some((key) => key.toUpperCase() === upper);
}

/** A copy of `env` without `names`; on Windows any spelling of a name is the same variable. */
function without(env: NodeJS.ProcessEnv, names: readonly string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const fold = platform === "win32";
  const drop = new Set(names.map((name) => (fold ? name.toUpperCase() : name)));
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!drop.has(fold ? key.toUpperCase() : key)) next[key] = value;
  }
  return next;
}

/**
 * The env a Claude process starts with.
 *
 * - `CLAUDE_CONFIG_DIR` names a pass account's home: a copy with the pass as
 *   `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` blank, and no
 *   `ANTHROPIC_AUTH_TOKEN`.
 * - No `CLAUDE_CONFIG_DIR`, no credential of its own, and a "New chats"
 *   pass: a copy with that pass as `CLAUDE_CODE_OAUTH_TOKEN`.
 * - Else, once the reconcile manages Claude here: a copy without a stray
 *   `CLAUDE_CODE_OAUTH_TOKEN` (when there is one).
 * - Else `env` itself, unchanged.
 *
 * A harness route or preset names its own config home or credential, so it
 * never gets a pass. Never logs, never throws.
 */
export function withClaudePassEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (!tokenByHome.size && !managed) return env;
  const home = envValue(env, CONFIG_DIR_NAME, platform)?.trim();
  if (platform !== keyedFor) tokenByHome = keyHomes(platform);
  const token = home ? tokenByHome.get(pathKey(home, platform)) : undefined;
  if (token) {
    return { ...without(env, PASS_CREDENTIAL_NAMES, platform), ANTHROPIC_API_KEY: "", [TOKEN_NAME]: token };
  }
  if (managed && !home && defaultToken && !OWN_CREDENTIAL_NAMES.some((name) => envValue(env, name, platform)?.trim())) {
    return { ...without(env, [TOKEN_NAME], platform), [TOKEN_NAME]: defaultToken };
  }
  if (managed && hasEnvName(env, TOKEN_NAME, platform)) return without(env, [TOKEN_NAME], platform);
  return env;
}
