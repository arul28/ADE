/**
 * What ADE knows about an Antigravity sign-in without starting the agent.
 *
 * Google's ACP agent (`agy_acp_server`) keeps everything it owns under
 * `<GEMINI_HOME or ~/.gemini>/antigravity-acp/`. ADE leaves GEMINI_HOME at the
 * user's default, so a sign-in done here, in Zed or in JetBrains is one login.
 * ADE never writes into that directory; the agent writes it itself:
 *
 *   settings.json             `auth.type` (the method the last `authenticate`
 *                             picked, saved by the agent) and `gcp.project` /
 *                             `gcp.location` (written by its own Gemini
 *                             Enterprise license picker)
 *   acp_token.json            Google-account token, when the file store is used
 *   acp_business_token.json   Gemini Enterprise token, likewise
 *
 * Token storage (verified in the 1.4.1 sources): on macOS the agent keeps the
 * token in the login keychain (service `gemini`, account `antigravity-acp` or
 * `antigravity-acp-business`) whenever a default keychain works, and falls back
 * to the file; everywhere else it uses the file. `AGY_ACP_FORCE_FILE_STORAGE`
 * forces the file. ADE does NOT set it: forcing the file would split ADE's
 * login from the one every other client of this agent reads on a Mac, and
 * would move a token out of the keychain into a plaintext file. A user who sets
 * it themselves keeps it (it is passed through). So the status
 * check reads the file and, on macOS only, asks the keychain whether the item
 * exists (`security find-generic-password` without `-w` reads attributes only:
 * no secret, no prompt).
 *
 * The status is a heuristic, like every ACP disk check (`verified: false`).
 * Only a real `session/new` proves the token still works; the ACP auth probe
 * does that once the pin is on disk.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type AntigravityAgentPlatformConfig,
} from "../../../shared/types/config";
import { getApiCredentialKey } from "./apiKeyStore";

/**
 * Credential and routing variables the agent reads. ADE removes all of them
 * from the agent's environment and adds back only what the chosen method
 * needs, so an ambient `GEMINI_API_KEY` or ADC project cannot quietly decide
 * which account a chat bills. (No private-profile keys: ADE keeps the default
 * GEMINI_HOME.)
 */
export const ANTIGRAVITY_CREDENTIAL_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_LLM_GATEWAY_URL",
] as const;

/** Variables an Agent Platform login may take from the machine (ADC users set these). */
const AGENT_PLATFORM_AMBIENT_KEYS = [
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
] as const;

/** ADE key-store slots. The Gemini key is the one the provider page's key sheet saves. */
export const ANTIGRAVITY_GEMINI_KEY_CREDENTIAL = "antigravity-gemini";
export const ANTIGRAVITY_AGENT_PLATFORM_KEY_CREDENTIAL = "antigravity-agent-platform";

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT: Partial<Record<AntigravityAuthMethod, string>> = {
  "oauth-personal": "antigravity-acp",
  "oauth-business": "antigravity-acp-business",
};
const TOKEN_FILE: Partial<Record<AntigravityAuthMethod, string>> = {
  "oauth-personal": "acp_token.json",
  "oauth-business": "acp_business_token.json",
};

export function isAntigravityAuthMethod(value: unknown): value is AntigravityAuthMethod {
  return typeof value === "string" && (ANTIGRAVITY_AUTH_METHODS as readonly string[]).includes(value);
}

/** `GEMINI_HOME` when set and non-empty, else `~/.gemini` — the agent's own rule. */
export function antigravityGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GEMINI_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".gemini");
}

/** The agent's private directory. ADE reads it and never writes it. */
export function antigravityAcpDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityGeminiHome(env), "antigravity-acp");
}

/**
 * The settings file is Hjson to the agent (comments, trailing commas). ADE
 * only needs two string fields, so it strips comments and trailing commas and
 * parses JSON; anything it still cannot read is "no method".
 */
