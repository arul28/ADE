import type { AiModelDescriptor, AiSettingsStatus, ModelId } from "../../shared/types";
import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../shared/modelRegistry";

function normalizeAuthProvider(provider: string | undefined): string {
  return String(provider ?? "").trim().toLowerCase();
}

function descriptorToModelOption(descriptor: ModelDescriptor): AiModelDescriptor {
  return {
    id: descriptor.id,
    label: descriptor.displayName,
    description: descriptor.isCliWrapped ? `${descriptor.family} (CLI)` : `${descriptor.family} (API/local)`,
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

export function deriveConfiguredModelIds(status: AiSettingsStatus | null | undefined): ModelId[] {
  if (!status) return [];

  // Derive available models entirely from detectedAuth — do NOT trust
  // status.availableModelIds or status.models.* from the backend, as those
  // may be populated before auth is fully confirmed.
  const ids = new Set<ModelId>();

  for (const auth of status.detectedAuth ?? []) {
    if (auth.type === "cli-subscription") {
      if (!auth.authenticated) continue;
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
      if (provider.length) addKnownModelIds(ids, provider, false);
    }
  }

  return MODEL_REGISTRY
    .filter((model) => !model.deprecated && ids.has(model.id))
    .map((model) => model.id);
}

export function deriveConfiguredModelOptions(status: AiSettingsStatus | null | undefined): AiModelDescriptor[] {
  return deriveConfiguredModelIds(status)
    .map((modelId): AiModelDescriptor | null => {
      const descriptor = getModelById(modelId);
      if (!descriptor) return null;
      return descriptorToModelOption(descriptor);
    })
    .filter((entry): entry is AiModelDescriptor => entry != null);
}

export function includeSelectedModelOption(
  options: AiModelDescriptor[],
  selectedModelId: string | null | undefined,
): AiModelDescriptor[] {
  const modelId = String(selectedModelId ?? "").trim();
  if (!modelId.length || options.some((option) => option.id === modelId)) return options;
  const descriptor = getModelById(modelId);
  if (!descriptor) return options;
  return [descriptorToModelOption(descriptor), ...options];
}
