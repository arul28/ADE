import {
  createDynamicCursorCliModelDescriptor,
  sortCursorCliDescriptorsForPicker,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";
import type { SDKModel } from "@cursor/sdk";
import { createHash } from "node:crypto";
import {
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeReady,
} from "../ai/providerRuntimeHealth";

export type CursorModelParameterValue = { id: string; value: string };
export type CursorModelParameterDefinition = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};
export type CursorModelVariant = {
  params: CursorModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};
export type CursorCliModelRow = {
  id: string;
  displayName?: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorModelParameterDefinition[];
  variants?: CursorModelVariant[];
  reasoningTiers?: string[];
  serviceTiers?: string[];
};
type CursorCliModelDiscoveryMode = "probe" | "cached-or-fallback" | "cached-only";
export type CursorModelDiscoveryFailureKind = "auth" | "timeout" | "unavailable";
export type CursorSdkModelDiscoveryResult = {
  rows: CursorCliModelRow[];
  failureKind: CursorModelDiscoveryFailureKind | null;
  errorMessage: string | null;
  fromCache?: boolean;
};

let cached: { at: number; models: CursorCliModelRow[] } | null = null;
let sdkCached: { at: number; keyHash: string; models: CursorCliModelRow[] } | null = null;
let sdkWarmInFlight: { keyHash: string; promise: Promise<CursorCliModelRow[]> } | null = null;
let sdkLastFailure: { at: number; keyHash: string; kind: CursorModelDiscoveryFailureKind; message: string } | null = null;
let sdkCacheGeneration = 0;
const TTL_MS = 120_000;
const SDK_MODEL_LIST_TIMEOUT_MS = 5_000;
const CURSOR_MODELS_API_URL = "https://api.cursor.com/v0/models";
const CURSOR_AGENT_AUTH_BLOCKER =
  "Cursor rejected the configured API key for agent/model access. Re-enter a Cursor API key from the Cursor dashboard integrations page.";

class CursorModelDiscoveryError extends Error {
  readonly kind: CursorModelDiscoveryFailureKind;

  constructor(kind: CursorModelDiscoveryFailureKind, message: string) {
    super(message);
    this.name = "CursorModelDiscoveryError";
    this.kind = kind;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Parse `agent models` table output (`id - Label (current)`) and bare id lines.
 * Exported for unit tests.
 */
export function parseCursorCliModelsStdout(stdout: string): CursorCliModelRow[] {
  const text = stripAnsi(stdout);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: CursorCliModelRow[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^loading models/i.test(line) || /^available models/i.test(line)) continue;
    const table = line.match(/^([a-z0-9][\w.-]*)\s+-\s+(.+)$/i);
    if (table) {
      const id = table[1].trim();
      const label = table[2].replace(/\s*\(current\)\s*$/i, "").trim();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, displayName: label });
      }
      continue;
    }
    if (/^[\w.-]+$/.test(line) && !seen.has(line)) {
      seen.add(line);
      out.push({ id: line });
    }
  }
  return out;
}

export function clearCursorCliModelsCache(): void {
  cached = null;
  sdkCached = null;
  sdkWarmInFlight = null;
  sdkLastFailure = null;
  sdkCacheGeneration += 1;
}

function hashKeyForCache(key: string | null | undefined): string {
  const text = String(key ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  }
  return String(error ?? "Unknown Cursor model discovery error.");
}

function normalizeCursorMetadataText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function addUnique(out: string[], value: string | null | undefined): void {
  const normalized = normalizeCursorMetadataText(value);
  if (!normalized) return;
  if (!out.some((entry) => normalizeCursorMetadataText(entry) === normalized)) {
    out.push(normalized);
  }
}

