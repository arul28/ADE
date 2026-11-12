/**
 * What ADE knows about an Antigravity sign-in without starting the agent.
 *
 * The agy CLI (`agy acp` for chats, the TUI for terminals) keeps its state in
 * `<home>/.gemini/antigravity-cli/` whatever GEMINI_HOME says. The CLI writes
 * there; ADE writes one value only, on the person's own Google sign-in
 * (`pointAntigravitySettingsAtGoogle`):
 *
 *   settings.json             the CLI's settings (the recorded sign-in
 *                             method, when it keeps one)
 *   antigravity-oauth-token   the Google sign-in, when the CLI uses its file
 *                             store: no working OS keyring, a slow one, or a
 *                             container or WSL (verified, agy 1.5.6 on Linux)
 *
 * Otherwise the Google sign-in is in the OS keyring (zalando go-keyring):
 * service `gemini`, user `antigravity` (verified on Linux Secret Service). That
 * is the Keychain item `-s gemini -a antigravity` on macOS and the generic
 * credential `gemini:antigravity` in Windows Credential Manager. The status
 * check asks only whether that item exists, never for its secret: `security
 * find-generic-password` without `-w`, `cmdkey /list:<target>`, and Secret
 * Service `SearchItems`. Each answer is cached, and none runs synchronously.
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

/**
 * The CLI's OS keyring item (go-keyring service and user). One item holds the
 * Google sign-in whichever Google method made it.
 */
export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYRING_USER = "antigravity";
/** Kept for the sign-in sync's slot API: both Google methods share the one item. */
export const ANTIGRAVITY_KEYCHAIN_ACCOUNT: Readonly<Partial<Record<AntigravityAuthMethod, string>>> = {
  "oauth-personal": ANTIGRAVITY_KEYRING_USER,
  "oauth-business": ANTIGRAVITY_KEYRING_USER,
};

export function isAntigravityAuthMethod(value: unknown): value is AntigravityAuthMethod {
  return typeof value === "string" && (ANTIGRAVITY_AUTH_METHODS as readonly string[]).includes(value);
}

/** The CLI's own directory. GEMINI_HOME does not move it. */
export function antigravityCliDir(): string {
  return path.join(homedir(), ".gemini", "antigravity-cli");
}

/** The CLI's file store for the Google sign-in (used when no OS keyring works). */
export const ANTIGRAVITY_TOKEN_FILE = "antigravity-oauth-token";

/**
 * agy reads settings.json as strict JSON: a comment or a trailing comma makes
 * it ignore the whole file, auth method included (verified 1.5.6). ADE reads it
 * the same way, so a file agy ignores names no method here either.
 */
function parseSettingsJson(raw: string): unknown {
  return JSON.parse(raw);
}

type SettingsRead = { method: AntigravityAuthMethod | null; gcpProject: string | null; gcpLocation: string | null };
let settingsCache: { file: string; mtimeMs: number; size: number; value: SettingsRead } | null = null;

/**
 * `auth.type` and the `gcp` block from the agent's settings.json. Synchronous
 * and cached on the file's mtime, because spawn plans read it: one `stat` per
 * call, one read per change.
 */
