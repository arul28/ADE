/**
 * Read the Qwen CLI's own settings without spawning it.
 *
 * ADE does not configure Qwen. Users sign in (or point it at an
 * OpenAI-compatible server) inside the Qwen CLI. This module is how ADE
 * notices that work: `~/.qwen/settings.json` (or `$QWEN_HOME/settings.json`)
 * holds the custom provider, the selected model, and the env-key slot the
 * CLI uses for the API key.
 *
 * Never return the key itself. Callers need "is there a key" and "which
 * model ids did they configure".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { qwenConfigHome } from "../shared/providerConfigHomes";

export type QwenSettingsModel = {
  id: string;
  displayName: string;
};

export type QwenUserSettings = {
  authenticated: boolean;
  models: QwenSettingsModel[];
  defaultModelId: string | null;
};

const EMPTY: QwenUserSettings = {
  authenticated: false,
  models: [],
  defaultModelId: null,
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

function openaiProviders(settings: Record<string, unknown>): Array<Record<string, unknown>> {
  const providers = asRecord(settings.modelProviders);
  const openai = providers?.openai;
  if (!Array.isArray(openai)) return [];
  return openai.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
}

/**
 * Parse a Qwen `settings.json` object. Used by tests and by the disk reader.
 * Ignores unknown keys so a newer CLI schema cannot crash ADE.
 */
export function parseQwenUserSettings(raw: unknown): QwenUserSettings {
  const settings = asRecord(raw);
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
  };
}

/** Load Qwen's settings from its config home. Missing or unreadable files are empty, not errors. */
export async function loadQwenUserSettings(args: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): Promise<QwenUserSettings> {
  const root = qwenConfigHome(args);
  try {
    const raw = JSON.parse(await readFile(path.join(root, "settings.json"), "utf8")) as unknown;
    return parseQwenUserSettings(raw);
  } catch {
    return EMPTY;
  }
}
