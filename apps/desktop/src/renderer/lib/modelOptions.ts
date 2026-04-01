import type { AiModelDescriptor, AiSettingsStatus, ModelId } from "../../shared/types";
import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../shared/modelRegistry";

function normalizeAuthProvider(provider: string | undefined): string {
  return String(provider ?? "").trim().toLowerCase();
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

export function deriveConfiguredModelIds(status: AiSettingsStatus | null | undefined): ModelId[] {
  if (!status) return [];

  // Derive available models from detectedAuth. For Cursor CLI, merge in
  // `status.availableModelIds` entries under `cursor/*` (main lists them after
  // `agent models`); other providers still use registry + auth only.
  const ids = new Set<ModelId>();

  for (const auth of status.detectedAuth ?? []) {
    if (auth.type === "cli-subscription") {
      if (!auth.authenticated) continue;
      if (auth.cli === "cursor") {
        continue;
      }
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

  const cursorCliAuthed = status.detectedAuth?.some(
    (a) => a.type === "cli-subscription" && a.cli === "cursor" && a.authenticated !== false,
  );
  if (cursorCliAuthed && status.availableModelIds?.length) {
    for (const raw of status.availableModelIds) {
      const id = String(raw ?? "").trim();
      if (id.startsWith("cursor/")) ids.add(id as ModelId);
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

export function deriveConfiguredModelOptions(status: AiSettingsStatus | null | undefined): AiModelDescriptor[] {
  return deriveConfiguredModelIds(status).flatMap((modelId) => {
    const descriptor = getModelById(modelId);
    return descriptor ? [descriptorToModelOption(descriptor)] : [];
  });
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