function normalizeCursorModelRef(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeCursorAliasList(value: unknown, canonicalId?: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const canonical = normalizeCursorModelRef(canonicalId).toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const alias = normalizeCursorModelRef(entry);
    if (!alias || !/^[\w.-]+$/i.test(alias)) continue;
    const normalized = alias.toLowerCase();
    if (normalized === canonical || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(alias);
  }
  return out.length ? out : undefined;
}

function isReasoningParameterLike(parameter: Pick<CursorModelParameterDefinition, "id" | "displayName">): boolean {
  const hay = `${parameter.id} ${parameter.displayName ?? ""}`.toLowerCase();
  return /\b(reason|reasoning|thinking|think|effort)\b/.test(hay);
}

function isServiceTierParameterLike(parameter: Pick<CursorModelParameterDefinition, "id" | "displayName">): boolean {
  const hay = `${parameter.id} ${parameter.displayName ?? ""}`.toLowerCase();
  return /\b(speed|service|tier|mode|latency)\b/.test(hay);
}

function normalizeCursorReasoningValue(value: unknown): string | null {
  const normalized = normalizeCursorMetadataText(value);
  if (!normalized) return null;
  if (normalized === "extra-high" || normalized === "extra_high") return "xhigh";
  if ([
    "none",
    "dynamic",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "thinking",
  ].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeCursorServiceTierValue(value: unknown): string | null {
  const normalized = normalizeCursorMetadataText(value);
  return normalized === "fast" ? "fast" : null;
}

function normalizeCursorParameterDefinitions(value: unknown): CursorModelParameterDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CursorModelParameterDefinition[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const rawValues = Array.isArray(record?.values) ? record.values : [];
    if (!id || !rawValues.length) continue;
    const values = rawValues.flatMap((rawValue): Array<{ value: string; displayName?: string }> => {
      if (typeof rawValue === "string") return rawValue.trim() ? [{ value: rawValue.trim() }] : [];
      const valueRecord = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : null;
      const value = typeof valueRecord?.value === "string" ? valueRecord.value.trim() : "";
      if (!value) return [];
      const displayName = typeof valueRecord?.displayName === "string" && valueRecord.displayName.trim().length
        ? valueRecord.displayName.trim()
        : undefined;
      return displayName ? [{ value, displayName }] : [{ value }];
    });
    if (!values.length) continue;
    const displayName = typeof record?.displayName === "string" && record.displayName.trim().length
      ? record.displayName.trim()
      : undefined;
    out.push(displayName ? { id, displayName, values } : { id, values });
  }
  return out.length ? out : undefined;
}

function normalizeCursorModelVariants(value: unknown): CursorModelVariant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CursorModelVariant[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const displayName = typeof record?.displayName === "string" ? record.displayName.trim() : "";
    const rawParams = Array.isArray(record?.params) ? record.params : [];
    if (!displayName || !rawParams.length) continue;
    const params = rawParams.flatMap((param): CursorModelParameterValue[] => {
      const paramRecord = param && typeof param === "object" ? param as Record<string, unknown> : null;
      const id = typeof paramRecord?.id === "string" ? paramRecord.id.trim() : "";
      const value = typeof paramRecord?.value === "string" ? paramRecord.value.trim() : "";
      return id && value ? [{ id, value }] : [];
    });
    if (!params.length) continue;
    const description = typeof record?.description === "string" && record.description.trim().length
      ? record.description.trim()
      : undefined;
    const isDefault = record?.isDefault === true;
    out.push({
      params,
      displayName,
      ...(description ? { description } : {}),
      ...(isDefault ? { isDefault } : {}),
    });
  }
  return out.length ? out : undefined;
}

function deriveCursorRuntimeTiers(row: Pick<CursorCliModelRow, "parameters" | "variants">): {
  reasoningTiers: string[];
  serviceTiers: string[];
} {
  const reasoningTiers: string[] = [];
  const serviceTiers: string[] = [];
  const reasoningParameterIds = new Set(
    (row.parameters ?? []).filter(isReasoningParameterLike).map((entry) => entry.id),
  );
  const serviceTierParameterIds = new Set(
    (row.parameters ?? []).filter(isServiceTierParameterLike).map((entry) => entry.id),
  );

  for (const parameter of row.parameters ?? []) {
    if (reasoningParameterIds.has(parameter.id)) {
      for (const value of parameter.values) {
        addUnique(reasoningTiers, normalizeCursorReasoningValue(value.value) ?? normalizeCursorReasoningValue(value.displayName));
      }
    }
    if (serviceTierParameterIds.has(parameter.id)) {
      for (const value of parameter.values) {
        addUnique(serviceTiers, normalizeCursorServiceTierValue(value.value) ?? normalizeCursorServiceTierValue(value.displayName));
      }
    }
  }

  for (const variant of row.variants ?? []) {
    const label = `${variant.displayName} ${variant.description ?? ""}`;
    for (const param of variant.params) {
      if (reasoningParameterIds.has(param.id) || /\b(reason|thinking|effort)\b/i.test(label)) {
        addUnique(reasoningTiers, normalizeCursorReasoningValue(param.value) ?? normalizeCursorReasoningValue(label));
      }
      if (serviceTierParameterIds.has(param.id) || /\bfast\b/i.test(label)) {
        addUnique(serviceTiers, normalizeCursorServiceTierValue(param.value) ?? normalizeCursorServiceTierValue(label));
      }
    }
  }

  return { reasoningTiers, serviceTiers };
}

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode"] as const) {
    if (typeof record[key] === "number") return record[key];
    if (typeof record[key] === "string" && /^\d+$/.test(record[key])) return Number(record[key]);
  }
  const embedded = readErrorMessage(error).match(/\b(?:status|statusCode|HTTP)\s*[=:]?\s*(401|403|408|429|5\d\d)\b/i);
  return embedded ? Number(embedded[1]) : null;
}

