import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import type { Logger } from "../logging/logger";
import type { EffectiveProjectConfig, OpenCodeProviderSummary, ProjectConfigFile } from "../../../shared/types";
import type { OpenCodeProviderAuthMethods } from "../../../shared/types/config";
import {
  createDynamicOpenCodeModelDescriptor,
  isLocalProviderFamily,
  modelSupportsFastMode,
  normalizeAnthropicRuntimeAlias,
  replaceDynamicOpenCodeModelDescriptors,
  type ModelCapabilities,
  type ModelDescriptor,
  type OpenCodeFastRoute,
  type OpenCodeFastRoutes,
} from "../../../shared/modelRegistry";
import { openCodeProviderDisplayName } from "../../../shared/opencodeProviders";
import { stableStringify } from "../shared/utils";
import { openCodeAuthMethodsFromIntegrations, type OpenCodeIntegrationInfo } from "./openCodeAuthMethods";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import { buildOpenCodeConfig, type DiscoveredLocalModelEntry } from "./openCodeConfig";
import { acquireOpenCodeServer } from "./openCodeServer";

/**
 * OpenCode's model and provider inventory, for the model picker and settings.
 *
 * The persisted cache is the source for the picker: drawing it never starts a
 * server. A probe runs only when no usable cache exists, when the config or a
 * key changed (`clearOpenCodeInventoryCache` marks the cache stale), or when
 * the user asks for a refresh — and it runs on the shared server, which it
 * leases and releases. 1.x started a fresh server for every probe on a 60 s TTL,
 * which kept a whole OpenCode process busy for nothing.
 */

/** A probe result stays good this long without a config or key change. */
const TTL_MS = 6 * 60 * 60_000;
const CATALOG_RETRY_DELAY_MS = 750;
/** A failed probe is not retried sooner, so a broken binary is not relaunched per picker open. */
const ERROR_TTL_MS = 60_000;
const PERSISTED_INVENTORY_VERSION = 2;

/** Metadata for an OpenCode provider (integration) in settings. */
export type OpenCodeProviderInfo = OpenCodeProviderSummary;

export type OpenCodeInventoryResult = {
  /** Selectable model ids for connected providers only. */
  modelIds: string[];
  providers: OpenCodeProviderInfo[];
  error: string | null;
  descriptors: ModelDescriptor[];
};

type CacheEntry = {
  cachedAt: number;
  projectRoot: string;
  configFingerprint: string;
  passiveConfigFingerprint: string;
  /** A config or key changed since this was probed: usable to draw, not to trust. */
  stale: boolean;
  modelIds: string[];
  providers: OpenCodeProviderInfo[];
  /** Everything handed to the model registry, folded fast siblings included. */
  registryDescriptors: ModelDescriptor[];
  authMethods: OpenCodeProviderAuthMethods;
  error: string | null;
};

let inventoryCache: CacheEntry | null = null;
const probeInFlightMap = new Map<string, Promise<OpenCodeInventoryResult>>();
/**
 * The local models the last probe saw. Other shared-server users (auth) build
 * their config from this, because the server's config is one file and a lease
 * without the local providers would hot-reload them away from running chats.
 */
let lastDiscoveredLocalModels: DiscoveredLocalModelEntry[] | undefined;

export function lastOpenCodeDiscoveredLocalModels(): DiscoveredLocalModelEntry[] | undefined {
  return lastDiscoveredLocalModels;
}

// ── Credential source (non-secret) ─────────────────────────────────────────

function hasConfiguredOpenCodeApiKey(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  providerId: string,
): boolean {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const configured = projectConfig.ai?.apiKeys ?? {};
  if (Object.entries(configured).some(([id, key]) => (
    id.trim().toLowerCase() === normalizedProviderId
    && typeof key === "string"
    && key.trim().length > 0
  ))) {
    return true;
  }

  // User-supplied config content still reaches the server. It is safe to
  // inspect the shape here, but never carry the value across the status boundary.
  const inheritedContent = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (!inheritedContent) return false;
  try {
    const parsed = JSON.parse(inheritedContent) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const providers = (parsed as Record<string, unknown>).providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return false;
    const entry = (providers as Record<string, unknown>)[providerId]
      ?? (providers as Record<string, unknown>)[normalizedProviderId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const settings = (entry as Record<string, unknown>).settings;
    return Boolean(
      settings
      && typeof settings === "object"
      && !Array.isArray(settings)
      && typeof (settings as Record<string, unknown>).apiKey === "string"
      && ((settings as Record<string, unknown>).apiKey as string).trim().length > 0,
    );
  } catch {
    return false;
  }
}

function resolveOpenCodeCredentialSource(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  providerId: string,
  envVars: string[] | undefined,
): OpenCodeProviderInfo["credentialSource"] {
  if (hasConfiguredOpenCodeApiKey(projectConfig, providerId)) return "config";
  if (envVars?.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === "string" && value.trim().length > 0;
  })) {
    return "env";
  }
  return undefined;
}

