/**
 * Live model catalogs for the ACP providers (Qwen, Kimi, Grok, Copilot, Devin).
 *
 * Every one of these providers decides its model list on its own server, per
 * account. ADE's curated rows for them are only the offline fallback: once the
 * provider has named its models, `modelRegistry` shows exactly that list (see
 * `hasLiveAcpModelCatalog`). This module is where the live list comes from
 * when no chat is open, and where it survives a restart.
 *
 * - **Sources.** A chat session's `session/new` reports the list as its
 *   `model` config option; the chat service hands it to
 *   `recordAcpSessionModelCatalog`. With no session, `warmAcpModelCatalog`
 *   asks the provider directly: Devin through `devin models list`, the others
 *   through a bare ACP `initialize` + `session/new`. The probe never sends a
 *   prompt, so it costs no quota, and it closes its session and process.
 * - **Never on the read path.** A catalog read serves what is cached and, when
 *   the cache is older than the TTL, starts one background warm. Warms run one
 *   at a time, so a cold start spawns at most one CLI at once.
 * - **A live session is the probe.** A chat that opened refreshed the cache, so
 *   a warm within the TTL finds it fresh and spawns nothing.
 * - **Persistence.** The last good list per provider lives in Electron
 *   `userData` (`acp-model-catalog-cache.json`), next to OpenCode's inventory
 *   cache. An old list is still served: the provider's last real answer beats
 *   the curated rows. It is only refreshed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDynamicAcpModelDescriptor,
  curatedReasoningHintForModelName,
  getLiveAcpModelDescriptors,
  hasLiveAcpModelCatalog,
  mergeDynamicAcpModelDescriptors,
  replaceDynamicAcpModelDescriptors,
  resolveAcpModelDescriptor,
  type AcpModelProviderGroup,
  type ModelDescriptor,
} from "../../../../shared/modelRegistry";
import type { Logger } from "../../logging/logger";
import { acpProbeConfigHome } from "../../ai/acpAuthProbe";
import { resolveAcpExecutable } from "../../ai/acpExecutables";
import { prepareAcpProbeSpawnPlan } from "../../ai/acpProbeSpawnPlan";
import { createAcpConnection, initializeAcpConnection } from "./acpConnection";
import { acpDialectFor } from "./acpDialects";
import { COPILOT_REASONING_EFFORTS } from "./acpDialects/copilot";
import { ACP_EFFORT_LADDER } from "./acpDialects/shared";
import { resolveAdeCacheFile } from "../../shared/adeCacheFile";
import { writeTextAtomic } from "../../shared/utils";
import {
  ACP_METHOD,
  hasAcpSessionCapability,
  normalizeAcpConfigOptions,
} from "./acpProtocolTypes";

/** A list younger than this is fresh: no warm. */
const CATALOG_TTL_MS = 6 * 60 * 60_000;
/** A failed warm is not retried on every read. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const CACHE_FILE_VERSION = 1;
/** A chat re-reporting the same list rewrites the file at most this often. */
const SESSION_REWRITE_MIN_MS = 30 * 60_000;

/** ADE's effort ladder, filtered to what an agent listed. */
export function acpAdvertisedReasoningTiers(values: readonly string[]): string[] {
  const offered = new Set(values.map((value) => value.trim().toLowerCase()));
  return ACP_EFFORT_LADDER.filter((tier) => offered.has(tier));
}

export type LiveAcpModelEntry = { id: string; name?: string | null };

/**
 * Turn a provider's live model list into registry rows.
 *
 * The effort option a session lists describes its current model only. So the
 * current model takes the listed efforts; any other model keeps what the
 * registry already holds for it (a curated row's researched tiers, or what it
 * had when it was current). A model with neither:
 * - Copilot: its documented levels, unless the model is Auto or is known not
 *   to reason. Copilot falls back on its own when a level does not apply, and
 *   ADE only sends the session option when the session lists the level.
 * - Others: the session's listed efforts, the only evidence there is.
 */
