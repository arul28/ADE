import fs from "node:fs";
import path from "node:path";
import type { AgentChatUsageAccountKind } from "../../../shared/types/chat";
import type { AiPiProviderStatus } from "../../../shared/types/config";
import { isLoopbackHostname } from "../../../shared/remoteLoopbackUrl";
import type { PiSdkAccount } from "./piSdkProtocol";
import { piProviderHasEnvKey } from "./piSdkEnvironment";
import { asRecord, toOptionalString } from "../shared/utils";

/**
 * How Pi's own files say a provider authenticates. Settings
 * (`ai/piInstallation.ts`) and the Pi worker's per-turn account both read
 * these, each under its own rules (see `PiAuthRules`).
 *
 * No Pi imports on purpose: the Pi worker process loads it.
 */

export type PiAuthType = AiPiProviderStatus["authType"];

/**
 * Which rules classify a provider. Every caller names one.
 *
 * - `"settings"`: what Settings shows (the Pi providers panel and the picker's
 *   auth types). Frozen: usage telemetry must never change what Settings says,
 *   so these rules read only the profile files and the five loopback spellings
 *   Settings has always known.
 * - `"turn"`: the account a Pi turn reports for usage. It also reads an untyped
 *   `{ key }` entry as an API key, every loopback host (`127.0.0.0/8`,
 *   `*.localhost`), and a provider API key set in the worker's environment.
 */
export type PiAuthRules = "settings" | "turn";
export type PiAuthOptions = { rules: PiAuthRules };

const TURN_RULES: PiAuthOptions = { rules: "turn" };

/** The loopback hosts Settings has always recognized. */
const SETTINGS_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * True when the base URL is served from this machine.
 *
 * Deliberately host-based rather than key-based: a placeholder API key means
 * nothing, and a remote provider reached through a custom `baseUrl` proxy is
 * still a remote provider the user must authenticate to.
 */
export function isPiLoopbackBaseUrl(value: unknown, options: PiAuthOptions): boolean {
  const raw = toOptionalString(value);
  if (!raw) return false;
  try {
    const hostname = new URL(raw).hostname;
    return options.rules === "settings"
      ? SETTINGS_LOOPBACK_HOSTS.has(hostname.toLowerCase())
      : isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/**
 * The credential kind of one `auth.json` entry. Never returns a secret. Pi
 * writes `{ type: "api_key", key }` or `{ type: "oauth", access, refresh,
 * expires }`; an entry without a `type` is judged by its field names.
 */
export function piAuthSummary(
  value: unknown,
  options: PiAuthOptions,
): { type: PiAuthType; expiresAt?: number | null } {
  const entry = asRecord(value);
  if (!entry) return { type: null };
  const type = toOptionalString(entry.type)?.toLowerCase();
  const expires = typeof entry.expires === "number" ? entry.expires : null;
  if (type === "oauth" || type === "token") return { type: "oauth", expiresAt: expires };
  if (type === "api-key" || type === "apikey" || type === "api_key") return { type: "api-key", expiresAt: expires };
  if (options.rules === "turn" && entry.key != null) return { type: "api-key", expiresAt: expires };
  if (entry.apiKey != null || entry.api_key != null) return { type: "api-key", expiresAt: expires };
  if (Object.keys(entry).some((key) => /key|token|access|refresh/i.test(key))) return { type: "oauth", expiresAt: expires };
  return { type: "unknown", expiresAt: expires };
}

/** What one provider's config and environment say about its credential. */
export type PiProviderAuthEvidence = {
  /** The provider's `auth.json` entry, if any. */
  authEntry?: unknown;
  /** The provider's configured base URL (`models.json`, or a loopback registry default). */
  baseUrl?: unknown;
  /** A key configured beside the provider (`models.json` `apiKey`). */
  configKey?: unknown;
  /** True when the provider's API key variable is set in the environment. Read by `"turn"` rules only. */
  envKey?: boolean;
};

/**
 * How one Pi provider authenticates:
 * 1. a stored `auth.json` entry wins: it is the one real evidence of an
 *    interactive credential, so a provider behind a local gateway keeps it;
 * 2. a loopback base URL is a server the user runs, whatever placeholder key
 *    it ships (LM Studio's `apiKey: "lmstudio"`);
 * 3. a key in the config (or, under `"turn"` rules, the environment) is an API key;
 * 4. any other base URL with no key is an endpoint the user configured;
 * 5. otherwise nothing is known.
 */
export function piProviderAuthType(evidence: PiProviderAuthEvidence, options: PiAuthOptions): PiAuthType {
  const stored = piAuthSummary(evidence.authEntry, options).type;
  if (stored) return stored;
  if (isPiLoopbackBaseUrl(evidence.baseUrl, options)) return "local";
  if (evidence.configKey || (options.rules === "turn" && evidence.envKey)) return "api-key";
  if (evidence.baseUrl) return "local";
  return null;
}

/** The turn account kind for one provider, by `"turn"` rules. */
export function piProviderAccountKind(evidence: PiProviderAuthEvidence): AgentChatUsageAccountKind {
  switch (piProviderAuthType(evidence, TURN_RULES)) {
    case "oauth":
      return "subscription";
    case "api-key":
      return "api_key";
    case "local":
      return "local";
    default:
      return "unknown";
  }
}

/**
 * A per-provider memo for the Pi worker's account readings. A reading is
 * reused until `readStamp` changes (a sign-in or sign-out rewrote the profile
 * files, from ADE or the Pi CLI) or `forget` drops one provider after an
 * in-worker sign-in, so a credential change never leaves turns on the old kind.
 */
export function createPiAccountMemo<T>(readStamp: () => string): {
  get(providerId: string, read: () => T): T;
  forget(providerId: string): void;
  clear(): void;
} {
  const entries = new Map<string, T>();
  let stamp: string | null = null;
  return {
    get(providerId, read) {
      const current = readStamp();
      if (current !== stamp) {
        entries.clear();
        stamp = current;
      }
      if (entries.has(providerId)) return entries.get(providerId)!;
      const value = read();
      entries.set(providerId, value);
      return value;
    },
    forget(providerId) {
      entries.delete(providerId);
    },
    clear() {
      entries.clear();
      stamp = null;
    },
  };
}

const PROFILE_FILES = ["auth.json", "models.json"] as const;
type PiProfileFile = (typeof PROFILE_FILES)[number];

/** A provider's entry in one of the profile's JSON files, or null. */
function profileFileEntry(agentDir: string, fileName: PiProfileFile, providerId: string): Record<string, unknown> | null {
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(path.join(agentDir, fileName), "utf8")));
    return asRecord((fileName === "models.json" ? asRecord(parsed?.providers) : parsed)?.[providerId]);
  } catch {
    return null;
  }
}