export function readAntigravitySettings(_env: NodeJS.ProcessEnv = process.env): SettingsRead {
  const file = path.join(antigravityCliDir(), "settings.json");
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
    const parsed = parseSettingsJson(fs.readFileSync(file, "utf8")) as {
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

const KEYRING_CACHE_MS = 30_000;
/**
 * A read that timed out is a keyring waiting on an unlock dialog. Asking again
 * every 30 s only queues more dialogs, so that answer is kept for longer.
 */
const KEYRING_TIMEOUT_CACHE_MS = 10 * 60_000;
let keyringCache: { at: number; ttlMs: number; present: boolean } | null = null;
let keyringInFlight: Promise<boolean> | null = null;

type PresenceProbe = { command: string; args: string[]; present: (stdout: string) => boolean };

/** How to ask this OS whether the item exists, without reading its secret. */
function keyringPresenceProbe(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PresenceProbe | null {
  const target = `${ANTIGRAVITY_KEYCHAIN_SERVICE}:${ANTIGRAVITY_KEYRING_USER}`;
  if (platform === "darwin") {
    return {
      command: "/usr/bin/security",
      args: ["find-generic-password", "-s", ANTIGRAVITY_KEYCHAIN_SERVICE, "-a", ANTIGRAVITY_KEYRING_USER],
      present: () => true,
    };
  }
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    // `cmdkey` lists the matching credential's target and type, not its
    // secret. Its words are localized; the target name is not.
    return {
      command: path.join(systemRoot, "System32", "cmdkey.exe"),
      args: [`/list:${target}`],
      present: (stdout) => stdout.toLowerCase().includes(target),
    };
  }
  if (platform === "linux") {
    if (!env.DBUS_SESSION_BUS_ADDRESS?.trim()) return null;
    // Secret Service `SearchItems` returns the unlocked and locked item paths
    // that match; it neither unlocks a collection nor reads a secret.
    return {
      command: "gdbus",
      args: [
        "call", "--session", "--dest", "org.freedesktop.secrets",
        "--object-path", "/org/freedesktop/secrets",
        "--method", "org.freedesktop.Secret.Service.SearchItems",
        `{'service': '${ANTIGRAVITY_KEYCHAIN_SERVICE}', 'username': '${ANTIGRAVITY_KEYRING_USER}'}`,
      ],
      present: (stdout) => stdout.includes("objectpath"),
    };
  }
  return null;
}

/** True when the OS keyring holds the CLI's sign-in item. Attributes only; cached. */
export function antigravityKeyringItemExists(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (keyringCache && Date.now() - keyringCache.at < keyringCache.ttlMs) return Promise.resolve(keyringCache.present);
  if (keyringInFlight) return keyringInFlight;
  const probe = keyringPresenceProbe(platform, env);
  if (!probe) return Promise.resolve(false);
  const asked = new Promise<boolean>((resolve) => {
    execFile(probe.command, probe.args, { timeout: 2_000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      const present = !error && probe.present(String(stdout ?? ""));
      const ttlMs = error?.killed ? KEYRING_TIMEOUT_CACHE_MS : KEYRING_CACHE_MS;
      keyringCache = { at: Date.now(), ttlMs, present };
      keyringInFlight = null;
      resolve(present);
    });
  });
  keyringInFlight = asked;
  return asked;
}

/** The last keyring answer, without asking again (null before the first). */
export function peekAntigravityKeyringPresent(): boolean | null {
  return keyringCache ? keyringCache.present : null;
}

/** The settings value of a key method, as agy or a user may have written it. */
const KEY_METHOD_SETTING = /("auth"\s*:\s*\{[^{}]*?"type"\s*:\s*")(gemini-api-key|agent-platform|vertex-ai)(")/;

/**
 * After a Google-account sign-in: when agy's settings still name a key method
 * from an earlier sign-in, agy ignores the new login and answers
 * "Authentication required" (verified 1.5.6; `agy acp --login` leaves the
 * setting as it was). The person's own Google sign-in is the one time ADE
 * writes agy's settings, and it changes only that value to `oauth-personal`;
 * every other byte of the file stays.
 *
 * - "unchanged": no settings file, or it names no key method.
 * - "switched": the value now reads `oauth-personal`.
 * - "failed": it names a key method ADE could not rewrite in place (an
 *   unusual layout, or the file could not be written).
 */
export function pointAntigravitySettingsAtGoogle(): "unchanged" | "switched" | "failed" {
  const file = path.join(antigravityCliDir(), "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "unchanged";
  }
  settingsCache = null;
  const method = readAntigravitySettings().method;
  if (method !== "gemini-api-key" && method !== "agent-platform") return "unchanged";
  if (!KEY_METHOD_SETTING.test(raw)) return "failed";
  const next = raw.replace(KEY_METHOD_SETTING, "$1oauth-personal$3");
  const temp = `${file}.ade-${process.pid}.tmp`;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(temp, next, { mode });
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
    return "failed";
  }
  settingsCache = null;
  return "switched";
}

/** Forget the cached answers so the next status read after a sign-in is fresh. */
export function invalidateAntigravityAuthCache(): void {
  keyringCache = null;
  settingsCache = null;
}

export type AntigravityCredentialState = {
  authenticated: boolean;
  verified: false;
  /** The method the CLI recorded, or null when it records none. */
  method: AntigravityAuthMethod | null;
};

/**
 * Whether this machine has an Antigravity sign-in, from disk and the OS
 * keyring's item list. Never starts the agent.
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
  // A Google-account or Gemini Enterprise sign-in: the CLI's file store, else its keyring item.
  if (fs.existsSync(path.join(antigravityCliDir(), ANTIGRAVITY_TOKEN_FILE))) return result(true);
  return result(await antigravityKeyringItemExists(env));
}