export function buildLiveAcpModelDescriptors(args: {
  provider: AcpModelProviderGroup;
  models: readonly LiveAcpModelEntry[];
  currentModelId?: string | null;
  advertisedEffortValues?: readonly string[];
}): ModelDescriptor[] {
  const advertised = acpAdvertisedReasoningTiers(args.advertisedEffortValues ?? []);
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const entry of args.models) {
    const modelId = entry.id.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    // Read before the merge replaces it.
    const learned = resolveAcpModelDescriptor(args.provider, modelId)?.reasoningTiers ?? [];
    let reasoningTiers: string[];
    if (args.provider === "copilot") {
      reasoningTiers = modelId === args.currentModelId && advertised.length
        ? advertised
        : learned.length
          ? [...learned]
          : copilotFallbackTiers(modelId);
    } else {
      reasoningTiers = modelId === args.currentModelId || !learned.length ? advertised : [...learned];
    }
    const name = entry.name?.trim();
    out.push(createDynamicAcpModelDescriptor(args.provider, modelId, {
      ...(name && name !== modelId ? { displayName: name } : {}),
      ...(reasoningTiers.length ? { reasoningTiers } : {}),
    }));
  }
  return out;
}

function copilotFallbackTiers(modelId: string): string[] {
  const id = modelId.toLowerCase();
  if (id === "auto") return [];
  if (/^gpt-(3|4)/.test(id)) return [];
  if (curatedReasoningHintForModelName(modelId) === false) return [];
  return [...COPILOT_REASONING_EFFORTS];
}

// ── Persistence ──────────────────────────────────────────────────────────────

type PersistedCatalog = { savedAt: number; models: ModelDescriptor[] };
type PersistedFile = { version: number; providers: Partial<Record<AcpModelProviderGroup, PersistedCatalog>> };
let fileMemo: PersistedFile | null = null;
let appliedFromDisk = false;

function cacheFilePath(): string {
  return resolveAdeCacheFile("acp-model-catalog-cache.json");
}

function isDescriptorFor(provider: AcpModelProviderGroup, value: unknown): value is ModelDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.displayName === "string"
    && typeof record.providerModelId === "string"
    && record.providerRoute === `${provider}-acp`
    && Boolean(record.capabilities && typeof record.capabilities === "object");
}

function readFile(): PersistedFile {
  if (fileMemo) return fileMemo;
  const empty: PersistedFile = { version: CACHE_FILE_VERSION, providers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8")) as unknown;
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    if (!record || record.version !== CACHE_FILE_VERSION || !record.providers || typeof record.providers !== "object") {
      fileMemo = empty;
      return empty;
    }
    const providers: PersistedFile["providers"] = {};
    for (const [key, raw] of Object.entries(record.providers as Record<string, unknown>)) {
      const provider = key as AcpModelProviderGroup;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt)) continue;
      if (!Array.isArray(entry.models)) continue;
      const models = entry.models.filter((model): model is ModelDescriptor => isDescriptorFor(provider, model)).map((model) => {
        // Older catalogs predate Copilot's --effort support. Restore the
        // fallback immediately, rather than hiding the control until the
        // six-hour catalog refresh. Keep any provider-reported tiers intact.
        if (provider !== "copilot" || model.reasoningTiers?.length) return model;
        const tiers = copilotFallbackTiers(model.providerModelId);
        return tiers.length
          ? { ...model, reasoningTiers: tiers, capabilities: { ...model.capabilities, reasoning: true } }
          : model;
      });
      if (models.length) providers[provider] = { savedAt: entry.savedAt, models };
    }
    fileMemo = { version: CACHE_FILE_VERSION, providers };
  } catch {
    fileMemo = empty;
  }
  return fileMemo;
}

/**
 * `savedAt` is the age of the last COMPLETE list, and what the TTL counts
 * from. A partial update (a Devin session's families) keeps the age it had, so
 * the next complete probe still comes due.
 */
function persist(provider: AcpModelProviderGroup, models: ModelDescriptor[], savedAt = Date.now()): void {
  const current = readFile();
  const next: PersistedFile = {
    version: CACHE_FILE_VERSION,
    providers: { ...current.providers, [provider]: { savedAt, models } },
  };
  fileMemo = next;
  try {
    writeTextAtomic(cacheFilePath(), JSON.stringify(next));
  } catch {
    // The in-memory registry already has the list; only the restart copy is lost.
  }
}

/**
 * Put the persisted lists into the registry, once per process, for providers
 * that have no live list yet. Cheap after the first call.
 */