function stripEphemeralCredentialSource(provider: OpenCodeProviderInfo): OpenCodeProviderInfo {
  const { credentialSource: _credentialSource, ...stable } = provider;
  return stable;
}

// ── Cross-launch persistence ───────────────────────────────────────────────
//
// Keyed by project root, in Electron userData. It carries the registry
// descriptors as well as the provider list, so a cold start draws the picker
// from disk instead of starting a server.

type PersistedInventoryEntry = {
  savedAt: number;
  configFingerprint: string;
  passiveConfigFingerprint: string;
  stale: boolean;
  modelIds: string[];
  providers: OpenCodeProviderInfo[];
  registryDescriptors: ModelDescriptor[];
  authMethods: OpenCodeProviderAuthMethods;
};

type PersistedInventoryFile = {
  version: number;
  entries: Record<string, PersistedInventoryEntry>;
};

type ElectronLikeApp = { app?: { getPath(name: string): string } };

let persistPathOverride: string | null = null;
let persistedInventoryMemo: PersistedInventoryFile | null = null;

function resolvePersistedInventoryPath(): string {
  if (persistPathOverride) return persistPathOverride;
  const envOverride = process.env.ADE_OPENCODE_INVENTORY_CACHE_FILE?.trim();
  if (envOverride) return path.resolve(envOverride);
  try {
    const electron = require("electron") as ElectronLikeApp;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      return path.resolve(userDataPath, "opencode-inventory-cache.json");
    }
  } catch {
    // Not running inside Electron (e.g. unit tests) — fall through.
  }
  const homeDir = os.homedir().trim();
  const baseDir = homeDir.length > 0 ? path.resolve(homeDir, ".ade") : os.tmpdir();
  return path.resolve(baseDir, "opencode-inventory-cache.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isProviderInfo(value: unknown): value is OpenCodeProviderInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  return typeof info.id === "string"
    && typeof info.name === "string"
    && typeof info.connected === "boolean"
    && typeof info.modelCount === "number"
    && Number.isFinite(info.modelCount)
    && (info.availableModelCount === undefined
      || (typeof info.availableModelCount === "number" && Number.isFinite(info.availableModelCount)))
    && (info.envVars === undefined || isStringArray(info.envVars));
}

function isDescriptor(value: unknown): value is ModelDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.displayName === "string" && record.providerRoute === "opencode";
}

function readPersistedInventoryFile(): PersistedInventoryFile {
  if (persistedInventoryMemo) return persistedInventoryMemo;
  const empty: PersistedInventoryFile = { version: PERSISTED_INVENTORY_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePersistedInventoryPath(), "utf8")) as unknown;
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    // A file from another layout (the 1.x provider-only list) is dropped whole.
    if (!record || record.version !== PERSISTED_INVENTORY_VERSION || !record.entries || typeof record.entries !== "object") {
      persistedInventoryMemo = empty;
      return empty;
    }
    const entries: Record<string, PersistedInventoryEntry> = {};
    for (const [projectRoot, raw] of Object.entries(record.entries as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt)) continue;
      if (typeof entry.configFingerprint !== "string" || typeof entry.passiveConfigFingerprint !== "string") continue;
      if (!isStringArray(entry.modelIds)) continue;
      if (!Array.isArray(entry.providers) || !entry.providers.every(isProviderInfo)) continue;
      if (!Array.isArray(entry.registryDescriptors) || !entry.registryDescriptors.every(isDescriptor)) continue;
      const authMethods = entry.authMethods && typeof entry.authMethods === "object" && !Array.isArray(entry.authMethods)
        ? entry.authMethods as OpenCodeProviderAuthMethods
        : {};
      entries[projectRoot] = {
        savedAt: entry.savedAt,
        configFingerprint: entry.configFingerprint,
        passiveConfigFingerprint: entry.passiveConfigFingerprint,
        stale: entry.stale === true,
        modelIds: entry.modelIds,
        // A cache written before a house service was renamed still shows ADE's name.
        providers: (entry.providers as OpenCodeProviderInfo[]).map((provider) => ({
          ...stripEphemeralCredentialSource(provider),
          name: openCodeProviderDisplayName(provider.id, provider.name),
        })),
        registryDescriptors: entry.registryDescriptors as ModelDescriptor[],
        authMethods,
      };
    }
    persistedInventoryMemo = { version: PERSISTED_INVENTORY_VERSION, entries };
  } catch {
    persistedInventoryMemo = empty;
  }
  return persistedInventoryMemo;
}