function parseLooseJson(raw: string): unknown {
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

type SettingsRead = { method: AntigravityAuthMethod | null; gcpProject: string | null; gcpLocation: string | null };
let settingsCache: { file: string; mtimeMs: number; size: number; value: SettingsRead } | null = null;

/**
 * `auth.type` and the `gcp` block from the agent's settings.json. Synchronous
 * and cached on the file's mtime, because spawn plans read it: one `stat` per
 * call, one read per change.
 */
export function readAntigravitySettings(env: NodeJS.ProcessEnv = process.env): SettingsRead {
  const file = path.join(antigravityAcpDir(env), "settings.json");
  const empty: SettingsRead = { method: null, gcpProject: null, gcpLocation: null };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return empty;
  }
  if (settingsCache && settingsCache.file === file && settingsCache.mtimeMs === stat.mtimeMs && settingsCache.size === stat.size) {
    return settingsCache.value;
  }
  let value = empty;
  try {
    const parsed = parseLooseJson(fs.readFileSync(file, "utf8")) as {
      auth?: { type?: unknown };
      gcp?: { project?: unknown; location?: unknown };
    };
    const rawType = typeof parsed?.auth?.type === "string" ? parsed.auth.type.trim() : "";
    // The agent still accepts the legacy `vertex-ai` spelling.
    const method = rawType === "vertex-ai" ? "agent-platform" : rawType;
    value = {
      method: isAntigravityAuthMethod(method) ? method : null,
      gcpProject: typeof parsed?.gcp?.project === "string" && parsed.gcp.project.trim() ? parsed.gcp.project.trim() : null,
      gcpLocation: typeof parsed?.gcp?.location === "string" && parsed.gcp.location.trim() ? parsed.gcp.location.trim() : null,
    };
  } catch {
    value = empty;
  }
  settingsCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

// ── ADE-owned settings (never the agent's file) ─────────────────────────────

/**
 * ADE's own record of the Agent Platform project and location, for users
 * whose machine does not export GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION.
 * Lives under ADE's home on the machine that runs the agent.
 */
function adeAntigravityConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const adeHome = env.ADE_HOME?.trim() ? path.resolve(env.ADE_HOME.trim()) : path.join(homedir(), ".ade");
  return path.join(adeHome, "providers", "antigravity.json");
}

export function readAdeAntigravityAgentPlatformConfig(env: NodeJS.ProcessEnv = process.env): AntigravityAgentPlatformConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(adeAntigravityConfigPath(env), "utf8")) as {
      agentPlatform?: { project?: unknown; location?: unknown };
    };
    const project = typeof parsed?.agentPlatform?.project === "string" ? parsed.agentPlatform.project.trim() : "";
    const location = typeof parsed?.agentPlatform?.location === "string" ? parsed.agentPlatform.location.trim() : "";
    return { project: project || null, location: location || null };
  } catch {
    return { project: null, location: null };
  }
}