function classifyCursorModelDiscoveryError(error: unknown): CursorModelDiscoveryFailureKind {
  if (error instanceof CursorModelDiscoveryError) return error.kind;
  const status = readErrorStatus(error);
  if (status === 401 || status === 403) return "auth";
  const message = readErrorMessage(error).toLowerCase();
  if (
    message.includes("authentication")
    || message.includes("unauthorized")
    || message.includes("forbidden")
    || message.includes("invalid api key")
    || message.includes("api key")
  ) {
    return "auth";
  }
  if (message.includes("timeout") || message.includes("timed out") || status === 408) return "timeout";
  return "unavailable";
}

function toCursorModelDiscoveryError(error: unknown): CursorModelDiscoveryError {
  if (error instanceof CursorModelDiscoveryError) return error;
  return new CursorModelDiscoveryError(
    classifyCursorModelDiscoveryError(error),
    readErrorMessage(error),
  );
}

function recordCursorModelDiscoverySuccess(rows: CursorCliModelRow[]): void {
  if (rows.length) reportProviderRuntimeReady("cursor");
}

function recordCursorModelDiscoveryFailure(error: unknown): CursorModelDiscoveryError {
  const discoveryError = toCursorModelDiscoveryError(error);
  if (discoveryError.kind === "auth") {
    reportProviderRuntimeAuthFailure("cursor", CURSOR_AGENT_AUTH_BLOCKER);
  }
  return discoveryError;
}

function rememberCursorModelDiscoveryFailure(keyHash: string, error: unknown): CursorModelDiscoveryError {
  const discoveryError = recordCursorModelDiscoveryFailure(error);
  sdkLastFailure = {
    at: Date.now(),
    keyHash,
    kind: discoveryError.kind,
    message: discoveryError.message,
  };
  return discoveryError;
}

function normalizeSdkModelRows(models: SDKModel[]): CursorCliModelRow[] {
  const rows: CursorCliModelRow[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = String(model?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof model.displayName === "string" ? model.displayName.trim() : "";
    const description = typeof model.description === "string" && model.description.trim().length
      ? model.description.trim()
      : undefined;
    const aliases = normalizeCursorAliasList((model as { aliases?: unknown }).aliases, id);
    const parameters = normalizeCursorParameterDefinitions((model as { parameters?: unknown }).parameters);
    const variants = normalizeCursorModelVariants((model as { variants?: unknown }).variants);
    const tiers = deriveCursorRuntimeTiers({ parameters, variants });
    rows.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(aliases ? { aliases } : {}),
      ...(parameters ? { parameters } : {}),
      ...(variants ? { variants } : {}),
      ...(tiers.reasoningTiers.length ? { reasoningTiers: tiers.reasoningTiers } : {}),
      ...(tiers.serviceTiers.length ? { serviceTiers: tiers.serviceTiers } : {}),
    });
  }
  return rows;
}

function normalizeCursorModelRows(models: unknown[]): CursorCliModelRow[] {
  const rows: CursorCliModelRow[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model === "string") {
      const id = model.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        rows.push({ id });
      }
      continue;
    }
    if (!model || typeof model !== "object") continue;
    const record = model as Record<string, unknown>;
    const id = typeof record.id === "string"
      ? record.id.trim()
      : typeof record.model === "string"
        ? record.model.trim()
        : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof record.displayName === "string"
      ? record.displayName.trim()
      : typeof record.name === "string"
        ? record.name.trim()
        : "";
    const parameters = normalizeCursorParameterDefinitions(record.parameters);
    const variants = normalizeCursorModelVariants(record.variants);
    const aliases = normalizeCursorAliasList(record.aliases, id);
    const tiers = deriveCursorRuntimeTiers({ parameters, variants });
    rows.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(aliases ? { aliases } : {}),
      ...(parameters ? { parameters } : {}),
      ...(variants ? { variants } : {}),
      ...(tiers.reasoningTiers.length ? { reasoningTiers: tiers.reasoningTiers } : {}),
      ...(tiers.serviceTiers.length ? { serviceTiers: tiers.serviceTiers } : {}),
    });
  }
  return rows;
}

