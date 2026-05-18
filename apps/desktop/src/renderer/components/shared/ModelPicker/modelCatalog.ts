import {
  createDynamicDroidCliModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  getLocalModelIdTail,
  parseDynamicDroidModelRef,
  parseDynamicOpenCodeModelRef,
  parseLocalProviderFromModelId,
  resolveModelDescriptor,
  type ModelDescriptor,
} from "../../../../shared/modelRegistry";
import { PROVIDER_BADGE_COLORS } from "../providerModelSelectorGrouping";

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
 * Models reached via the OpenCode runtime are family-mapped for picker display:
 * - Local-provider models (lmstudio, ollama) keep their native family so they
 *   appear in their own rail entry, not lumped under OpenCode. Routing through
 *   OpenCode is an implementation detail; semantically the user thinks of these
 *   as LM Studio / Ollama models.
 * - Cloud-provider models routed through OpenCode (e.g. anthropic-via-opencode)
 *   get rebucketed to family "opencode" so they group under the OpenCode rail
 *   alongside other OpenCode-routed providers. openCodeProviderId stays intact
 *   for the sub-provider header + row logo.
 */
function rebucketOpenCodeFamily(model: ModelDescriptor): ModelDescriptor {
  if (model.providerRoute !== "opencode") return model;
  if (model.family === "opencode") return model;
  // Local providers retain their own family so they get their own rail.
  if (model.family === "lmstudio" || model.family === "ollama") return model;
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