export function applyPersistedAcpModelCatalogs(): void {
  if (appliedFromDisk) return;
  appliedFromDisk = true;
  for (const [provider, entry] of Object.entries(readFile().providers) as Array<[AcpModelProviderGroup, PersistedCatalog]>) {
    if (!hasLiveAcpModelCatalog(provider)) replaceDynamicAcpModelDescriptors(provider, entry.models);
  }
}

function signature(models: readonly ModelDescriptor[]): string {
  return JSON.stringify(models.map((model) => [model.id, model.displayName, model.reasoningTiers ?? []]));
}

/**
 * Record what a chat session's agent reported, then persist it.
 *
 * A session's model option is the provider's complete list, so it replaces
 * what was there: a model the provider dropped, or one from another account,
 * leaves the picker. Devin is the exception: its sessions list model families
 * while `devin models list` lists the variants, so a Devin session is merged in
 * and does not count as a fresh complete list.
 */
export function recordAcpSessionModelCatalog(provider: AcpModelProviderGroup, descriptors: ModelDescriptor[]): void {
  if (!descriptors.length) return;
  applyPersistedAcpModelCatalogs();
  const saved = readFile().providers[provider];
  const partial = provider === "devin";
  if (partial) mergeDynamicAcpModelDescriptors(provider, descriptors);
  else replaceDynamicAcpModelDescriptors(provider, descriptors);
  const live = getLiveAcpModelDescriptors(provider);
  // An unchanged list is not written again: within 30 minutes of the last
  // complete list, and never for a partial update, whose age does not move.
  if (saved && signature(saved.models) === signature(live) && (partial || Date.now() - saved.savedAt < SESSION_REWRITE_MIN_MS)) return;
  persist(provider, live, partial ? saved?.savedAt ?? 0 : Date.now());
}

/**
 * The provider's sign-in changed (signed out, or signed in again, possibly as
 * another account), so its saved list may belong to someone else. It stays
 * shown, but counts as old: the next catalog read probes for the real one.
 */
export function markAcpModelCatalogStale(provider: AcpModelProviderGroup): void {
  const saved = readFile().providers[provider];
  lastEmptyAt.delete(provider);
  lastFailureAt.delete(provider);
  if (saved && saved.savedAt !== 0) persist(provider, saved.models, 0);
}