function getCachedCursorSdkModels(apiKey?: string | null): CursorCliModelRow[] | null {
  const now = Date.now();
  const normalizedApiKey = apiKey?.trim() || undefined;
  const keyHash = hashKeyForCache(normalizedApiKey);
  if (sdkCached && sdkCached.keyHash === keyHash && now - sdkCached.at < TTL_MS && sdkCached.models.length) {
    return sdkCached.models;
  }
  return null;
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Cursor model discovery timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function fetchCursorModelsFromSdk(
  apiKey: string | undefined,
  keyHash: string,
  generation: number,
  timeoutMs: number,
): Promise<CursorCliModelRow[]> {
  let sdkSucceeded = false;
  const rows = await withTimeout((async () => {
    let sdkError: unknown = null;
    try {
      const { Cursor } = await import("@cursor/sdk");
      const sdkRows = normalizeSdkModelRows(await Cursor.models.list({ apiKey }));
      if (sdkRows.length) {
        sdkSucceeded = true;
        return sdkRows;
      }
    } catch (error) {
      sdkError = error;
    }

    try {
      const apiRows = await fetchCursorModelsFromOfficialApi(apiKey);
      if (apiRows.length) return apiRows;
    } catch (apiError) {
      const apiFailure = toCursorModelDiscoveryError(apiError);
      if (apiFailure.kind === "auth") throw apiFailure;
      if (sdkError && classifyCursorModelDiscoveryError(sdkError) === "auth") {
        throw toCursorModelDiscoveryError(sdkError);
      }
      throw apiFailure;
    }

    if (sdkError) throw toCursorModelDiscoveryError(sdkError);
    return [];
  })(), timeoutMs);
  if (rows.length && generation === sdkCacheGeneration) {
    sdkCached = { at: Date.now(), keyHash, models: rows };
  }
  if (sdkSucceeded && rows.length && sdkLastFailure?.keyHash === keyHash) {
    sdkLastFailure = null;
  }
  if (sdkSucceeded) {
    recordCursorModelDiscoverySuccess(rows);
  }
  return rows;
}

async function fetchCursorModelsFromOfficialApi(apiKey: string | undefined): Promise<CursorCliModelRow[]> {
  const token = apiKey?.trim();
  if (!token) return [];
  const response = await fetch(CURSOR_MODELS_API_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new CursorModelDiscoveryError(
      response.status === 401 || response.status === 403 ? "auth" : "unavailable",
      `Cursor model API returned HTTP ${response.status}.`,
    );
  }
  const payload = await response.json() as { models?: unknown };
  return Array.isArray(payload.models) ? normalizeCursorModelRows(payload.models) : [];
}

function warmCursorModelsFromSdk(apiKey?: string | null): void {
  const normalizedApiKey = apiKey?.trim() || undefined;
  const keyHash = hashKeyForCache(normalizedApiKey);
  if (sdkWarmInFlight?.keyHash === keyHash) return;

  const generation = sdkCacheGeneration;
  const promise = fetchCursorModelsFromSdk(
    normalizedApiKey,
    keyHash,
    generation,
    SDK_MODEL_LIST_TIMEOUT_MS,
  ).catch((error) => {
    rememberCursorModelDiscoveryFailure(keyHash, error);
    return [];
  });
  sdkWarmInFlight = { keyHash, promise };
  promise.finally(() => {
    if (sdkWarmInFlight?.promise === promise) sdkWarmInFlight = null;
  });
}

export async function probeCursorSdkModelDiscovery(
  apiKey?: string | null,
  options?: { timeoutMs?: number; allowCached?: boolean },
): Promise<CursorSdkModelDiscoveryResult> {
  const cachedRows = options?.allowCached === true ? getCachedCursorSdkModels(apiKey) : null;
  if (cachedRows) {
    return {
      rows: cachedRows,
      failureKind: null,
      errorMessage: null,
      fromCache: true,
    };
  }

  const normalizedApiKey = apiKey?.trim() || undefined;
  const keyHash = hashKeyForCache(normalizedApiKey);
  const generation = sdkCacheGeneration;
  try {
    const rows = await fetchCursorModelsFromSdk(
      normalizedApiKey,
      keyHash,
      generation,
      Math.max(1, options?.timeoutMs ?? SDK_MODEL_LIST_TIMEOUT_MS),
    );
    return {
      rows,
      failureKind: null,
      errorMessage: null,
    };
  } catch (error) {
    const discoveryError = rememberCursorModelDiscoveryFailure(keyHash, error);
    // Best-effort: a transient SDK error or invalid key should not crash
    // model resolution — fallback IDs cover the common case.
    return {
      rows: [],
      failureKind: discoveryError.kind,
      errorMessage: discoveryError.message,
    };
  }
}

export async function listCursorModelsFromSdk(
  apiKey?: string | null,
  options?: { timeoutMs?: number; allowCached?: boolean },
): Promise<CursorCliModelRow[]> {
  return (await probeCursorSdkModelDiscovery(apiKey, options)).rows;
}

function getCachedCursorModels(): CursorCliModelRow[] | null {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS && cached.models.length) {
    return cached.models;
  }
  return null;
}