function writePersistedInventoryFile(file: PersistedInventoryFile): void {
  persistedInventoryMemo = file;
  try {
    const filePath = resolvePersistedInventoryPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Non-critical — persistence failures must not break the probe.
  }
}

function persistEntry(entry: CacheEntry): void {
  const file = readPersistedInventoryFile();
  writePersistedInventoryFile({
    version: PERSISTED_INVENTORY_VERSION,
    entries: {
      ...file.entries,
      [entry.projectRoot]: {
        savedAt: entry.cachedAt,
        configFingerprint: entry.configFingerprint,
        passiveConfigFingerprint: entry.passiveConfigFingerprint,
        stale: false,
        modelIds: entry.modelIds,
        providers: entry.providers.map(stripEphemeralCredentialSource),
        registryDescriptors: entry.registryDescriptors,
        authMethods: entry.authMethods,
      },
    },
  });
}

/** Load the last persisted provider list for a project (empty when none). */
export function loadPersistedOpenCodeInventory(projectRoot: string): OpenCodeProviderInfo[] {
  return readPersistedInventoryFile().entries[projectRoot]?.providers ?? [];
}

/** Test hook: point persistence at a temp file and drop the in-memory memo. */
export function __setOpenCodeInventoryPersistencePathForTests(filePath: string | null): void {
  persistPathOverride = filePath;
  persistedInventoryMemo = null;
}

/** Adopt a persisted entry as the in-memory cache and load its models into the registry. */
function hydrateFromPersisted(projectRoot: string, entry: PersistedInventoryEntry): CacheEntry {
  replaceDynamicOpenCodeModelDescriptors(entry.registryDescriptors);
  inventoryCache = {
    cachedAt: entry.savedAt,
    projectRoot,
    configFingerprint: entry.configFingerprint,
    passiveConfigFingerprint: entry.passiveConfigFingerprint,
    stale: entry.stale,
    modelIds: entry.modelIds,
    providers: entry.providers,
    registryDescriptors: entry.registryDescriptors,
    authMethods: entry.authMethods,
    error: null,
  };
  return inventoryCache;
}

/**
 * Drop the in-memory inventory and mark every persisted one stale: a config or
 * key changed, so the next probe must ask the server. The persisted models
 * still draw the picker until then.
 */
export function clearOpenCodeInventoryCache(): void {
  inventoryCache = null;
  const file = readPersistedInventoryFile();
  if (!Object.values(file.entries).some((entry) => !entry.stale)) return;
  writePersistedInventoryFile({
    version: PERSISTED_INVENTORY_VERSION,
    entries: Object.fromEntries(
      Object.entries(file.entries).map(([projectRoot, entry]) => [projectRoot, { ...entry, stale: true }]),
    ),
  });
}

