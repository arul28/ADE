/**
 * Which models a chosen brain can actually run.
 *
 * The brain, not the harness, decides the model list: a Claude account offers
 * Anthropic models whichever harness is driving it, and an OpenRouter key
 * offers OpenRouter's. Filtering by the harness instead is what produced the
 * old "pick Droid, get Claude-only models" confusion, so the mapping below goes
 * from source → provider family and the registry filter follows it.
 *
 * A key pointing at a custom OpenAI-compatible endpoint has no registry entry
 * at all. Those get free text, because the only list of their models is the one
 * the endpoint itself declares, and ADE refuses to guess an id on the user's
 * behalf.
 */

import {
  MODEL_REGISTRY,
  getModelById,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import type { HarnessPresetSource } from "../../../../shared/harnessPresets";
import type { HarnessKeySource } from "./harnessSources";

/**
 * Key-store provider ids → registry families. The two vocabularies agree for
 * most providers and disagree for exactly these, which is why the map exists
 * rather than a cast.
 */
const KEY_PROVIDER_FAMILIES: Record<string, ProviderFamily> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "google-vertex": "google",
  gemini: "google",
  mistral: "mistral",
  deepseek: "deepseek",
  xai: "xai",
  grok: "xai",
  groq: "groq",
  together: "together",
  openrouter: "openrouter",
  moonshotai: "moonshot",
  moonshot: "moonshot",
  "kimi-for-coding": "moonshot",
  qwen: "qwen",
  cursor: "cursor",
  factory: "factory",
  droid: "factory",
  copilot: "github-copilot",
  "github-copilot": "github-copilot",
  ollama: "ollama",
  lmstudio: "lmstudio",
  opencode: "opencode",
  pi: "pi",
};

/** The registry family a source's models come from, or null when unmapped. */
export function providerFamilyForSource(source: HarnessPresetSource | null | undefined): ProviderFamily | null {
  if (!source) return null;
  if (source.kind === "account" || source.kind === "subscription") {
    return source.provider === "claude" ? "anthropic" : "openai";
  }
  return KEY_PROVIDER_FAMILIES[source.provider.trim().toLowerCase()] ?? null;
}

/** Live, non-deprecated models for a family, ordered the way the registry is. */
export function modelsForFamily(family: ProviderFamily | null): ModelDescriptor[] {
  if (!family) return [];
  return MODEL_REGISTRY.filter((model) => model.family === family && !model.deprecated);
}

/**
 * Whether the source's models must be typed rather than picked.
 *
 * True for a custom endpoint that declares no models of its own, for a key
 * whose provider the registry has never heard of, and for a key whose family
 * the registry names but holds no live model for (DeepSeek and Mistral keys are
 * filed by vendor while their catalog rows route through OpenCode). A select
 * with nothing but "Choose a model" in it is a dead end, so any empty list
 * becomes a text box.
 */
export function sourceNeedsFreeTextModel(
  source: HarnessPresetSource | null | undefined,
  keyRow?: HarnessKeySource | null,
): boolean {
  if (!source) return false;
  if (source.kind !== "key") return false;
  if (keyRow?.models && keyRow.models.length > 0) return false;
  if (keyRow?.baseUrl) return true;
  const family = providerFamilyForSource(source);
  return family === null || modelsForFamily(family).length === 0;
}

/** The model ids a source offers, custom-endpoint models included. */
export function modelChoicesForSource(
  source: HarnessPresetSource | null | undefined,
  keyRow?: HarnessKeySource | null,
): Array<{ id: string; label: string }> {
  if (source?.kind === "key" && keyRow?.models && keyRow.models.length > 0) {
    return keyRow.models.map((id) => ({ id, label: id }));
  }
  return modelsForFamily(providerFamilyForSource(source)).map((model) => ({
    id: model.id,
    label: model.displayName,
  }));
}

/** Display name for a model id, falling back to the id the user typed. */
export function harnessModelLabel(modelId: string): string {
  return getModelById(modelId)?.displayName ?? modelId;
}

/** Models a subagent can be pinned to — the same list the main model comes from. */
export function subagentModelChoices(
  source: HarnessPresetSource | null | undefined,
  keyRow?: HarnessKeySource | null,
): Array<{ id: string; label: string }> {
  return modelChoicesForSource(source, keyRow);
}

/**
 * The registry family a model id belongs to, for its row logo.
 *
 * A custom endpoint's model has no registry row, and guessing a brand from a
 * string like `gpt-4o-ish` is how a row ends up wearing the wrong company's
 * mark — so an unknown id gets no family and no logo rather than a plausible
 * lie.
 */
export function harnessModelFamily(modelId: string): ProviderFamily | null {
  return getModelById(modelId)?.family ?? null;
}