/** Replace a provider's list with a complete answer from the provider, and persist it. */
function recordProbedCatalog(provider: AcpModelProviderGroup, descriptors: ModelDescriptor[]): void {
  replaceDynamicAcpModelDescriptors(provider, descriptors);
  persist(provider, getLiveAcpModelDescriptors(provider));
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** Spawn one ACP agent, open a session, read its model list, close. No prompt. */
async function probeAcpModels(provider: Exclude<AcpModelProviderGroup, "devin">, env: NodeJS.ProcessEnv): Promise<ModelDescriptor[]> {
  const dialect = acpDialectFor(provider);
  // A throwaway cwd: agents that keep a session record per cwd (Copilot's
  // session-state) file the probe away from every project.
  const cwd = path.join(os.tmpdir(), "ade-acp-model-probe");
  fs.mkdirSync(cwd, { recursive: true });
  const executable = resolveAcpExecutable(provider, { env });
  const spawnPlan = await prepareAcpProbeSpawnPlan(provider, dialect.buildSpawnPlan({
    binaryPath: executable.path,
    cwd,
    baseEnv: env,
    configHome: acpProbeConfigHome(provider, env),
  }));
  const connection = createAcpConnection({ dialect, spawnPlan });
  try {
    const init = await initializeAcpConnection({ connection, dialect, timeoutMs: PROBE_TIMEOUT_MS });
    const created = await connection.request<Record<string, unknown>>(
      ACP_METHOD.sessionNew,
      { cwd, mcpServers: [] },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const options = normalizeAcpConfigOptions(created?.configOptions);
    const modelOption = options.find((option) => option.id === (dialect.modelConfigOptionId ?? "model"));
    let models: LiveAcpModelEntry[] = (modelOption?.options ?? []).map((entry) => ({ id: entry.id, name: entry.name }));
    let currentModelId = typeof modelOption?.value === "string" ? modelOption.value : null;
    // The older `models` session field, for an agent that lists models there only.
    const legacy = created?.models as { availableModels?: unknown; currentModelId?: unknown } | undefined;
    if (!models.length && Array.isArray(legacy?.availableModels)) {
      models = legacy.availableModels.flatMap((entry) => {
        const row = entry as { modelId?: unknown; name?: unknown } | null;
        return row && typeof row.modelId === "string" && row.modelId.trim()
          ? [{ id: row.modelId, name: typeof row.name === "string" ? row.name : null }]
          : [];
      });
      currentModelId = typeof legacy?.currentModelId === "string" ? legacy.currentModelId : null;
    }
    const effortConfigId = dialect.reasoningEffortOption?.configId;
    const effortOption = effortConfigId ? options.find((option) => option.id === effortConfigId) : undefined;
    const sessionId = typeof created?.sessionId === "string" ? created.sessionId : null;
    if (sessionId && hasAcpSessionCapability(init.agentCapabilities, "close")) {
      await connection.request(ACP_METHOD.sessionClose, { sessionId }, { timeoutMs: 5_000 }).catch(() => undefined);
    }
    return buildLiveAcpModelDescriptors({
      provider,
      models,
      currentModelId,
      advertisedEffortValues: (effortOption?.options ?? []).map((entry) => entry.id),
    });
  } finally {
    connection.dispose("model discovery finished");
  }
}

async function discoverProviderModels(provider: AcpModelProviderGroup, env: NodeJS.ProcessEnv): Promise<ModelDescriptor[]> {
  if (provider === "devin") {
    // Loaded on use: this module sits under the chat service's import graph.
    const { discoverDevinModels } = await import("../../ai/devinModelsDiscovery");
    const executable = resolveAcpExecutable("devin", { env });
    return discoverDevinModels(executable.source === "fallback-command" ? undefined : { binaryPath: executable.path });
  }
  return probeAcpModels(provider, env);
}

const inFlight = new Set<AcpModelProviderGroup>();
const lastFailureAt = new Map<AcpModelProviderGroup, number>();
/** A provider that answered with no model list (an Auto-only plan) is not asked again until the TTL. */
const lastEmptyAt = new Map<AcpModelProviderGroup, number>();
let queue: Promise<void> = Promise.resolve();

/**
 * Refresh one provider's live list in the background when it is missing or
 * older than the TTL. Call only for a provider that is installed and signed
 * in. Never throws, never blocks: the read that calls this serves the cache.
 */
export function warmAcpModelCatalog(
  provider: AcpModelProviderGroup,
  options?: { env?: NodeJS.ProcessEnv; logger?: Pick<Logger, "info" | "warn"> },
): void {
  applyPersistedAcpModelCatalogs();
  const saved = readFile().providers[provider];
  if (saved && Date.now() - saved.savedAt < CATALOG_TTL_MS) return;
  if (inFlight.has(provider)) return;
  if (Date.now() - (lastFailureAt.get(provider) ?? 0) < RETRY_AFTER_FAILURE_MS) return;
  if (Date.now() - (lastEmptyAt.get(provider) ?? 0) < CATALOG_TTL_MS) return;
  inFlight.add(provider);
  queue = queue.then(async () => {
    // A chat may have refreshed the list while this warm waited its turn.
    const latest = readFile().providers[provider];
    if (latest && Date.now() - latest.savedAt < CATALOG_TTL_MS) return;
    try {
      const models = await discoverProviderModels(provider, options?.env ?? process.env);
      if (!models.length) {
        // No list (an Auto-only plan with no model option, a signed-out CLI):
        // keep whatever is shown. Asking again every few minutes would start
        // the CLI and open a session each time for the same empty answer.
        lastEmptyAt.set(provider, Date.now());
        options?.logger?.warn?.("ai.acp_model_discovery.empty", { provider });
        return;
      }
      recordProbedCatalog(provider, models);
      options?.logger?.info?.("ai.acp_model_discovery.ready", { provider, count: models.length });
    } catch (error) {
      lastFailureAt.set(provider, Date.now());
      options?.logger?.warn?.("ai.acp_model_discovery.failed", {
        provider,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }).finally(() => {
    inFlight.delete(provider);
  });
}