/** Changes whenever a sign-in or sign-out rewrites the profile, from ADE or the Pi CLI. */
function profileFilesStamp(agentDir: string | null): string {
  if (!agentDir) return "";
  return PROFILE_FILES.map((fileName) => {
    try {
      const stat = fs.statSync(path.join(agentDir, fileName));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "-";
    }
  }).join("|");
}

/**
 * The Pi worker's per-turn account reader. It classifies a provider by
 * `"turn"` rules from the profile's `auth.json` and `models.json` under
 * `agentDir()`, falling back to Pi's live registry entry (`getProvider`) for a
 * built-in. A registry base URL counts only when it is loopback: every
 * built-in cloud provider ships its own cloud URL, which would otherwise read
 * as an endpoint the user runs. Never returns or logs a credential value, and
 * memoizes per provider until the profile files change.
 */
export function createPiAccountReader(args: {
  agentDir: () => string | null | undefined;
  getProvider: (providerId: string) => Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}): {
  accountFor(providerId: string): PiSdkAccount;
  forget(providerId: string): void;
  clear(): void;
} {
  const memo = createPiAccountMemo<PiSdkAccount>(() => profileFilesStamp(args.agentDir() ?? null));
  const read = (providerId: string): PiSdkAccount => {
    const agentDir = args.agentDir();
    const authEntry = agentDir ? profileFileEntry(agentDir, "auth.json", providerId) : null;
    const fileConfig = agentDir ? profileFileEntry(agentDir, "models.json", providerId) : null;
    let registry: Record<string, unknown> | null = null;
    if (!fileConfig) {
      try {
        registry = args.getProvider(providerId);
      } catch {
        registry = null;
      }
    }
    const baseUrl = fileConfig
      ? fileConfig.baseUrl
      : isPiLoopbackBaseUrl(registry?.baseUrl, TURN_RULES) ? registry?.baseUrl : undefined;
    const accountId = providerId === "openai-codex" ? toOptionalString(authEntry?.accountId) : null;
    return {
      kind: piProviderAccountKind({
        authEntry,
        baseUrl,
        configKey: (fileConfig ?? registry)?.apiKey,
        envKey: piProviderHasEnvKey(providerId, args.env ?? process.env),
      }),
      upstream: providerId,
      ...(accountId ? { accountId } : {}),
    };
  };
  return {
    accountFor: (providerId) => memo.get(providerId, () => read(providerId)),
    forget: (providerId) => memo.forget(providerId),
    clear: () => memo.clear(),
  };
}

/**
 * An assistant `message_end` event with its provider's turn account attached
 * (`message.account`), or the event unchanged when the message names no
 * provider.
 */
export function withPiTurnAccount(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  accountFor: (providerId: string) => PiSdkAccount,
): Record<string, unknown> {
  const providerId = toOptionalString(message.provider);
  return providerId ? { ...event, message: { ...message, account: accountFor(providerId) } } : event;
}
