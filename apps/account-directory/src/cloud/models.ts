import { ADE_FREE_MODELS } from "../../../desktop/src/shared/adeFreeModels";
import { freeModelEntry, getFreeModelDefaultIds, pickFreeDefaultModelId } from "../../../desktop/src/shared/freeModels";
import { modelOnlyRunsInOpenCode } from "../../../desktop/src/shared/harnessRoutes";
import {
  FREE_MODEL_FALLBACK_DEFAULT_ID,
  MODEL_PROVIDER_GROUPS,
  encodeOpenCodeRegistryId,
  getDefaultModelDescriptor,
  getModelById,
  listModelDescriptorsForProvider,
  modelSupportsFastMode,
  type ModelDescriptor,
} from "../../../desktop/src/shared/modelRegistry";
import { readNewestSnapshot } from "../modelRegistry";
import { CLOUD_REMOTE_SIGN_IN, type CloudCatalogModel, type CloudCatalogProvider, type CloudModelCatalog } from "./contract";
import { fail, json } from "./http";
import { reportCloudFailure, type CloudDb } from "./store";

/**
 * Models per provider for a client with no computer (`GET /cloud/models`):
 * the web and the phone show a model picker before any ADE Cloud computer
 * exists. The list is ADE's own (the desktop's `MODEL_REGISTRY` and its
 * bundled manifest, the offline list every picker starts from), bundled
 * into this Worker, so it moves with each deploy and never reads a
 * computer. Providers that list their models only once their CLI runs
 * (Pi, and more models for some others) show what ADE knows.
 *
 * OpenCode's group also lists the free models (`free` names their Free page
 * group and tag): the ADE Free Models, and OpenCode Zen's free tier as the
 * newest models.dev snapshot has it (Zen's free models come and go, so the
 * bundled list can't hold them). The list is the same for every account; a
 * client shows ADE Free Models only when the account state has `freeModels`.
 * Free rows need no sign-in: Zen's need no key, and ADE Free Models run on
 * the account's own sign-in.
 */

/** A model that runs on the person's own machine (Ollama, LM Studio): never on an ADE Cloud computer. */
const isLocal = (descriptor: ModelDescriptor): boolean =>
  descriptor.family === "ollama" || descriptor.family === "lmstudio" || descriptor.authTypes.includes("local");

function modelOf(descriptor: ModelDescriptor): CloudCatalogModel {
  const free = freeModelEntry({ id: descriptor.id });
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    reasoningTiers: [...(descriptor.reasoningTiers ?? [])],
    defaultReasoningEffort: descriptor.defaultReasoningEffort ?? null,
    fast: modelSupportsFastMode(descriptor),
    ...(free ? { free: { source: free.source, badge: free.badge } } : {}),
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

/**
 * The free models OpenCode's group adds: the ADE Free Models first, then
 * Zen's free ones from the snapshot's OpenCode Zen prices, and ADE's own
 * fallback free model when the snapshot has none of them.
 */
function freeDescriptors(zenModelIds: readonly string[]): ModelDescriptor[] {
  const ids = [
    ...ADE_FREE_MODELS.map((model) => model.id),
    ...zenModelIds.filter((id) => modelOnlyRunsInOpenCode("opencode", id)).map((id) => encodeOpenCodeRegistryId("opencode", id)),
    FREE_MODEL_FALLBACK_DEFAULT_ID,
  ];
  return [...new Set(ids)].flatMap((id) => {
    const descriptor = getModelById(id);
    return descriptor && !descriptor.deprecated ? [descriptor] : [];
  });
}

function buildCatalog(zenModelIds: readonly string[]): CloudModelCatalog {
  const providers: CloudCatalogProvider[] = [];
  for (const provider of MODEL_PROVIDER_GROUPS) {
    const row = CLOUD_REMOTE_SIGN_IN.find((entry) => entry.provider === provider);
    if (!row) continue;
    const descriptors = listModelDescriptorsForProvider(provider).filter((descriptor) => !descriptor.deprecated && !isLocal(descriptor));
    const fallback = getDefaultModelDescriptor(provider);
    const usableFallback = fallback && !isLocal(fallback) ? fallback : null;
    // A provider whose list is its CLI's (Cursor, Droid) still offers the model a chat there starts with.
    if (usableFallback && !descriptors.some((descriptor) => descriptor.id === usableFallback.id)) descriptors.unshift(usableFallback);
    if (provider === "opencode") {
      for (const descriptor of freeDescriptors(zenModelIds)) {
        if (!descriptors.some((entry) => entry.id === descriptor.id)) descriptors.push(descriptor);
      }
    }
    const models = descriptors.map(modelOf);
    providers.push({
      provider,
      label: row.label,
      remoteSignIn: row.remoteSignIn,
      // Never an ad-supported model: a person picks those themselves (`pickFreeDefaultModelId`).
      defaultModelId: usableFallback?.id
        ?? pickFreeDefaultModelId(models.filter((model) => model.free).map((model) => model.id), getFreeModelDefaultIds())
        ?? models.find((model) => !model.free)?.id
        ?? null,
      models,
    });
  }
  return { version: versionOf(providers), providers };
}

/** Rebuilt at most this often per Worker isolate: the bundled list moves with a deploy, Zen's free list with the daily snapshot. */
const CATALOG_TTL_MS = 10 * 60_000;
/** After a snapshot that can't be read, the next try. */
const CATALOG_RETRY_MS = 60_000;
let built: { catalog: CloudModelCatalog; until: number } | null = null;

/** OpenCode Zen's model ids in the newest models.dev snapshot, or null when it can't be read. */
async function zenModelIds(env: CloudDb): Promise<string[] | null> {
  try {
    const snapshot = await readNewestSnapshot(env.DB);
    return snapshot ? Object.keys(snapshot.prices.opencode ?? {}) : [];
  } catch (error) {
    reportCloudFailure("cloud.models.snapshot_unreadable", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

export async function cloudModelCatalog(env: CloudDb, now = Date.now()): Promise<CloudModelCatalog> {
  if (built && now < built.until) return built.catalog;
  const zen = await zenModelIds(env);
  built = { catalog: buildCatalog(zen ?? []), until: now + (zen ? CATALOG_TTL_MS : CATALOG_RETRY_MS) };
  return built.catalog;
}

/** `GET /cloud/models`. */
export async function handleCloudModels(request: Request, env: CloudDb): Promise<Response> {
  if (request.method !== "GET") return fail("not_found", "DAEX Cloud has no such route.", 404);
  return json(await cloudModelCatalog(env));
}
