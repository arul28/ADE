/**
 * Read the Qwen CLI's own settings without spawning it.
 *
 * ADE does not configure Qwen. Users sign in (or point it at an
 * OpenAI-compatible server) inside the Qwen CLI. This module is how ADE
 * notices that work: `~/.qwen/settings.json` (or `$QWEN_HOME/settings.json`)
 * holds the custom provider, the selected model, and the env-key slot the
 * CLI uses for the API key.
 *
 * Never return the key itself. Callers need "is there a key", "which model
 * ids did they configure", "which auth type is selected", and "where is the
 * model served from" (an origin, never the full base URL).
 *
 * The file is JSONC: the Qwen CLI accepts `//` and block comments in it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { urlOriginOnly } from "../../../shared/remoteLoopbackUrl";
import { qwenConfigHome } from "../shared/providerConfigHomes";

export type QwenSettingsModel = {
  id: string;
  displayName: string;
};

export type QwenUserSettings = {
  authenticated: boolean;
  models: QwenSettingsModel[];
  defaultModelId: string | null;
  /**
   * `security.auth.selectedType`: the upstream the NEXT session picks
   * (`openai`, `anthropic`, `qwen-oauth`, ...).
   */
  selectedType: string | null;
  /**
   * Origin of `model.baseUrl`. Only the origin: a base URL can carry a key
   * in its userinfo or query.
   */
  baseUrlOrigin: string | null;
};

const EMPTY: QwenUserSettings = {
  authenticated: false,
  models: [],
  defaultModelId: null,
  selectedType: null,
  baseUrlOrigin: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length ? next : null;
}

/** Drop `//` and block comments outside strings. The rest stays byte for byte. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const lineEnd = text.indexOf("\n", index);
      if (lineEnd === -1) break;
      index = lineEnd - 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const blockEnd = text.indexOf("*/", index + 2);
      if (blockEnd === -1) break;
      index = blockEnd + 1;
      continue;
    }
    if (char === "\"") inString = true;
    out += char;
  }
  return out;
}

/** Parse settings text as JSON, then as JSONC. `null` when neither reads. */
function parseSettingsText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the comment-tolerant read.
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function openaiProviders(settings: Record<string, unknown>): Array<Record<string, unknown>> {
  const providers = asRecord(settings.modelProviders);
  const openai = providers?.openai;
  if (!Array.isArray(openai)) return [];
  return openai.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
}

/**
 * Parse a Qwen `settings.json`: the file's text (JSON or JSONC) or an
 * already-parsed object. Ignores unknown keys so a newer CLI schema cannot
 * crash ADE; text that does not parse reads as empty settings.
 */
export function parseQwenUserSettings(raw: unknown): QwenUserSettings {
  const settings = asRecord(typeof raw === "string" ? parseSettingsText(raw) : raw);
  if (!settings) return EMPTY;

  const security = asRecord(settings.security);
  const auth = asRecord(security?.auth);
  const env = asRecord(settings.env) ?? {};
  const providers = openaiProviders(settings);
  const model = asRecord(settings.model);

  const hasInlineApiKey = Boolean(trimmedString(auth?.apiKey));
  const hasProviderKey = providers.some((entry) => {
    const envKey = trimmedString(entry.envKey);
    return Boolean(envKey && trimmedString(env[envKey]));
  });
  const models: QwenSettingsModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, displayName: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    models.push({ id, displayName });
  };

  const defaultModelId = trimmedString(model?.name);
  if (defaultModelId) push(defaultModelId, defaultModelId);
  for (const entry of providers) {
    const id = trimmedString(entry.id) ?? trimmedString(entry.name);
    if (!id) continue;
    push(id, trimmedString(entry.name) ?? id);
  }

  return {
    authenticated: hasInlineApiKey || hasProviderKey,
    models,
    defaultModelId,
    selectedType: trimmedString(auth?.selectedType),
    baseUrlOrigin: urlOriginOnly(trimmedString(model?.baseUrl)),
  };
}

/** Load Qwen's settings from its config home. Missing or unreadable files are empty, not errors. */
export async function loadQwenUserSettings(args: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<QwenUserSettings> {
  const root = qwenConfigHome(args);
  try {
    return parseQwenUserSettings(await readFile(path.join(root, "settings.json"), "utf8"));
  } catch {
    return EMPTY;
  }
}
