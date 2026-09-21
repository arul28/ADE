/**
 * Which models a chosen source can actually run.
 *
 * The source, not the harness, decides the model list: a Claude account offers
 * Anthropic models whichever harness is driving it, and an OpenRouter key
 * offers OpenRouter's. Filtering by the harness instead is what produced the
 * old "pick Droid, get Claude-only models" confusion, so the mapping below goes
 * from source → provider family and the list follows it.
 *
 * Two lists feed that mapping, in this order:
 *
 * 1. The LIVE runtime catalog — the same `chat.modelCatalog` the composer's
 *    ModelPicker reads. Cursor, OpenCode, Pi and the ACP CLIs enumerate their
 *    models at run time and have no static rows, so the static registry alone
 *    reported "no models" for them and the wizard fell back to a text box.
 *    Reading the catalog the composer already warms is what closes that seam.
 *    The caller passes the catalog in; fetching it belongs to
 *    `ModelPicker/useRuntimeCatalogForFamily`, so this module stays pure.
 * 2. The static `MODEL_REGISTRY` — the fallback for an older host with no
 *    `agentChat.modelCatalog` bridge, and for a catalog request that fails. A
 *    shorter list is still a list; dropping to free text is not.
 */

import {
  MODEL_REGISTRY,
  getModelById,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import {
  descriptorsFromAgentChatModelCatalog,
  resolveModelDescriptorWithRuntimeCatalog,
} from "../../shared/ModelPicker/modelCatalog";
// Settings has no bound machine, so it reads the default bucket — the same one
// an unpinned composer fills. Sharing the bucket is the point: a wizard opened
// after a composer has already listed models does not fetch again.
import { DEFAULT_RUNTIME_CATALOG_SCOPE } from "../../shared/ModelPicker/runtimeCatalogCache";
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
function modelsForFamily(family: ProviderFamily | null): ModelDescriptor[] {
  if (!family) return [];
  return MODEL_REGISTRY.filter((model) => model.family === family && !model.deprecated);
}

/**
 * Whether the source's model id must be typed rather than picked.
 *
 * Typing is the last resort, not a shortcut: the owner's complaint was a text
 * box shown next to a provider ADE could enumerate perfectly well. So this
 * answers from the same resolution the select uses — if anything can list a
 * model for this source, the user picks from that list.
 *
 * Two cases survive. A key pointing at a custom OpenAI-compatible endpoint that
 * declares no models of its own: nothing enumerates that endpoint, not the
 * registry and not the runtime catalog. And a first-class key provider that
 * neither list covers — OpenRouter, Google, DeepSeek, Mistral, Groq and
 * Together have no static registry rows and no catalog group that maps back to
 * them, so without this branch the wizard would offer an empty select and the
 * preset could never be finished.
 */
export function sourceNeedsFreeTextModel(
  source: HarnessPresetSource | null | undefined,
  keyRow?: HarnessKeySource | null,
  catalog?: AgentChatModelCatalog | null,
): boolean {
  if (source?.kind !== "key") return false;
  if (keyRow?.models && keyRow.models.length > 0) return false;
  if (keyRow?.baseUrl) return true;
  return modelChoicesForSource(source, keyRow, catalog).length === 0;
}

/** Rows the live catalog reports for one family, in catalog order. */
function runtimeModelChoices(
  catalog: AgentChatModelCatalog | null | undefined,
  family: ProviderFamily | null,
): Array<{ id: string; label: string }> {
  if (!catalog || !family) return [];
  const { models } = descriptorsFromAgentChatModelCatalog(
    catalog,
    (model) => model.family === family,
    DEFAULT_RUNTIME_CATALOG_SCOPE,
  );
  return models.map((model) => ({ id: model.id, label: model.displayName }));
}

/**
 * The model ids a source offers.
 *
 * A custom endpoint's own declared models win, then the live catalog, then the
 * static registry. `catalog` is optional so the pure callers (tests, any future
 * non-React surface) keep working on the registry alone.
 */
export function modelChoicesForSource(
  source: HarnessPresetSource | null | undefined,
  keyRow?: HarnessKeySource | null,
  catalog?: AgentChatModelCatalog | null,
): Array<{ id: string; label: string }> {
  if (source?.kind === "key" && keyRow?.models && keyRow.models.length > 0) {
    return keyRow.models.map((id) => ({ id, label: id }));
  }
  const family = providerFamilyForSource(source);
  const runtime = runtimeModelChoices(catalog, family);
  if (runtime.length > 0) return runtime;
  return modelsForFamily(family).map((model) => ({
    id: model.id,
    label: model.displayName,
  }));
}

/**
 * Display name for a model id.
 *
 * The live catalog answers first, because a runtime-only model (a Cursor or
 * OpenCode row) has no registry entry and would otherwise read as its raw slug
 * in the summary chip. The registry answers next, and the id itself last.
 */
export function harnessModelLabel(
  modelId: string,
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
): string {
  return resolveModelDescriptorWithRuntimeCatalog(modelId, scopeKey)?.displayName ?? modelId;
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