function cursorRowsToDescriptors(rows: CursorCliModelRow[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const aliases = normalizeCursorAliasList(row.aliases, id) ?? [];
    const descriptorOptions = {
      ...(row.reasoningTiers?.length ? { reasoningTiers: row.reasoningTiers } : {}),
      ...(row.serviceTiers?.length ? { serviceTiers: row.serviceTiers } : {}),
    };
    descriptors.push(createDynamicCursorCliModelDescriptor(id, row.displayName, {
      ...descriptorOptions,
      ...(aliases.length ? { aliases } : {}),
    }));
    for (const alias of aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      descriptors.push(createDynamicCursorCliModelDescriptor(alias, `${row.displayName ?? id} (${alias})`, {
        ...descriptorOptions,
        aliases: [id],
      }));
    }
  }
  return sortCursorCliDescriptorsForPicker(descriptors);
}

export function mergeCursorModelDescriptorSources(args: {
  cliDescriptors?: readonly ModelDescriptor[];
  sdkDescriptors?: readonly ModelDescriptor[];
}): ModelDescriptor[] {
  const merged = new Map<string, ModelDescriptor>();
  const sourceByKey = new Map<string, { cli: boolean; sdk: boolean }>();
  const keyFor = (descriptor: ModelDescriptor): string => descriptor.providerModelId.trim().toLowerCase();
  const add = (descriptor: ModelDescriptor, source: "cli" | "sdk"): void => {
    const key = keyFor(descriptor);
    if (!key) return;
    const previous = merged.get(key);
    const sourceFlags = sourceByKey.get(key) ?? { cli: false, sdk: false };
    sourceFlags[source] = true;
    sourceByKey.set(key, sourceFlags);

    if (!previous) {
      merged.set(key, descriptor);
      return;
    }

    const aliases = [...new Set([...(previous.aliases ?? []), ...(descriptor.aliases ?? [])])];
    const reasoningTiers = [...new Set([...(previous.reasoningTiers ?? []), ...(descriptor.reasoningTiers ?? [])])];
    const serviceTiers = [...new Set([...(previous.serviceTiers ?? []), ...(descriptor.serviceTiers ?? [])])];
    const prefer = source === "sdk" ? descriptor : previous;
    merged.set(key, {
      ...previous,
      ...prefer,
      id: previous.id,
      shortId: previous.shortId,
      providerModelId: previous.providerModelId,
      displayName: prefer.displayName || previous.displayName,
      color: prefer.color || previous.color,
      ...(aliases.length ? { aliases } : {}),
      ...(reasoningTiers.length ? { reasoningTiers } : {}),
      ...(serviceTiers.length ? { serviceTiers } : {}),
    });
  };

  for (const descriptor of args.cliDescriptors ?? []) add(descriptor, "cli");
  for (const descriptor of args.sdkDescriptors ?? []) add(descriptor, "sdk");

  return sortCursorCliDescriptorsForPicker(
    [...merged.entries()].map(([key, descriptor]) => ({
      ...descriptor,
      cursorAvailability: sourceByKey.get(key) ?? { cli: false, sdk: false },
    })),
  );
}

