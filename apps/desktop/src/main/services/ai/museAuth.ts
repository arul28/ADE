/**
 * Where Meta Muse Code keeps its sign-in, read for presence and shape only.
 *
 * Verified against muse 1.4.7-R6101.1 (strings of the macOS, Linux and Windows
 * builds, and running it with a scratch HOME):
 *
 * - Config root, on every platform: `$XDG_CONFIG_HOME/muse`, else
 *   `$HOME/.config/muse`, else `%USERPROFILE%\.config\muse` (the binary's own
 *   error is "no usable config directory from XDG_CONFIG_HOME, HOME, or
 *   USERPROFILE"). There is no `%APPDATA%` branch on Windows.
 * - `auth.json` there holds `{ schema_version, providers: { <id>: string } }`.
 *   Off macOS the string is the credential; on macOS the credential lives in
 *   the login Keychain and the file can be a reference to it (the binary falls
 *   back to the file only when the Keychain refuses). ADE never reads the
 *   Keychain from a status poll, so on macOS a missing file reads as "no
 *   sign-in detected", and the chat runtime's own health report corrects it.
 * - `META_API_KEY` in the environment always wins over a stored login.
 *
 * Nothing here returns or logs a credential value.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { getApiCredentialKey, getApiKey, listApiCredentials } from "./apiKeyStore";
import { museConfigDir } from "../shared/providerConfigHomes";

/** The variable Muse reads an API key from. ADE passes a stored key the same way, never on argv. */
export const MUSE_API_KEY_ENV = "META_API_KEY";

/**
 * The ADE key-store id a Muse API key is filed under. The vendor's name, like
 * `anthropic` for Claude Code, so an env `META_API_KEY` and a stored key show
 * up as the same provider.
 */
export const MUSE_CREDENTIAL_PROVIDER = "meta";

export function resolveMuseConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return museConfigDir({ env });
}

export function museAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMuseConfigDir(env), "auth.json");
}

/**
 * The provider ids `auth.json` holds a credential for, or null when the file is
 * absent or not Muse's shape. Values are only tested for being non-empty
 * strings, never kept.
 */
export function readMuseAuthFileProviders(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const providers = (parsed as Record<string, unknown>).providers;
    if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return null;
    return Object.entries(providers)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
      .map(([id]) => id);
  } catch {
    return null;
  }
}

export type MuseCredentialSnapshot = {
  /** `META_API_KEY` is set in ADE's own environment. */
  envKey: boolean;
  /** A Muse API key is saved in ADE's key store. */
  storedKey: boolean;
  /** `auth.json` holds a credential (a `muse login` or `muse auth set`). */
  authFile: boolean;
  authFilePath: string;
  /** The strongest source, in Muse's own precedence order. */
  source: "muse-env" | "muse-api-key-store" | "muse-auth-file" | null;
};

function defaultReadText(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

export function inspectMuseCredentials(args: {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (target: string) => string | null;
} = {}): MuseCredentialSnapshot {
  const env = args.env ?? process.env;
  const authFilePath = museAuthFilePath(env);
  const envKey = Boolean(env[MUSE_API_KEY_ENV]?.trim());
  const storedKey = museStoredApiKeyPresent();
  const providers = readMuseAuthFileProviders((args.readTextFile ?? defaultReadText)(authFilePath));
  const authFile = Boolean(providers && providers.length > 0);
  return {
    envKey,
    storedKey,
    authFile,
    authFilePath,
    source: envKey ? "muse-env" : storedKey ? "muse-api-key-store" : authFile ? "muse-auth-file" : null,
  };
}

/** True when ADE's key store holds a Muse API key. Never throws. */
export function museStoredApiKeyPresent(): boolean {
  try {
    return listApiCredentials(MUSE_CREDENTIAL_PROVIDER).length > 0;
  } catch {
    return false;
  }
}

/**
 * Environment to add to a `muse` spawn (chat host or terminal) so it can use a
 * key saved in ADE. Empty when the environment already carries
 * `META_API_KEY` (it wins in Muse, and must win here too), or when no key is
 * saved. The key travels in the environment only, never on argv, so it does
 * not show up in a process listing.
 */
export function museCredentialEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  credentialId?: string,
): Record<string, string> {
  if (baseEnv[MUSE_API_KEY_ENV]?.trim()) return {};
  let key: string | null = null;
  try {
    if (credentialId) {
      key = getApiCredentialKey(MUSE_CREDENTIAL_PROVIDER, credentialId);
    } else {
      // The default slot first, then any other saved Muse key.
      key = getApiKey(MUSE_CREDENTIAL_PROVIDER);
      if (!key) {
        const first = listApiCredentials(MUSE_CREDENTIAL_PROVIDER)[0];
        key = first ? getApiCredentialKey(MUSE_CREDENTIAL_PROVIDER, first.credentialId) : null;
      }
    }
  } catch {
    key = null;
  }
  return key?.trim() ? { [MUSE_API_KEY_ENV]: key.trim() } : {};
}
