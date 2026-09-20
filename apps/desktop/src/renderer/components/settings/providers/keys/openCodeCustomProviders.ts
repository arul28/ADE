/**
 * OpenCode's custom provider blocks, read and written as a list.
 *
 * `ai.updateConfig` merges with replace semantics for arrays, so every write
 * here sends the WHOLE list with one entry added, changed, or dropped. Sending
 * only the entry being touched deletes every other custom provider — the
 * original form got this right by accident and nothing recorded why.
 *
 * The npm package the old form asked for is not a separate decision from the
 * protocol: each package IS one wire protocol. So the sheet asks for the
 * protocol in plain words and this maps it back.
 */
import type { AiCustomProviderConfig } from "../../../../../shared/types/config";
import type { ProviderKeyProtocol } from "./providerKeySpecs";

type CustomProviderNpm = NonNullable<AiCustomProviderConfig["npm"]>;

const PROTOCOL_TO_NPM: Record<ProviderKeyProtocol, CustomProviderNpm> = {
  "openai-compatible": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
};

const NPM_TO_PROTOCOL: Record<CustomProviderNpm, ProviderKeyProtocol> = {
  "@ai-sdk/openai-compatible": "openai-compatible",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic",
};

export function npmForProtocol(protocol: ProviderKeyProtocol | null): CustomProviderNpm {
  return protocol ? PROTOCOL_TO_NPM[protocol] : "@ai-sdk/openai-compatible";
}

export function protocolForNpm(npm: AiCustomProviderConfig["npm"]): ProviderKeyProtocol {
  return npm ? NPM_TO_PROTOCOL[npm] : "openai-compatible";
}

/** The list with `entry` added or replacing the same id. */
export function withCustomProvider(
  existing: readonly AiCustomProviderConfig[],
  entry: AiCustomProviderConfig,
): AiCustomProviderConfig[] {
  return [...existing.filter((row) => row.id !== entry.id), entry];
}

/** The list with `id` dropped. */
export function withoutCustomProvider(
  existing: readonly AiCustomProviderConfig[],
  id: string,
): AiCustomProviderConfig[] {
  return existing.filter((row) => row.id !== id);
}

export async function saveCustomProviders(next: AiCustomProviderConfig[]): Promise<void> {
  await window.ade.ai.updateConfig({ customProviders: next });
}

/**
 * Write the config block for one custom provider, keeping every other one.
 *
 * Shared by the two places a custom provider can be created — the API keys
 * panel's + Add on the OpenCode page and the custom providers list below it —
 * so neither can drift into a different idea of what a block looks like.
 */
export async function persistOpenCodeProviderBlock(
  entries: readonly AiCustomProviderConfig[],
  draft: {
    providerId: string;
    label: string;
    baseUrl: string;
    protocol: ProviderKeyProtocol | null;
    models: string[];
  },
): Promise<void> {
  const id = draft.providerId.trim();
  if (!id) return;
  await saveCustomProviders(withCustomProvider(entries, {
    id,
    name: draft.label.trim() || id,
    baseURL: draft.baseUrl.trim(),
    npm: npmForProtocol(draft.protocol),
    models: draft.models,
  }));
}