export function resolveCursorSdkModelSelectionParams(args: {
  modelSdkId: string;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
}): CursorModelParameterValue[] | undefined {
  const modelSdkId = args.modelSdkId.trim();
  if (!modelSdkId || !sdkCached?.models.length) return undefined;
  const normalizedModelSdkId = modelSdkId.toLowerCase();
  const row = sdkCached.models.find((entry) =>
    entry.id.trim().toLowerCase() === normalizedModelSdkId
    || (entry.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalizedModelSdkId),
  );
  if (!row) return undefined;
  const reasoning = normalizeCursorMetadataText(args.reasoningEffort);
  const wantsFast = args.fastMode === true;
  const out = new Map<string, string>();
  const applyParams = (params: readonly CursorModelParameterValue[]): void => {
    for (const param of params) {
      if (param.id.trim() && param.value.trim()) out.set(param.id.trim(), param.value.trim());
    }
  };

  const reasoningParameterIds = new Set(
    (row.parameters ?? []).filter(isReasoningParameterLike).map((entry) => entry.id),
  );
  const serviceTierParameterIds = new Set(
    (row.parameters ?? []).filter(isServiceTierParameterLike).map((entry) => entry.id),
  );

  if (reasoning) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      return variant.params.some((param) =>
        reasoningParameterIds.has(param.id)
        && normalizeCursorMetadataText(param.value) === reasoning,
      ) || label.includes(reasoning);
    });
    if (matchingVariant) applyParams(matchingVariant.params);
    for (const parameter of row.parameters ?? []) {
      if (!reasoningParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorMetadataText(entry.value) === reasoning
        || normalizeCursorMetadataText(entry.displayName) === reasoning,
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsFast) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      return variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "fast",
      ) || label.includes("fast");
    });
    if (matchingVariant) applyParams(matchingVariant.params);
    for (const parameter of row.parameters ?? []) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorServiceTierValue(entry.value) === "fast"
        || normalizeCursorServiceTierValue(entry.displayName) === "fast",
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  const params = [...out.entries()].map(([id, value]) => ({ id, value }));
  return params.length ? params : undefined;
}

/**
 * Best-effort: run `agent models` (and JSON variants) and parse stdout.
 */
export async function listCursorModelsFromCli(agentPath: string): Promise<CursorCliModelRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS && cached.models.length) {
    return cached.models;
  }

  const probes: string[][] = [
    ["models", "--json"],
    ["models", "-json"],
    ["models"],
    ["--list-models"],
  ];

  for (const args of probes) {
    try {
      const result = await spawnAsync(agentPath, args, { timeout: 12_000 });
      if (result.status !== 0) continue;
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          const models: CursorCliModelRow[] = [];
          for (const row of parsed) {
            if (typeof row === "string" && row.trim()) {
              models.push({ id: row.trim() });
              continue;
            }
            if (row && typeof row === "object") {
              const r = row as Record<string, unknown>;
              const trimmedId = typeof r.id === "string" ? r.id.trim() : "";
              const trimmedModel = typeof r.model === "string" ? r.model.trim() : "";
              const id = trimmedId || trimmedModel;
              const displayName = (typeof r.name === "string" ? r.name : undefined)
                ?? (typeof r.displayName === "string" ? r.displayName : undefined);
              const aliases = normalizeCursorAliasList(r.aliases, id);
              if (id) {
                models.push({
                  id,
                  displayName,
                  ...(aliases ? { aliases } : {}),
                });
              }
            }
          }
          if (models.length) {
            cached = { at: now, models };
            return models;
          }
        }
      } catch {
        // not JSON
      }

      const parsedLines = parseCursorCliModelsStdout(stdout);
      if (parsedLines.length) {
        cached = { at: now, models: parsedLines };
        return parsedLines;
      }
    } catch {
      // try next probe
    }
  }

  return [];
}

/**
 * Legacy Cursor CLI model discovery kept for older tests and migrations.
 */
export async function discoverCursorCliModelDescriptors(
  agentPath: string,
  options?: { mode?: CursorCliModelDiscoveryMode },
): Promise<ModelDescriptor[]> {
  const rows = options?.mode === "cached-or-fallback" || options?.mode === "cached-only"
    ? getCachedCursorModels() ?? []
    : await listCursorModelsFromCli(agentPath);
  return cursorRowsToDescriptors(rows);
}

export async function discoverCursorSdkModelDescriptors(
  apiKey?: string | null,
  options?: { mode?: CursorCliModelDiscoveryMode; timeoutMs?: number },
): Promise<ModelDescriptor[]> {
  const result = options?.mode === "probe"
    ? await probeCursorSdkModelDiscovery(apiKey, { timeoutMs: options?.timeoutMs })
    : null;
  const rows = result?.rows ?? getCachedCursorSdkModels(apiKey) ?? [];
  if (!rows.length && options?.mode === "cached-or-fallback") {
    warmCursorModelsFromSdk(apiKey);
  }
  return cursorRowsToDescriptors(rows);
}
