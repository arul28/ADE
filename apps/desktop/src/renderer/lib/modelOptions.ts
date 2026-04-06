import type { AiModelDescriptor, AiRuntimeConnectionStatus, AiSettingsStatus, ModelId } from "../../shared/types";
import {
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  getLocalModelIdTail,
  getModelById,
  isLocalProviderFamily,
  parseLocalProviderFromModelId,
  type ModelDescriptor,
} from "../../shared/modelRegistry";

function normalizeAuthProvider(provider: string | undefined): string {
  return String(provider ?? "").trim().toLowerCase();
}

function getLocalModelLabel(modelId: string): string {
  const provider = parseLocalProviderFromModelId(modelId);
  if (!provider) return modelId;
  const tail = getLocalModelIdTail(modelId, provider);
  return tail.length ? tail : modelId;
}

function buildFallbackModelOption(modelId: string): AiModelDescriptor {
  const provider = parseLocalProviderFromModelId(modelId);
  if (provider) {
    const pLabel = LOCAL_PROVIDER_LABELS[provider];
    return {
      id: modelId,
      label: getLocalModelLabel(modelId),
      description: `${pLabel} local model`,
    };
  }
  return {
    id: modelId,
    label: modelId,
    description: "Unknown model",
  };
}

export function describeModelSource(descriptor: ModelDescriptor): string {
  if (descriptor.authTypes.includes("local")) {
    return "local";
  }
  if (descriptor.isCliWrapped) {
    return "CLI subscription";
  }
  if (descriptor.authTypes.includes("api-key")) {
    return "API only";
  }
  if (descriptor.authTypes.includes("oauth")) {
    return "OAuth";
  }
  if (descriptor.authTypes.includes("openrouter")) {
    return "OpenRouter";
  }
  return "model source";
}

function descriptorToModelOption(descriptor: ModelDescriptor): AiModelDescriptor {
  return {
    id: descriptor.id,
    label: descriptor.displayName,
    description: `${descriptor.family} (${describeModelSource(descriptor)})`,
  };
}

function addKnownModelIds(ids: Set<ModelId>, family: string, includeCliWrapped: boolean) {
  for (const model of MODEL_REGISTRY) {
    if (model.deprecated) continue;
    if (model.family !== family) continue;
    if (includeCliWrapped !== model.isCliWrapped) continue;
    ids.add(model.id);
  }
}

function addAvailableModelIdsByPrefix(
  ids: Set<ModelId>,
  availableModelIds: readonly ModelId[] | undefined,
  prefix: string,
) {
  if (!availableModelIds?.length) return;
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix.length) return;
  for (const rawId of availableModelIds) {
    const id = String(rawId ?? "").trim();
    if (id.startsWith(normalizedPrefix)) {
      ids.add(id as ModelId);
    }
  }
}

function hasDynamicLocalModelIdsForProvider(
  provider: string,
  availableModelIds: readonly ModelId[] | undefined,
  runtimeConnections: Record<string, AiRuntimeConnectionStatus> | undefined,
): boolean {
  const normalizedProvider = normalizeAuthProvider(provider);
  if (!isLocalProviderFamily(normalizedProvider)) {
    return false;
  }
  const prefix = `${normalizedProvider}/`;
  const loadedModelIds = runtimeConnections?.[normalizedProvider]?.loadedModelIds;
  return Boolean(
    availableModelIds?.some((rawId) => String(rawId ?? "").trim().startsWith(prefix))
      || loadedModelIds?.some((rawId) => String(rawId ?? "").trim().startsWith(prefix)),
  );
}

export interface DeriveModelOptions {
  /** Include cursor/* models in the result. Defaults to `false`. */
  includeCursor?: boolean;
}