/** The provider ids with a key in ADE's store; values stay in the store. */
function storedApiKeyProviderIds(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require("../ai/apiKeyStore") as { listStoredProviders: () => string[] };
    return store.listStoredProviders().map((id) => id.trim().toLowerCase()).sort();
  } catch {
    // Key store may not be available (e.g. unit tests).
    return [];
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintOpenCodeConfig(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  discoveredLocalModels?: DiscoveredLocalModelEntry[],
): string {
  const ai = projectConfig.ai ?? {};
  // Hashed: the config holds API keys, and the fingerprint is written to disk.
  return sha256Hex(stableStringify({
    apiKeys: ai.apiKeys ?? {},
    storedKeys: storedApiKeyProviderIds(),
    localProviders: ai.localProviders ?? {},
    customProviders: ai.customProviders ?? [],
    customModelSlugs: ai.customModelSlugs ?? [],
    discoveredModels: discoveredLocalModels?.map((m) => `${m.provider}/${m.modelId}`).sort() ?? [],
  }));
}

// ── Variants and fast routes ───────────────────────────────────────────────

const OPENCODE_REASONING_VARIANT_ALIASES: Record<string, string> = {
  none: "none",
  dynamic: "dynamic",
  off: "off",
  minimal: "minimal",
  mini: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
  ultracode: "ultracode",
  ultra_code: "ultracode",
  "ultra-code": "ultracode",
};

const OPENCODE_SERVICE_VARIANT_ALIASES: Record<string, string> = {
  fast: "fast",
};

function addUnique(out: string[], value: string): void {
  if (!out.some((entry) => entry.trim().toLowerCase() === value)) out.push(value);
}

function normalizeVariantKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

/** The effort in a key that combines it with Fast (`high-fast`, `fast_high`), else null. */
function combinedFastVariantEffort(key: string): string | null {
  const match = /^fast[-_](.+)$/.exec(key) ?? /^(.+)[-_]fast$/.exec(key);
  const effort = match?.[1];
  if (!effort) return null;
  return OPENCODE_REASONING_VARIANT_ALIASES[effort] ?? OPENCODE_REASONING_VARIANT_ALIASES[effort.replace(/_/g, "-")] ?? effort;
}

/** Sorts a 2.0 model's variant ids into ADE reasoning and service tiers. */
export function classifyOpenCodeVariants(model: { variants?: ReadonlyArray<{ id: string }> }): {
  reasoningTiers: string[];
  serviceTiers: string[];
  /** ADE tier to OpenCode's own variant key, only where the two differ. */
  variantKeys: Record<string, string>;
  /** ADE effort to OpenCode's key that runs it with Fast (`high` -> `high-fast`). */
  fastVariantKeys: Record<string, string>;
} {
  const reasoningTiers: string[] = [];
  const serviceTiers: string[] = [];
  const variantKeys: Record<string, string> = {};
  const fastVariantKeys: Record<string, string> = {};
  // The first key that normalizes to a tier names it, the same key the tier
  // list keeps.
  const rememberKey = (tier: string, rawKey: string): void => {
    if (rawKey !== tier && !(tier in variantKeys)) variantKeys[tier] = rawKey;
  };
  for (const variant of model.variants ?? []) {
    const rawKey = typeof variant?.id === "string" ? variant.id : "";
    const key = normalizeVariantKey(rawKey);
    // `default` is the model without a variant, not a tier of its own.
    if (!key || key === "default") continue;
    const serviceTier = OPENCODE_SERVICE_VARIANT_ALIASES[key];
    if (serviceTier) {
      if (!serviceTiers.includes(serviceTier)) rememberKey(serviceTier, rawKey);
      addUnique(serviceTiers, serviceTier);
      continue;
    }
    // A combined key is Fast plus an effort, not an effort of its own.
    const fastEffort = combinedFastVariantEffort(key);
    if (fastEffort) {
      if (!(fastEffort in fastVariantKeys)) fastVariantKeys[fastEffort] = rawKey;
      continue;
    }
    const tier = OPENCODE_REASONING_VARIANT_ALIASES[key] ?? key;
    if (!reasoningTiers.includes(tier)) rememberKey(tier, rawKey);
    addUnique(reasoningTiers, tier);
  }
  return { reasoningTiers, serviceTiers, variantKeys, fastVariantKeys };
}

/** Fast routes a model's own variants give: a plain `fast` key, combined keys, or both. */
function openCodeFastRoutesFromVariants(
  variants: ReturnType<typeof classifyOpenCodeVariants>,
): OpenCodeFastRoutes | undefined {
  const byEffort = Object.fromEntries(
    Object.entries(variants.fastVariantKeys).map(([effort, variant]) => [effort, { variant }]),
  );
  const hasByEffort = Object.keys(byEffort).length > 0;
  const withoutEffort = variants.serviceTiers.includes("fast")
    ? { variant: variants.variantKeys.fast ?? "fast" }
    : undefined;
  if (!withoutEffort && !hasByEffort) return undefined;
  return { ...(withoutEffort ? { withoutEffort } : {}), ...(hasByEffort ? { byEffort } : {}) };
}

const FAST_SIBLING_SUFFIX = "-fast";

/**
 * The base model id when `model` is the fast sibling OpenCode builds from a
 * models.dev fast mode: id `<base>-fast`, sent to the provider API as
 * `<base>` (`modelID`). The API id tells a sibling apart from a distinct model
 * that only shares the suffix, such as xAI's `grok-4-fast`.
 */
function openCodeFastSiblingBaseId(
  model: OpenCodeModelInfo,
  listedModelIds: ReadonlySet<string>,
): string | null {
  if (!model.id.endsWith(FAST_SIBLING_SUFFIX)) return null;
  const baseModelId = model.id.slice(0, -FAST_SIBLING_SUFFIX.length);
  if (!baseModelId || !listedModelIds.has(baseModelId)) return null;
  return model.modelID === baseModelId ? baseModelId : null;
}

/**
 * Makes the base row offer Fast through its sibling. The sibling carries the
 * same effort variants as the base, so each effort both list runs as the
 * sibling model with that effort's variant. The sibling wins over the base's
 * own `fast` or combined keys, because it keeps the effort.
 */
function foldOpenCodeFastSibling(base: ModelDescriptor, sibling: ModelDescriptor): void {
  const siblingModelId = sibling.openCodeModelId;
  if (!siblingModelId) return;
  const byEffort: Record<string, OpenCodeFastRoute> = { ...base.openCodeFast?.byEffort };
  for (const effort of base.reasoningTiers ?? []) {
    if (!sibling.reasoningTiers?.includes(effort)) continue;
    byEffort[effort] = { modelId: siblingModelId, variant: sibling.openCodeVariantKeys?.[effort] ?? effort };
  }
  base.openCodeFast = {
    withoutEffort: { modelId: siblingModelId },
    ...(Object.keys(byEffort).length ? { byEffort } : {}),
  };
  if (!modelSupportsFastMode(base)) base.serviceTiers = [...(base.serviceTiers ?? []), "fast"];
}

type OpenCodeModelInfo = Awaited<ReturnType<OpenCodeClient["model"]["list"]>>["data"][number];
type OpenCodeProviderListInfo = Awaited<ReturnType<OpenCodeClient["provider"]["list"]>>["data"][number];

function readOpenCodeModelCapabilities(model: OpenCodeModelInfo): {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
} {
  return {
    tools: model.capabilities?.tools !== false,
    vision: Boolean(model.capabilities?.input?.includes("image")),
    // 2.0 has no reasoning flag; a model with effort variants reasons.
    reasoning: (model.variants ?? []).some((variant) => variant.id !== "default"),
    streaming: true,
  };
}

function normalizeOpenCodeProviderModel(
  providerId: string,
  modelId: string,
  displayName?: string,
): {
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  preferredDuplicateSource: boolean;
} {
  if (providerId.trim().toLowerCase() !== "anthropic") {
    return { modelId, ...(displayName ? { displayName } : {}), preferredDuplicateSource: true };
  }
  const canonical = normalizeAnthropicRuntimeAlias(modelId);
  if (!canonical) {
    return { modelId, ...(displayName ? { displayName } : {}), preferredDuplicateSource: false };
  }
  return {
    modelId: canonical.modelId,
    displayName: canonical.wasAlias ? canonical.displayName : (displayName ?? canonical.displayName),
    contextWindow: canonical.contextWindow,
    maxOutputTokens: canonical.maxOutputTokens,
    // Tiers are not copied: an alias row offers only the variants OpenCode
    // reported for the alias itself.
    ...(canonical.wasAlias ? { capabilities: canonical.capabilities } : {}),
    preferredDuplicateSource: !canonical.wasAlias,
  };
}

function openCodeErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record._tag === "string") return record._tag;
  }
  return error instanceof Error ? error.message : String(error);
}

