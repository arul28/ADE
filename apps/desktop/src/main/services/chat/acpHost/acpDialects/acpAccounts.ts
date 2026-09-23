/**
 * Who pays for an ACP provider's turns, read from local config.
 *
 * Every reader here is synchronous, local, and read-only. None makes a network
 * call, and none returns a token: a credential file is opened only to learn
 * what KIND of login it holds, and every secret field in it is left untouched.
 * The account email is not read here; ADE's quota service fills it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatUsageAccount } from "../../../../../shared/types";
import { loopbackOrigin } from "../../../../../shared/remoteLoopbackUrl";
import { parseQwenUserSettings } from "../../../ai/qwenUserSettings";
import { resolveKimiCodeLogin } from "../../../shared/kimiCodeLogin";
import { grokConfigHome, qwenConfigHome } from "../../../shared/providerConfigHomes";
import { asRecord, toOptionalString } from "../../../shared/utils";

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  const text = readText(filePath);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim().length);
}

/**
 * Grok: a `grok login` session in `$GROK_HOME/auth.json` is the user's plan
 * login, and it outranks `XAI_API_KEY` the same way the CLI ranks them.
 */
export function readGrokAccount({ env }: { env: NodeJS.ProcessEnv }): AgentChatUsageAccount {
  const auth = readJsonObject(path.join(grokConfigHome({ env }), "auth.json"));
  const modes = auth
    ? Object.values(auth).flatMap((entry) => {
      const mode = toOptionalString(asRecord(entry)?.auth_mode);
      return mode ? [mode.toLowerCase()] : [];
    })
    : [];
  if (modes.length) {
    return { provider: "grok", kind: modes.every((mode) => mode.includes("key")) ? "api_key" : "subscription" };
  }
  if (hasEnv(env, "XAI_API_KEY")) return { provider: "grok", kind: "api_key" };
  return { provider: "grok", kind: "unknown" };
}

/** Copilot: every login, token or CLI, runs on a GitHub Copilot plan. */
export function readCopilotAccount(): AgentChatUsageAccount {
  return { provider: "copilot", kind: "subscription" };
}

/**
 * Kimi: a `kimi login` leaves a token file under `$KIMI_CODE_HOME/credentials`,
 * which is the Kimi Code plan. `resolveKimiCodeLogin` finds it in the slot
 * Kimi itself reads, a `--region global` login included. Only the file's
 * existence is checked.
 */
export function readKimiAccount({ env }: { env: NodeJS.ProcessEnv }): AgentChatUsageAccount {
  if (resolveKimiCodeLogin({ env })) return { provider: "kimi", kind: "subscription" };
  if (hasEnv(env, "MOONSHOT_API_KEY")) return { provider: "kimi", kind: "api_key" };
  return { provider: "kimi", kind: "unknown" };
}

/** Qwen's auth type for a signed-in Qwen account, as opposed to an API key. */
export const QWEN_OAUTH_AUTH_TYPE = "qwen-oauth";

/**
 * Qwen: the auth type names the upstream (`openai`, `anthropic`, `gemini`,
 * `qwen-oauth`, ...). `qwen-oauth` is a Qwen account. Any other type talking
 * to a loopback `model.baseUrl` (or `OPENAI_BASE_URL`) is a `local` account,
 * because the base URL names a server or proxy on this machine rather than a
 * vendor, and its origin is reported as the endpoint. Every other type is an
 * API key. `authType` from a usage row beats the settings file, which only
 * says what the NEXT session picks.
 */
export function readQwenAccount({
  env,
  authType,
}: {
  env: NodeJS.ProcessEnv;
  authType?: string | null;
}): AgentChatUsageAccount {
  const settings = parseQwenUserSettings(readText(path.join(qwenConfigHome({ env }), "settings.json")));
  const type = toOptionalString(authType) ?? settings.selectedType ?? null;
  if (!type || type === "unknown") return { provider: "qwen", kind: "unknown" };
  if (type === QWEN_OAUTH_AUTH_TYPE) return { provider: "qwen", kind: "subscription", upstream: type };
  const endpoint = loopbackOrigin(settings.baseUrlOrigin ?? env.OPENAI_BASE_URL);
  return endpoint
    ? { provider: "qwen", kind: "local", upstream: type, endpoint }
    : { provider: "qwen", kind: "api_key", upstream: type };
}