export function writeAdeAntigravityAgentPlatformConfig(
  config: AntigravityAgentPlatformConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = adeAntigravityConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    agentPlatform: {
      ...(config.project?.trim() ? { project: config.project.trim() } : {}),
      ...(config.location?.trim() ? { location: config.location.trim() } : {}),
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

// ── Stored keys ─────────────────────────────────────────────────────────────

function storedKey(credentialProvider: string): string | null {
  try {
    return getApiCredentialKey(credentialProvider)?.trim() || null;
  } catch {
    // The key store is scoped to a process that initialized it; elsewhere
    // only the environment can carry a key.
    return null;
  }
}

export function storedAntigravityGeminiKey(): string | null {
  return storedKey(ANTIGRAVITY_GEMINI_KEY_CREDENTIAL);
}

export function storedAntigravityAgentPlatformKey(): string | null {
  return storedKey(ANTIGRAVITY_AGENT_PLATFORM_KEY_CREDENTIAL);
}

// ── Spawn environment ───────────────────────────────────────────────────────

/**
 * The agent's credential environment for one method: every Google credential
 * variable removed, then only the chosen method's put back. `null` method
 * (nothing recorded yet) passes no credential at all.
 *
 * - Gemini API key: GEMINI_API_KEY from ADE's key store, else the machine's.
 * - Agent Platform: GOOGLE_API_KEY from ADE's key store, else the machine's
 *   ADC variables, then ADE's saved project/location for whatever is unset.
 * - Google account / Gemini Enterprise: nothing; the agent uses its own token.
 *
 * Windows environment keys are case-insensitive, so aliases go too.
 */
export function antigravityCredentialEnv(
  baseEnv: NodeJS.ProcessEnv,
  method: AntigravityAuthMethod | null,
): NodeJS.ProcessEnv {
  const removed = new Set<string>(ANTIGRAVITY_CREDENTIAL_ENV_KEYS);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!removed.has(key.toUpperCase())) env[key] = value;
  }
  const ambient = (key: string): string | null => {
    for (const [name, value] of Object.entries(baseEnv)) {
      if (name.toUpperCase() === key && typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  if (method === "gemini-api-key") {
    const key = storedAntigravityGeminiKey() ?? ambient("GEMINI_API_KEY");
    if (key) env.GEMINI_API_KEY = key;
  } else if (method === "agent-platform") {
    const key = storedAntigravityAgentPlatformKey();
    if (key) {
      env.GOOGLE_API_KEY = key;
    } else {
      for (const name of AGENT_PLATFORM_AMBIENT_KEYS) {
        const value = ambient(name);
        if (value) env[name] = value;
      }
      const saved = readAdeAntigravityAgentPlatformConfig(baseEnv);
      if (!env.GOOGLE_CLOUD_PROJECT && saved.project) env.GOOGLE_CLOUD_PROJECT = saved.project;
      if (!env.GOOGLE_CLOUD_LOCATION && saved.location) env.GOOGLE_CLOUD_LOCATION = saved.location;
    }
  }
  return env;
}

// ── Signed-in check ─────────────────────────────────────────────────────────

const KEYCHAIN_CACHE_MS = 30_000;
const keychainCache = new Map<string, { at: number; present: boolean }>();

/** True when the macOS login keychain holds the agent's token item. Attribute read only. */
function keychainItemExists(account: string): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const cached = keychainCache.get(account);
  if (cached && Date.now() - cached.at < KEYCHAIN_CACHE_MS) return Promise.resolve(cached.present);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
      { timeout: 2_000, windowsHide: true },
      (error) => {
        const present = !error;
        keychainCache.set(account, { at: Date.now(), present });
        resolve(present);
      },
    );
  });
}

/** Forget the keychain answer so the next status read after a sign-in is fresh. */
export function invalidateAntigravityAuthCache(): void {
  keychainCache.clear();
  settingsCache = null;
}

export type AntigravityCredentialState = {
  authenticated: boolean;
  verified: false;
  /** The method the agent recorded, or null before any sign-in. */
  method: AntigravityAuthMethod | null;
};

/**
 * Whether this machine has an Antigravity sign-in, from disk (and, on macOS,
 * the keychain's item list). Never starts the agent.
 */
export async function inspectAntigravityCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityCredentialState> {
  const settings = readAntigravitySettings(env);
  const method = settings.method;
  const result = (authenticated: boolean): AntigravityCredentialState => ({ authenticated, verified: false, method });
  if (method === "gemini-api-key") {
    const ambient = Object.entries(env).some(([key, value]) => key.toUpperCase() === "GEMINI_API_KEY" && Boolean(value?.trim()));
    return result(Boolean(storedAntigravityGeminiKey()) || ambient);
  }
  if (method === "agent-platform") {
    const has = (key: string) => Object.entries(env).some(([name, value]) => name.toUpperCase() === key && Boolean(value?.trim()));
    const saved = readAdeAntigravityAgentPlatformConfig(env);
    const project = has("GOOGLE_CLOUD_PROJECT") || Boolean(saved.project) || Boolean(settings.gcpProject);
    const location = has("GOOGLE_CLOUD_LOCATION") || Boolean(saved.location) || Boolean(settings.gcpLocation);
    return result(Boolean(storedAntigravityAgentPlatformKey()) || has("GOOGLE_API_KEY") || (project && location));
  }
  // A Google-account or Gemini Enterprise login. With no recorded method, a
  // token left by an older client still counts as the Google account.
  const tokenMethods: AntigravityAuthMethod[] = method ? [method] : ["oauth-personal", "oauth-business"];
  for (const candidate of tokenMethods) {
    const file = TOKEN_FILE[candidate];
    if (file && fs.existsSync(path.join(antigravityAcpDir(env), file))) return result(true);
  }
  if (env.AGY_ACP_FORCE_FILE_STORAGE?.trim()) return result(false);
  for (const candidate of tokenMethods) {
    const account = KEYCHAIN_ACCOUNT[candidate];
    if (account && (await keychainItemExists(account))) return result(true);
  }
  return result(false);
}