// ── Probe ──────────────────────────────────────────────────────────────────

function buildInventory(args: {
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
  models: readonly OpenCodeModelInfo[];
  providers: readonly OpenCodeProviderListInfo[];
  integrations: readonly OpenCodeIntegrationInfo[];
}): { modelIds: string[]; providers: OpenCodeProviderInfo[]; descriptors: ModelDescriptor[]; registryDescriptors: ModelDescriptor[] } {
  // 2.0 lists only providers it can use; `disabled` ones stay listed.
  const connected = new Set<string>();
  for (const provider of args.providers) {
    if (provider.activation === "disabled") continue;
    connected.add(provider.id);
    if (provider.integrationID) connected.add(provider.integrationID);
  }

  // Local runtime catalogs are volatile: only models ADE just discovered as
  // loaded are shown for a local provider.
  const loadedLocalModelIds = new Map<string, Set<string>>();
  const discoveredLocalProviderIds = new Set<string>();
  for (const entry of args.discoveredLocalModels ?? []) {
    discoveredLocalProviderIds.add(entry.provider);
    if (entry.loaded === false) continue;
    let set = loadedLocalModelIds.get(entry.provider);
    if (!set) {
      set = new Set();
      loadedLocalModelIds.set(entry.provider, set);
    }
    set.add(entry.modelId);
  }

  const descriptors: ModelDescriptor[] = [];
  const descriptorIds = new Map<string, number>();
  const descriptorPreferredDuplicateSources = new Map<string, boolean>();
  const addListedDescriptor = (descriptor: ModelDescriptor, preferredDuplicateSource: boolean): void => {
    const existingIndex = descriptorIds.get(descriptor.id);
    if (existingIndex !== undefined) {
      if (preferredDuplicateSource && descriptorPreferredDuplicateSources.get(descriptor.id) !== true) {
        descriptors[existingIndex] = descriptor;
        descriptorPreferredDuplicateSources.set(descriptor.id, true);
      }
      return;
    }
    descriptorIds.set(descriptor.id, descriptors.length);
    descriptorPreferredDuplicateSources.set(descriptor.id, preferredDuplicateSource);
    descriptors.push(descriptor);
  };
  // A fast sibling folds into its base row once every row exists, so the
  // picker lists one row per model and Fast becomes that row's toggle.
  const fastSiblings: Array<{ providerId: string; baseModelId: string; descriptor: ModelDescriptor; preferredDuplicateSource: boolean }> = [];

  const modelsByProvider = new Map<string, OpenCodeModelInfo[]>();
  for (const model of args.models) {
    if (model.enabled === false || !model.id?.trim() || !model.providerID?.trim()) continue;
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }

  for (const [providerId, models] of modelsByProvider) {
    const isLocal = isLocalProviderFamily(providerId);
    const discoveryExists = isLocal && discoveredLocalProviderIds.has(providerId);
    if (isLocal && !discoveryExists) continue;
    const allowedModels = discoveryExists ? loadedLocalModelIds.get(providerId) : undefined;
    const listedModelIds = new Set(models.map((model) => model.id.trim()));
    for (const model of models) {
      const mid = model.id.trim();
      if (discoveryExists && (!allowedModels || !allowedModels.has(mid))) continue;
      const variants = classifyOpenCodeVariants(model);
      const fastRoutes = openCodeFastRoutesFromVariants(variants);
      const rawDisplayName = model.name?.trim() || undefined;
      const normalizedModel = normalizeOpenCodeProviderModel(providerId, mid, rawDisplayName);
      const ctx = model.limit?.context;
      const out = model.limit?.output;
      const descriptor = createDynamicOpenCodeModelDescriptor("", {
        openCodeProviderId: providerId,
        openCodeModelId: normalizedModel.modelId,
        ...(normalizedModel.displayName ? { displayName: normalizedModel.displayName } : {}),
        ...(normalizedModel.contextWindow
          ? { contextWindow: normalizedModel.contextWindow }
          : typeof ctx === "number" && ctx > 0 ? { contextWindow: ctx } : {}),
        ...(normalizedModel.maxOutputTokens
          ? { maxOutputTokens: normalizedModel.maxOutputTokens }
          : typeof out === "number" && out > 0 ? { maxOutputTokens: out } : {}),
        ...(variants.reasoningTiers.length ? { reasoningTiers: variants.reasoningTiers } : {}),
        ...(fastRoutes ? { serviceTiers: ["fast"] } : {}),
        reportedTiers: true,
        capabilities: normalizedModel.capabilities ?? readOpenCodeModelCapabilities(model),
      });
      // Keep ADE's normalized identity/display metadata, but always route
      // through the exact model ID OpenCode advertised. An alias row may
      // normalize to a newer canonical ADE ID that this provider cannot
      // actually launch.
      descriptor.openCodeModelId = mid;
      descriptor.providerModelId = `${providerId}/${mid}`;
      if (Object.keys(variants.variantKeys).length) descriptor.openCodeVariantKeys = variants.variantKeys;
      if (fastRoutes) descriptor.openCodeFast = fastRoutes;
      const baseModelId = openCodeFastSiblingBaseId(model, listedModelIds);
      if (baseModelId) {
        fastSiblings.push({ providerId, baseModelId, descriptor, preferredDuplicateSource: normalizedModel.preferredDuplicateSource });
        continue;
      }
      addListedDescriptor(descriptor, normalizedModel.preferredDuplicateSource);
    }
  }

  const listedByRoute = new Map(descriptors.map((descriptor) => [
    `${descriptor.openCodeProviderId}\u0000${descriptor.openCodeModelId}`,
    descriptor,
  ]));
  // A folded sibling leaves the picker but stays in the registry, so a chat
  // saved on its id still resolves and still runs the sibling.
  const unlistedDescriptors: ModelDescriptor[] = [];
  for (const sibling of fastSiblings) {
    const base = listedByRoute.get(`${sibling.providerId}\u0000${sibling.baseModelId}`);
    if (!base) {
      // The base row lost a duplicate-id contest to a row that routes to
      // another model, so the sibling keeps a row of its own.
      addListedDescriptor(sibling.descriptor, sibling.preferredDuplicateSource);
      continue;
    }
    foldOpenCodeFastSibling(base, sibling.descriptor);
    if (!descriptorIds.has(sibling.descriptor.id)) unlistedDescriptors.push(sibling.descriptor);
  }

  const modelIds = descriptors
    .filter((d) => (d.openCodeProviderId ? connected.has(d.openCodeProviderId) : true))
    .map((d) => d.id)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const modelCounts = new Map<string, number>();
  for (const descriptor of descriptors) {
    const providerId = descriptor.openCodeProviderId ?? "opencode";
    modelCounts.set(providerId, (modelCounts.get(providerId) ?? 0) + 1);
  }

  const providerInfos: OpenCodeProviderInfo[] = [];
  const seen = new Set<string>();
  const addProvider = (id: string, name: string, envVars: string[] | undefined, hasConnection: boolean): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const credentialSource = resolveOpenCodeCredentialSource(args.projectConfig, id, envVars);
    const count = modelCounts.get(id) ?? 0;
    providerInfos.push({
      id,
      name: openCodeProviderDisplayName(id, name),
      connected: connected.has(id) || hasConnection,
      ...(hasConnection ? { signedIn: true } : {}),
      modelCount: count,
      availableModelCount: connected.has(id) ? count : 0,
      ...(envVars?.length ? { envVars } : {}),
      ...(credentialSource ? { credentialSource } : {}),
    });
  };
  // Integrations are the catalog (every provider a user can connect); a
  // provider only in config (a custom or local one) is added after them.
  for (const integration of args.integrations) {
    const envVars = [...new Set(integration.methods.flatMap((method) => (
      method.type === "env" ? method.names.map((name) => name.trim()).filter(Boolean) : []
    )))];
    addProvider(integration.id, integration.name || integration.id, envVars, integration.connections.length > 0);
  }
  for (const provider of args.providers) {
    addProvider(provider.id, provider.name || provider.id, undefined, false);
  }

  return { modelIds, providers: providerInfos, descriptors, registryDescriptors: [...descriptors, ...unlistedDescriptors] };
}

