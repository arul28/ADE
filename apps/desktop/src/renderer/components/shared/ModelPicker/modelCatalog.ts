import {
  createDynamicCursorCliModelDescriptor,
  createDynamicDroidCliModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  CURSOR_CANONICAL_MODEL_IDS,
  DROID_CANONICAL_MODEL_IDS,
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  OPENCODE_CANONICAL_PROVIDER_MODELS,
  getLocalModelIdTail,
  parseDynamicDroidModelRef,
  parseDynamicOpenCodeModelRef,
  parseLocalProviderFromModelId,
  resolveModelDescriptor,
  type ModelDescriptor,
} from "../../../../shared/modelRegistry";
import { PROVIDER_BADGE_COLORS } from "../providerModelSelectorGrouping";

/**
 * Canonical descriptors for dynamic-only providers (Droid, Cursor, OpenCode).
 * These are surfaced in the picker even when the provider isn't authed so the
 * user can see the catalog and follow a Sign in CTA. When the provider IS
 * authed, real discovery results land in `availableModelIds` and override
 * these (`mergeSelectorModels` de-dups by id).
 *
 * `MODEL_REGISTRY` already supplies canonical static descriptors for Anthropic
 * (Claude), OpenAI (Codex), and Ollama, so they don't appear here.
 */
function buildDynamicCanonicalDescriptors(): ModelDescriptor[] {
  const descriptors: ModelDescriptor[] = [];
  for (const id of DROID_CANONICAL_MODEL_IDS) {
    descriptors.push(createDynamicDroidCliModelDescriptor(id));
  }
  for (const id of CURSOR_CANONICAL_MODEL_IDS) {
    descriptors.push(createDynamicCursorCliModelDescriptor(id));
  }
  for (const pair of OPENCODE_CANONICAL_PROVIDER_MODELS) {
    descriptors.push(
      createDynamicOpenCodeModelDescriptor("", {
        openCodeProviderId: pair.providerId,
        openCodeModelId: pair.modelId,
      }),
    );
  }
  return descriptors;
}

let dynamicCanonicalCache: ModelDescriptor[] | null = null;
/**
 * Cached list of canonical descriptors for dynamic-only providers. Exposed so
 * the picker's "expanded" view (when the Show all models toggle is on) can
 * include the same canonical entries that `mergeSelectorModels` injects.
 */
export function dynamicCanonicalDescriptors(): ModelDescriptor[] {
  if (!dynamicCanonicalCache) dynamicCanonicalCache = buildDynamicCanonicalDescriptors();
  return dynamicCanonicalCache;
}

export function createUnknownModelPlaceholder(modelId: string): ModelDescriptor {
  const openCode = parseDynamicOpenCodeModelRef(modelId);
  if (openCode) {
    return createDynamicOpenCodeModelDescriptor(openCode.modelId);
  }
  if (modelId.startsWith("cursor/")) {
    const tail = modelId.slice("cursor/".length);
    return {
      id: modelId,
      shortId: tail || modelId,
      displayName: tail || modelId,
      family: "cursor",
      authTypes: ["api-key"],
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
      color: "#A78BFA",
      providerRoute: "cursor-sdk",
      providerModelId: tail || modelId,
      cliCommand: "cursor",
      isCliWrapped: false,
    };
  }
  const droidCli = parseDynamicDroidModelRef(modelId);
  if (droidCli) {
    return createDynamicDroidCliModelDescriptor(droidCli.providerModelId);
  }
  const localProvider = parseLocalProviderFromModelId(modelId);
  if (localProvider) {
    const shortId = getLocalModelIdTail(modelId, localProvider) || modelId;
    const brand = LOCAL_PROVIDER_LABELS[localProvider];
    return {
      id: modelId,
      shortId,
      displayName: shortId,
      family: localProvider,
      authTypes: ["local"],
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: { tools: false, vision: false, reasoning: false, streaming: true },
      color: PROVIDER_BADGE_COLORS[localProvider] ?? "#64748B",
      providerRoute: "openai-compatible",
      providerModelId: shortId,
      isCliWrapped: false,
      discoverySource: localProvider === "lmstudio" ? "lmstudio-openai" : localProvider,
      harnessProfile: "guarded",
      aliases: brand ? [brand] : [],
    };
  }
  return {
    id: modelId,
    shortId: modelId,
    displayName: modelId,
    family: "openrouter",
    authTypes: ["api-key"],
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: { tools: false, vision: false, reasoning: false, streaming: false },
    color: "#6B7280",
    providerRoute: "unknown",
    providerModelId: modelId,
    isCliWrapped: false,
  };
}

