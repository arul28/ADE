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
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import { PROVIDER_BADGE_COLORS } from "../providerModelSelectorGrouping";

const runtimeCatalogDescriptorsById = new Map<string, ModelDescriptor>();

export function resetRuntimeCatalogDescriptorCacheForTests(): void {
  runtimeCatalogDescriptorsById.clear();
}

export function getRuntimeCatalogModelDescriptor(modelId: string | null | undefined): ModelDescriptor | undefined {
  const id = modelId?.trim();
  if (!id) return undefined;
  return runtimeCatalogDescriptorsById.get(id);
}

export function resolveModelDescriptorWithRuntimeCatalog(modelId: string | null | undefined): ModelDescriptor | undefined {
  const id = modelId?.trim();
  if (!id) return undefined;
  return getRuntimeCatalogModelDescriptor(id) ?? resolveModelDescriptor(id);
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
    const descriptor = resolveModelDescriptorWithRuntimeCatalog(rawId);
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
    const selectedDescriptor = resolveModelDescriptorWithRuntimeCatalog(selectedId);
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

export type RuntimeCatalogModelDescriptor = ModelDescriptor & {
  subProvider?: string;
  subProviderKey?: string;
  catalogGroupKey?: string;
  catalogAvailable?: boolean;
  catalogRequiresConfiguration?: boolean;
};

function pickerFamilyForCatalogGroup(groupKey: string, fallbackFamily?: string): ProviderFamily {
  if (groupKey === "claude") return "anthropic";
  if (groupKey === "codex") return "openai";
  if (groupKey === "droid") return "factory";
  if (groupKey === "cursor") return "cursor";
  if (groupKey === "opencode") return "opencode";
  if (groupKey === "ollama") return "ollama";
  if (groupKey === "lmstudio") return "lmstudio";
  if (fallbackFamily === "ollama" || fallbackFamily === "lmstudio" || fallbackFamily === "cursor" || fallbackFamily === "factory") {
    return fallbackFamily;
  }
  if (fallbackFamily === "anthropic" || fallbackFamily === "openai" || fallbackFamily === "opencode") {
    return fallbackFamily;
  }
  return "opencode";
}

export function descriptorsFromAgentChatModelCatalog(
  catalog: AgentChatModelCatalog | null | undefined,
  filter?: (model: ModelDescriptor) => boolean,
): { models: RuntimeCatalogModelDescriptor[]; availableModelIds: string[] } {
  if (!catalog) return { models: [], availableModelIds: [] };
  const merged = new Map<string, RuntimeCatalogModelDescriptor>();
  const available = new Set<string>();
  for (const group of catalog.groups ?? []) {
    for (const provider of group.providers ?? []) {
      for (const subsection of provider.subsections ?? []) {
        for (const model of subsection.models ?? []) {
          const base = resolveModelDescriptor(model.id) ?? createUnknownModelPlaceholder(model.id);
          const family = pickerFamilyForCatalogGroup(String(model.groupKey || group.key), model.family);
          const runtimeReasoningTiers = model.reasoningEfforts
            ?.map((entry) => entry.effort.trim().toLowerCase())
            .filter(Boolean);
          const serviceTiers = model.serviceTiers
            ?.map((entry) => entry.trim().toLowerCase())
            .filter(Boolean);
          const capabilities = {
            ...base.capabilities,
            ...(typeof model.supportsReasoning === "boolean" ? { reasoning: model.supportsReasoning } : {}),
            ...(typeof model.supportsTools === "boolean" ? { tools: model.supportsTools } : {}),
          };
          const descriptor: RuntimeCatalogModelDescriptor = {
            ...rebucketOpenCodeFamily(base),
            id: model.id,
            displayName: model.displayName || base.displayName,
            shortId: base.shortId,
            family,
            color: model.color ?? base.color,
            ...(model.aliases?.length ? { aliases: model.aliases } : base.aliases?.length ? { aliases: base.aliases } : {}),
            capabilities,
            ...(runtimeReasoningTiers?.length ? { reasoningTiers: runtimeReasoningTiers } : {}),
            ...(model.serviceTiers !== undefined
              ? { serviceTiers }
              : base.serviceTiers?.length
                ? { serviceTiers: base.serviceTiers }
                : {}),
            subProvider: model.providerName || provider.displayName || subsection.label || undefined,
            subProviderKey: model.providerId || provider.key || subsection.key || undefined,
            catalogGroupKey: String(model.groupKey || group.key),
            catalogAvailable: model.isAvailable,
            catalogRequiresConfiguration: model.requiresConfiguration,
            ...(model.cursorAvailability
              ? { cursorAvailability: model.cursorAvailability }
              : base.cursorAvailability
                ? { cursorAvailability: base.cursorAvailability }
                : {}),
          };
          if (filter && !filter(descriptor)) continue;
          merged.set(descriptor.id, descriptor);
          runtimeCatalogDescriptorsById.set(descriptor.id, descriptor);
          if (model.isAvailable) available.add(descriptor.id);
        }
      }
    }
  }
  return { models: [...merged.values()], availableModelIds: [...available] };
}