/**
 * Lists providers and models on the shared OpenCode server, updates the model
 * registry, and caches the result in memory and on disk. Without `force`, a
 * fresh, non-stale cache (memory, then disk) answers without any server.
 * Concurrent calls are deduplicated.
 */
export async function probeOpenCodeProviderInventory(args: {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  logger: Logger;
  force?: boolean;
  /** Dynamically discovered models from local provider endpoints (LM Studio, Ollama). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
}): Promise<OpenCodeInventoryResult> {
  if (!resolveOpenCodeBinaryPath()) {
    replaceDynamicOpenCodeModelDescriptors([]);
    inventoryCache = null;
    return { modelIds: [], providers: [], error: null, descriptors: [] };
  }
  if (args.discoveredLocalModels) lastDiscoveredLocalModels = args.discoveredLocalModels;

  const fp = fingerprintOpenCodeConfig(args.projectConfig, args.discoveredLocalModels);
  const passiveFp = fingerprintOpenCodeConfig(args.projectConfig);
  const isUsable = (entry: { stale: boolean; configFingerprint: string; cachedAt?: number; savedAt?: number }): boolean => {
    const at = entry.cachedAt ?? entry.savedAt ?? 0;
    return !entry.stale && entry.configFingerprint === fp && Date.now() - at < TTL_MS;
  };
  if (!args.force) {
    const cache = inventoryCache;
    if (
      cache
      && cache.projectRoot === args.projectRoot
      && (cache.error
        ? cache.configFingerprint === fp && Date.now() - cache.cachedAt < ERROR_TTL_MS
        : isUsable(cache))
    ) {
      return {
        modelIds: cache.modelIds,
        providers: cache.providers,
        error: cache.error,
        descriptors: cache.registryDescriptors,
      };
    }
    const persisted = readPersistedInventoryFile().entries[args.projectRoot];
    if (persisted && isUsable(persisted)) {
      const hydrated = hydrateFromPersisted(args.projectRoot, persisted);
      return { modelIds: hydrated.modelIds, providers: hydrated.providers, error: null, descriptors: hydrated.registryDescriptors };
    }
  }

  const probeKey = `${args.projectRoot}::${fp}`;
  const existing = probeInFlightMap.get(probeKey);
  if (existing) return existing;

  const probePromise = (async (): Promise<OpenCodeInventoryResult> => {
    try {
      const lease = await acquireOpenCodeServer({
        config: buildOpenCodeConfig({
          projectConfig: args.projectConfig,
          discoveredLocalModels: args.discoveredLocalModels ?? lastDiscoveredLocalModels,
        }),
        // Providers are built from the same inputs a chat uses, so a new key or
        // local model reaches a running server; its skills and agents stay.
        configMode: "providers",
        ownerKind: "inventory",
        ownerId: args.projectRoot,
        logger: args.logger,
      });
      let listed: Parameters<typeof buildInventory>[0];
      try {
        const location = { directory: args.projectRoot };
        // A server that just started answers `model.list` with nothing until
        // its catalog loads; `integration.list` waits for that load (verified
        // on 2.0.18), so it goes first. One short retry covers a slower load.
        const integrations = await lease.client.integration.list({ location });
        let [models, providers] = await Promise.all([
          lease.client.model.list({ location }),
          lease.client.provider.list({ location }),
        ]);
        if (!models.data.length) {
          await new Promise((resolve) => setTimeout(resolve, CATALOG_RETRY_DELAY_MS));
          [models, providers] = await Promise.all([
            lease.client.model.list({ location }),
            lease.client.provider.list({ location }),
          ]);
        }
        listed = {
          projectConfig: args.projectConfig,
          discoveredLocalModels: args.discoveredLocalModels,
          models: models.data,
          providers: providers.data,
          integrations: integrations.data,
        };
      } finally {
        lease.release();
      }
      const inventory = buildInventory(listed);
      replaceDynamicOpenCodeModelDescriptors(inventory.registryDescriptors);
      inventoryCache = {
        cachedAt: Date.now(),
        projectRoot: args.projectRoot,
        configFingerprint: fp,
        passiveConfigFingerprint: passiveFp,
        stale: false,
        modelIds: inventory.modelIds,
        providers: inventory.providers,
        registryDescriptors: inventory.registryDescriptors,
        authMethods: openCodeAuthMethodsFromIntegrations(listed.integrations),
        error: null,
      };
      persistEntry(inventoryCache);
      return { modelIds: inventory.modelIds, providers: inventory.providers, error: null, descriptors: inventory.descriptors };
    } catch (err) {
      const message = openCodeErrorMessage(err);
      args.logger.warn("opencode.inventory_probe_failed", { error: message });
      // A failed probe keeps the last good models drawable rather than
      // emptying the picker, and still reports the error.
      const persisted = readPersistedInventoryFile().entries[args.projectRoot];
      if (persisted) {
        const hydrated = hydrateFromPersisted(args.projectRoot, persisted);
        hydrated.error = message;
        hydrated.cachedAt = Date.now();
        hydrated.configFingerprint = fp;
        return { modelIds: hydrated.modelIds, providers: hydrated.providers, error: message, descriptors: hydrated.registryDescriptors };
      }
      replaceDynamicOpenCodeModelDescriptors([]);
      inventoryCache = {
        cachedAt: Date.now(),
        projectRoot: args.projectRoot,
        configFingerprint: fp,
        passiveConfigFingerprint: passiveFp,
        stale: false,
        modelIds: [],
        providers: [],
        registryDescriptors: [],
        authMethods: {},
        error: message,
      };
      return { modelIds: [], providers: [], error: message, descriptors: [] };
    } finally {
      probeInFlightMap.delete(probeKey);
    }
  })();

  probeInFlightMap.set(probeKey, probePromise);
  return probePromise;
}

/**
 * Read the inventory without starting a server: the in-memory cache, else the
 * persisted one for this project and config (which also loads its models into
 * the registry). May be stale; null when nothing matches.
 */
export function peekOpenCodeInventoryCache(args: {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
}): { modelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null } | null {
  const fp = fingerprintOpenCodeConfig(args.projectConfig);
  if (
    inventoryCache
    && inventoryCache.projectRoot === args.projectRoot
    && (inventoryCache.passiveConfigFingerprint === fp || inventoryCache.configFingerprint === fp)
  ) {
    return { modelIds: inventoryCache.modelIds, providers: inventoryCache.providers, error: inventoryCache.error };
  }
  const persisted = readPersistedInventoryFile().entries[args.projectRoot];
  if (!persisted || persisted.passiveConfigFingerprint !== fp) return null;
  const hydrated = hydrateFromPersisted(args.projectRoot, persisted);
  return { modelIds: hydrated.modelIds, providers: hydrated.providers, error: null };
}

/**
 * The sign-in methods the last probe saw for this project, without starting a
 * server. They change only with the OpenCode version, so a cached list is good.
 */
export function peekOpenCodeAuthMethods(projectRoot: string): OpenCodeProviderAuthMethods | null {
  if (inventoryCache?.projectRoot === projectRoot && Object.keys(inventoryCache.authMethods).length) {
    return inventoryCache.authMethods;
  }
  const persisted = readPersistedInventoryFile().entries[projectRoot]?.authMethods;
  return persisted && Object.keys(persisted).length ? persisted : null;
}