/**
 * Models reached via the OpenCode runtime are family-mapped to their underlying
 * vendor ("anthropic", "openai", etc.) so they show the correct logo elsewhere
 * in the app. The picker groups them under a single "OpenCode" rail entry, so
 * we override `family` to `"opencode"` here while keeping `openCodeProviderId`
 * intact for sub-provider sub-headers and row logos.
 */
function rebucketOpenCodeFamily(model: ModelDescriptor): ModelDescriptor {
  if (model.providerRoute !== "opencode") return model;
  if (model.family === "opencode") return model;
  return { ...model, family: "opencode" };
}

export function mergeSelectorModels(
  availableModelIds?: string[],
  selectedModelId?: string,
  filter?: (model: ModelDescriptor) => boolean,
  catalogMode: "all" | "available-only" = "all",
): ModelDescriptor[] {
  const merged = new Map<string, ModelDescriptor>();
  const selectedId = String(selectedModelId ?? "").trim();
  const availableIdSet = new Set(
    (availableModelIds ?? [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  );
  if (catalogMode === "all") {
    for (const model of MODEL_REGISTRY) {
      if (model.deprecated) continue;
      if (filter && !filter(model)) continue;
      merged.set(model.id, rebucketOpenCodeFamily(model));
    }
    // Determine which dynamic providers already have real discovered models
    // (from `availableModelIds`). For those, skip canonical injection — the
    // real catalog wins. For providers with no discovery output, fall back to
    // the canonical list so the picker is never empty pre-signin.
    const discoveredFamilies = new Set<string>();
    for (const rawId of availableIdSet) {
      const descriptor = resolveModelDescriptor(rawId);
      if (descriptor) {
        // Apply the same rebucket — OpenCode-routed models all collapse to the
        // "opencode" rail regardless of upstream provider family.
        discoveredFamilies.add(rebucketOpenCodeFamily(descriptor).family);
      }
    }
    for (const descriptor of dynamicCanonicalDescriptors()) {
      if (filter && !filter(descriptor)) continue;
      if (discoveredFamilies.has(descriptor.family)) continue;
      if (!merged.has(descriptor.id)) {
        merged.set(descriptor.id, rebucketOpenCodeFamily(descriptor));
      }
    }
  }

  for (const rawId of availableIdSet) {
    const descriptor = resolveModelDescriptor(rawId);
    if (descriptor) {
      if (descriptor.deprecated) continue;
      if (filter && !filter(descriptor)) continue;
      merged.set(descriptor.id, rebucketOpenCodeFamily(descriptor));
    } else {
      const placeholder = createUnknownModelPlaceholder(rawId);
      if (filter && !filter(placeholder)) continue;
      merged.set(placeholder.id, rebucketOpenCodeFamily(placeholder));
    }
  }

  if (selectedId && !merged.has(selectedId)) {
    const selectedDescriptor = resolveModelDescriptor(selectedId);
    if (selectedDescriptor && !selectedDescriptor.deprecated && (!filter || filter(selectedDescriptor))) {
      merged.set(selectedDescriptor.id, rebucketOpenCodeFamily(selectedDescriptor));
    } else if (!selectedDescriptor) {
      const placeholder = createUnknownModelPlaceholder(selectedId);
      if (!filter || filter(placeholder)) {
        merged.set(placeholder.id, rebucketOpenCodeFamily(placeholder));
      }
    }
  }
  return [...merged.values()];
}
