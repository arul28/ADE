import {
  MODEL_PROVIDER_GROUPS,
  getDefaultModelDescriptor,
  listModelDescriptorsForProvider,
  modelSupportsFastMode,
  type ModelDescriptor,
} from "../../../desktop/src/shared/modelRegistry";
import { CLOUD_REMOTE_SIGN_IN, type CloudCatalogModel, type CloudCatalogProvider, type CloudModelCatalog } from "./contract";
import { fail, json } from "./http";

/**
 * Models per provider for a client with no computer (`GET /cloud/models`):
 * the web and the phone show a model picker before any ADE Cloud computer
 * exists. The list is ADE's own (the desktop's `MODEL_REGISTRY` and its
 * bundled manifest, the offline list every picker starts from), bundled
 * into this Worker, so it moves with each deploy and never reads a
 * computer. Providers that list their models only once their CLI runs
 * (Pi, and more models for some others) show what ADE knows.
 */

/** A model that runs on the person's own machine (Ollama, LM Studio): never on an ADE Cloud computer. */
const isLocal = (descriptor: ModelDescriptor): boolean =>
  descriptor.family === "ollama" || descriptor.family === "lmstudio" || descriptor.authTypes.includes("local");

function modelOf(descriptor: ModelDescriptor): CloudCatalogModel {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    reasoningTiers: [...(descriptor.reasoningTiers ?? [])],
    defaultReasoningEffort: descriptor.defaultReasoningEffort ?? null,
    fast: modelSupportsFastMode(descriptor),
  };
}

/** A short stable tag of the list, so a client can tell it changed. */
function versionOf(providers: CloudCatalogProvider[]): string {
  const text = JSON.stringify(providers);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

let built: CloudModelCatalog | null = null;

/** Built once per Worker isolate: the list is part of the deploy. */
export function cloudModelCatalog(): CloudModelCatalog {
  if (built) return built;
  const providers: CloudCatalogProvider[] = [];
  for (const provider of MODEL_PROVIDER_GROUPS) {
    const row = CLOUD_REMOTE_SIGN_IN.find((entry) => entry.provider === provider);
    if (!row) continue;
    const descriptors = listModelDescriptorsForProvider(provider).filter((descriptor) => !descriptor.deprecated && !isLocal(descriptor));
    const fallback = getDefaultModelDescriptor(provider);
    const usableFallback = fallback && !isLocal(fallback) ? fallback : null;
    // A provider whose list is its CLI's (Cursor, Droid) still offers the model a chat there starts with.
    if (usableFallback && !descriptors.some((descriptor) => descriptor.id === usableFallback.id)) descriptors.unshift(usableFallback);
    const models = descriptors.map(modelOf);
    providers.push({
      provider,
      label: row.label,
      remoteSignIn: row.remoteSignIn,
      defaultModelId: usableFallback?.id ?? models[0]?.id ?? null,
      models,
    });
  }
  built = { version: versionOf(providers), providers };
  return built;
}

/** `GET /cloud/models`. */
export function handleCloudModels(request: Request): Response {
  if (request.method !== "GET") return fail("not_found", "Daex Cloud has no such route.", 404);
  return json(cloudModelCatalog());
}