export function deriveConfiguredModelIds(
  status: AiSettingsStatus | null | undefined,
  options?: DeriveModelOptions,
): ModelId[] {
  if (!status) return [];

  const { includeCursor = false } = options ?? {};
  const runtimeConnections = (status as { runtimeConnections?: Record<string, AiRuntimeConnectionStatus> } | null | undefined)?.runtimeConnections;

  // Derive available models from detectedAuth. For Cursor CLI, merge in
  // `status.availableModelIds` entries under `cursor/*` (main lists them after
  // `agent models`); local runtimes also merge in discovered loaded models.
  const ids = new Set<ModelId>();

  for (const auth of status.detectedAuth ?? []) {
    if (auth.type === "cli-subscription") {
      if (!auth.authenticated || auth.cli === "cursor") continue;
      const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai" };
      const family = auth.cli ? familyMap[auth.cli] : undefined;
      if (family) addKnownModelIds(ids, family, true);
      continue;
    }

    if (auth.type === "api-key") {
      const provider = normalizeAuthProvider(auth.provider);
      if (provider.length) addKnownModelIds(ids, provider, false);
      continue;
    }

    if (auth.type === "openrouter") {
      addKnownModelIds(ids, "openrouter", false);
      continue;
    }

    if (auth.type === "local") {
      const provider = normalizeAuthProvider(auth.provider);
      if (provider.length) {
        if (!hasDynamicLocalModelIdsForProvider(provider, status.availableModelIds, runtimeConnections)) {
          addKnownModelIds(ids, provider, false);
        }
        addAvailableModelIdsByPrefix(ids, status.availableModelIds, `${provider}/`);
        addAvailableModelIdsByPrefix(ids, runtimeConnections?.[provider]?.loadedModelIds, `${provider}/`);
      }
    }
  }

  for (const [provider, connection] of Object.entries(runtimeConnections ?? {})) {
    const normalizedProvider = normalizeAuthProvider(provider);
    if (!isLocalProviderFamily(normalizedProvider)) {
      continue;
    }
    if (connection == null || connection.runtimeAvailable !== true) {
      continue;
    }
    if (!hasDynamicLocalModelIdsForProvider(normalizedProvider, status.availableModelIds, runtimeConnections)) {
      addKnownModelIds(ids, normalizedProvider, false);
    }
    addAvailableModelIdsByPrefix(ids, connection.loadedModelIds, `${normalizedProvider}/`);
    addAvailableModelIdsByPrefix(ids, status.availableModelIds, `${normalizedProvider}/`);
  }

  if (includeCursor) {
    const cursorCliAuthed = status.detectedAuth?.some(
      (a) => a.type === "cli-subscription" && a.cli === "cursor" && a.authenticated !== false,
    );
    if (cursorCliAuthed && status.availableModelIds?.length) {
      for (const raw of status.availableModelIds) {
        const id = String(raw ?? "").trim();
        if (id.startsWith("cursor/")) ids.add(id as ModelId);
      }
    }
  }

  const registryOrdered = MODEL_REGISTRY
    .filter((model) => !model.deprecated && ids.has(model.id))
    .map((model) => model.id);
  const extra = [...ids].filter((id) => !registryOrdered.includes(id));
  extra.sort((a, b) => {
    const da = getModelById(a)?.displayName ?? a;
    const db = getModelById(b)?.displayName ?? b;
    return da.localeCompare(db, undefined, { sensitivity: "base" });
  });
  return [...registryOrdered, ...extra];
}

export function deriveConfiguredModelOptions(
  status: AiSettingsStatus | null | undefined,
  options?: DeriveModelOptions,
): AiModelDescriptor[] {
  return deriveConfiguredModelIds(status, options).flatMap((modelId) => {
    const descriptor = getModelById(modelId);
    return descriptor
      ? [descriptorToModelOption(descriptor)]
      : parseLocalProviderFromModelId(modelId)
        ? [buildFallbackModelOption(modelId)]
        : [];
  });
}

export function includeSelectedModelOption(
  options: AiModelDescriptor[],
  selectedModelId: string | null | undefined,
): AiModelDescriptor[] {
  const modelId = String(selectedModelId ?? "").trim();
  if (!modelId.length || options.some((option) => option.id === modelId)) return options;
  const descriptor = getModelById(modelId);
  if (descriptor) return [descriptorToModelOption(descriptor), ...options];
  if (parseLocalProviderFromModelId(modelId)) return [buildFallbackModelOption(modelId), ...options];
  return options;
}
