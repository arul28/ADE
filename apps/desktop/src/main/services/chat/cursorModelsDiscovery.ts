import {
  type CursorModelAvailability,
  type CursorCliModelVariant,
  createDynamicCursorCliModelDescriptor,
  sortCursorCliDescriptorsForPicker,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";
import type { SDKModel } from "@cursor/sdk";
import { createHash } from "node:crypto";
import {
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "../ai/providerRuntimeHealth";
import { isCursorSdkResolutionError, loadCursorSdk } from "../ai/cursorSdkLoader";

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
  cliVariants?: CursorCliModelVariant[];
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
  "Cursor rejected the configured API key for agent/model access. Re-enter a Cursor API key from the Cursor dashboard API page.";

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

function addCursorRowAlias(row: CursorCliModelRow, alias: string | null | undefined): void {
  const normalizedAlias = normalizeCursorModelRef(alias);
  if (!normalizedAlias || !/^[\w.-]+$/i.test(normalizedAlias)) return;
  const canonical = normalizeCursorModelRef(row.id).toLowerCase();
  const aliasKey = normalizedAlias.toLowerCase();
  if (aliasKey === canonical) return;
  const aliases = row.aliases ?? [];
  if (!aliases.some((entry) => normalizeCursorModelRef(entry).toLowerCase() === aliasKey)) {
    row.aliases = [...aliases, normalizedAlias];
  }
}

function markCursorRowFast(row: CursorCliModelRow): void {
  const tiers = row.serviceTiers ?? [];
  if (!tiers.some((entry) => normalizeCursorMetadataText(entry) === "fast")) {
    row.serviceTiers = [...tiers, "fast"];
  }
}

function addCursorRowReasoningTier(row: CursorCliModelRow, reasoningEffort: string | null | undefined): void {
  const normalized = normalizeCursorReasoningValue(reasoningEffort);
  if (!normalized) return;
  const tiers = row.reasoningTiers ?? [];
  if (!tiers.some((entry) => normalizeCursorMetadataText(entry) === normalized)) {
    row.reasoningTiers = [...tiers, normalized];
  }
}

function addCursorCliVariant(row: CursorCliModelRow, variant: CursorCliModelVariant): void {
  const modelId = normalizeCursorModelRef(variant.modelId);
  if (!modelId) return;
  const variants = row.cliVariants ?? [];
  if (variants.some((entry) =>
    normalizeCursorModelRef(entry.modelId).toLowerCase() === modelId.toLowerCase()
    && normalizeCursorMetadataText(entry.reasoningEffort) === normalizeCursorMetadataText(variant.reasoningEffort)
    && (entry.fastMode === true) === (variant.fastMode === true)
  )) {
    return;
  }
  row.cliVariants = [...variants, { ...variant, modelId }];
}

type ParsedCursorCliVariant = {
  baseId: string;
  reasoningEffort?: string;
  fastMode: boolean;
};

const CURSOR_CLI_REASONING_SUFFIXES = [
  ["extra-high", "xhigh"],
  ["xhigh", "xhigh"],
  ["minimal", "minimal"],
  ["medium", "medium"],
  ["none", "none"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"],
] as const;

function parseCursorCliVariantId(id: string): ParsedCursorCliVariant | null {
  const trimmed = normalizeCursorModelRef(id);
  if (!trimmed) return null;
  let base = trimmed;
  let fastMode = false;
  if (base.toLowerCase().endsWith("-fast")) {
    base = base.slice(0, -"-fast".length);
    fastMode = true;
  }

  for (const [suffix, reasoningEffort] of CURSOR_CLI_REASONING_SUFFIXES) {
    const tail = `-${suffix}`;
    if (base.toLowerCase().endsWith(tail)) {
      return {
        baseId: base.slice(0, -tail.length),
        reasoningEffort,
        fastMode,
      };
    }
  }

  const thinkingMiddle = base.match(/^(.*)-(none|minimal|low|medium|high|xhigh|extra-high|max)-thinking$/i);
  if (thinkingMiddle) {
    const reasoningEffort = normalizeCursorReasoningValue(thinkingMiddle[2]);
    if (reasoningEffort) {
      return {
        baseId: `${thinkingMiddle[1]}-thinking`,
        reasoningEffort,
        fastMode,
      };
    }
  }

  return fastMode ? { baseId: base, fastMode } : null;
}

function stripCursorCliVariantDisplayTokens(
  displayName: string | undefined,
  parsed: ParsedCursorCliVariant,
): string | undefined {
  let label = displayName?.replace(/\s*\(default\)\s*$/i, "").trim();
  if (!label) return undefined;
  if (parsed.fastMode) {
    label = label.replace(/\s+Fast\b/i, "").trim();
  }
  const effort = parsed.reasoningEffort;
  if (effort) {
    const effortPattern = effort === "xhigh" ? "(?:Extra\\s+High|XHigh|X-High)" : effort;
    label = label
      .replace(new RegExp(`\\s+${effortPattern}\\s+Thinking\\b`, "i"), " Thinking")
      .replace(new RegExp(`\\s+Thinking\\s+${effortPattern}\\b`, "i"), " Thinking")
      .replace(new RegExp(`\\s+${effortPattern}\\b`, "i"), "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return label || displayName;
}

function cloneCursorModelRow(row: CursorCliModelRow): CursorCliModelRow {
  return {
    ...row,
    ...(row.aliases ? { aliases: [...row.aliases] } : {}),
    ...(row.parameters ? { parameters: row.parameters.map((parameter) => ({
      ...parameter,
      values: parameter.values.map((value) => ({ ...value })),
    })) } : {}),
    ...(row.variants ? { variants: row.variants.map((variant) => ({
      ...variant,
      params: variant.params.map((param) => ({ ...param })),
    })) } : {}),
    ...(row.cliVariants ? { cliVariants: row.cliVariants.map((variant) => ({ ...variant })) } : {}),
    ...(row.reasoningTiers ? { reasoningTiers: [...row.reasoningTiers] } : {}),
    ...(row.serviceTiers ? { serviceTiers: [...row.serviceTiers] } : {}),
  };
}

function foldCursorCliVariantRows(rows: CursorCliModelRow[]): CursorCliModelRow[] {
  if (!rows.length) return [];
  const cloned = rows.map(cloneCursorModelRow);
  const byId = new Map<string, CursorCliModelRow>();
  for (const row of cloned) {
    byId.set(normalizeCursorModelRef(row.id).toLowerCase(), row);
  }

  const foldedIds = new Set<string>();
  const syntheticByBase = new Map<string, CursorCliModelRow>();
  for (const row of cloned) {
    const id = normalizeCursorModelRef(row.id);
    const key = id.toLowerCase();
    const parsed = parseCursorCliVariantId(id);
    if (!parsed) {
      addCursorCliVariant(row, { modelId: id, fastMode: false });
      continue;
    }

    const baseKey = parsed.baseId.toLowerCase();
    let base = byId.get(baseKey) ?? syntheticByBase.get(baseKey);
    if (!base) {
      base = {
        id: parsed.baseId,
        displayName: stripCursorCliVariantDisplayTokens(row.displayName, parsed) ?? parsed.baseId,
      };
      syntheticByBase.set(baseKey, base);
    }

    if (parsed.fastMode) markCursorRowFast(base);
    addCursorRowReasoningTier(base, parsed.reasoningEffort);
    addCursorRowAlias(base, id);
    for (const alias of row.aliases ?? []) addCursorRowAlias(base, alias);
    addCursorCliVariant(base, {
      modelId: id,
      ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
      ...(parsed.fastMode ? { fastMode: true } : { fastMode: false }),
    });
    foldedIds.add(key);
  }

  const out = cloned.filter((row) => !foldedIds.has(normalizeCursorModelRef(row.id).toLowerCase()));
  for (const row of syntheticByBase.values()) {
    if (!byId.has(normalizeCursorModelRef(row.id).toLowerCase())) {
      out.push(row);
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
  if (normalized === "fast") return "fast";
  if ([
    "standard",
    "default",
    "regular",
    "base",
    "normal",
    "slow",
  ].includes(normalized)) {
    return "standard";
  }
  return null;
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
  } else if (discoveryError.kind === "unavailable") {
    reportProviderRuntimeFailure("cursor", discoveryError.message);
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

function normalizeCursorModelRows(models: unknown[], options?: { foldCliVariants?: boolean }): CursorCliModelRow[] {
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
    const description = typeof record.description === "string" && record.description.trim().length
      ? record.description.trim()
      : undefined;
    const parameters = normalizeCursorParameterDefinitions(record.parameters);
    const variants = normalizeCursorModelVariants(record.variants);
    const aliases = normalizeCursorAliasList(record.aliases, id);
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
  return options?.foldCliVariants ? foldCursorCliVariantRows(rows) : rows;
}

function getCachedCursorSdkModels(apiKey?: string | null): CursorCliModelRow[] | null {
  const now = Date.now();
  const normalizedApiKey = apiKey?.trim() || undefined;
  const keyHash = hashKeyForCache(normalizedApiKey);
  if (
    sdkLastFailure
    && sdkLastFailure.keyHash === keyHash
    && now - sdkLastFailure.at < TTL_MS
    && (sdkLastFailure.kind === "auth" || sdkLastFailure.kind === "unavailable")
  ) {
    return null;
  }
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
      const { Cursor } = await loadCursorSdk();
      const sdkRows = normalizeSdkModelRows(await Cursor.models.list({ apiKey }));
      if (sdkRows.length) {
        sdkSucceeded = true;
        return sdkRows;
      }
    } catch (error) {
      sdkError = error;
    }

    if (sdkError && isCursorSdkResolutionError(sdkError)) {
      throw toCursorModelDiscoveryError(sdkError);
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
    // Best-effort: model resolution reports failures to provider health and
    // returns no rows instead of letting discovery errors crash status refresh.
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

function normalizeCursorModelLookupRef(value: unknown): string {
  const raw = String(value ?? "").trim();
  const withoutPrefix = raw.toLowerCase().startsWith("cursor/")
    ? raw.slice("cursor/".length)
    : raw;
  return withoutPrefix.trim().toLowerCase();
}

function cursorRowMatchesRef(row: CursorCliModelRow, ref: string): boolean {
  if (!ref) return false;
  if (normalizeCursorModelLookupRef(row.id) === ref) return true;
  return (row.aliases ?? []).some((alias) => normalizeCursorModelLookupRef(alias) === ref);
}

export function resolveCachedCursorModelAvailability(
  modelRef: string | null | undefined,
  apiKey?: string | null,
): CursorModelAvailability | null {
  const ref = normalizeCursorModelLookupRef(modelRef);
  if (!ref) return null;
  const cli = (getCachedCursorModels() ?? []).some((row) => cursorRowMatchesRef(row, ref));
  const sdkRows = getCachedCursorSdkModels(apiKey);
  if (!sdkRows) return cli ? { cli: true, sdk: false } : null;
  const sdk = sdkRows.some((row) => cursorRowMatchesRef(row, ref));
  return cli || sdk ? { cli, sdk } : null;
}

function cursorRowsToDescriptors(rows: CursorCliModelRow[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    const normalizedId = id.toLowerCase();
    if (!id || seen.has(normalizedId)) continue;
    const aliases = normalizeCursorAliasList(row.aliases, id) ?? [];
    seen.add(normalizedId);
    for (const alias of aliases) seen.add(alias.toLowerCase());
    const descriptorOptions = {
      ...(row.reasoningTiers?.length ? { reasoningTiers: row.reasoningTiers } : {}),
      ...(row.serviceTiers?.length ? { serviceTiers: row.serviceTiers } : {}),
      ...(row.cliVariants?.length ? { cursorCliVariants: row.cliVariants } : {}),
    };
    descriptors.push(createDynamicCursorCliModelDescriptor(id, row.displayName, {
      ...descriptorOptions,
      ...(aliases.length ? { aliases } : {}),
    }));
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
  const refsFor = (descriptor: ModelDescriptor): string[] => {
    const refs = [descriptor.providerModelId, ...(descriptor.aliases ?? [])]
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return [...new Set(refs)];
  };
  const keyByRef = new Map<string, string>();
  const remapRefs = (fromKey: string, toKey: string): void => {
    if (fromKey === toKey) return;
    for (const [ref, key] of keyByRef.entries()) {
      if (key === fromKey) keyByRef.set(ref, toKey);
    }
  };
  const add = (descriptor: ModelDescriptor, source: "cli" | "sdk"): void => {
    const canonicalKey = keyFor(descriptor);
    if (!canonicalKey) return;
    const refs = refsFor(descriptor);
    let key = refs.map((ref) => keyByRef.get(ref)).find((existing): existing is string => Boolean(existing))
      ?? canonicalKey;

    // Prefer the SDK's canonical id when an SDK row matches a previous CLI
    // alias. Aliases stay searchable, but the picker shows one real model row.
    if (source === "sdk" && key !== canonicalKey) {
      const previous = merged.get(key);
      const previousFlags = sourceByKey.get(key);
      merged.delete(key);
      sourceByKey.delete(key);
      remapRefs(key, canonicalKey);
      key = canonicalKey;
      if (previous) merged.set(key, previous);
      if (previousFlags) sourceByKey.set(key, previousFlags);
    }

    const previous = merged.get(key);
    const sourceFlags = sourceByKey.get(key) ?? { cli: false, sdk: false };
    sourceFlags[source] = true;
    sourceByKey.set(key, sourceFlags);

    if (!previous) {
      merged.set(key, descriptor);
      for (const ref of refs) keyByRef.set(ref, key);
      return;
    }

    const aliases = [...new Set([...(previous.aliases ?? []), ...(descriptor.aliases ?? [])])];
    const reasoningTiers = [...new Set([...(previous.reasoningTiers ?? []), ...(descriptor.reasoningTiers ?? [])])];
    const serviceTiers = [...new Set([...(previous.serviceTiers ?? []), ...(descriptor.serviceTiers ?? [])])];
    const cursorCliVariants = [...(previous.cursorCliVariants ?? []), ...(descriptor.cursorCliVariants ?? [])]
      .filter((variant, index, all) => all.findIndex((candidate) =>
        candidate.modelId.trim().toLowerCase() === variant.modelId.trim().toLowerCase()
        && normalizeCursorMetadataText(candidate.reasoningEffort) === normalizeCursorMetadataText(variant.reasoningEffort)
        && (candidate.fastMode === true) === (variant.fastMode === true)
      ) === index);
    const preferred = source === "sdk" ? descriptor : previous;
    merged.set(key, {
      ...previous,
      ...preferred,
      id: preferred.id,
      shortId: preferred.shortId,
      providerModelId: preferred.providerModelId,
      displayName: preferred.displayName || previous.displayName,
      color: preferred.color || previous.color,
      ...(aliases.length ? { aliases } : {}),
      ...(reasoningTiers.length ? { reasoningTiers } : {}),
      ...(serviceTiers.length ? { serviceTiers } : {}),
      ...(cursorCliVariants.length ? { cursorCliVariants } : {}),
    });
    for (const ref of refs) keyByRef.set(ref, key);
    for (const ref of refsFor(previous)) keyByRef.set(ref, key);
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
  const wantsStandard = args.fastMode === false;
  const out = new Map<string, string>();
  const reasoningParameterIds = new Set(
    (row.parameters ?? []).filter(isReasoningParameterLike).map((entry) => entry.id),
  );
  const serviceTierParameterIds = new Set(
    (row.parameters ?? []).filter(isServiceTierParameterLike).map((entry) => entry.id),
  );
  const applyParams = (
    params: readonly CursorModelParameterValue[],
    options: { preserveExistingReasoning?: boolean } = {},
  ): void => {
    for (const param of params) {
      const id = param.id.trim();
      const value = param.value.trim();
      if (!id || !value) continue;
      if (options.preserveExistingReasoning && reasoningParameterIds.has(id) && out.has(id)) continue;
      out.set(id, value);
    }
  };

  if (reasoning) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      return variant.params.some((param) =>
        reasoningParameterIds.has(param.id)
        && normalizeCursorMetadataText(param.value) === reasoning,
      ) || label.includes(reasoning);
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
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
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters ?? []) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorServiceTierValue(entry.value) === "fast"
        || normalizeCursorServiceTierValue(entry.displayName) === "fast",
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsStandard) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      const hasFastParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "fast"
      );
      const hasStandardParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "standard"
      );
      return hasStandardParam || (!hasFastParam && /\b(standard|default|regular|base|normal|slow)\b/.test(label));
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters ?? []) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorServiceTierValue(entry.value) === "standard"
        || normalizeCursorServiceTierValue(entry.displayName) === "standard"
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
          const models = normalizeCursorModelRows(parsed, { foldCliVariants: true });
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
        const models = foldCursorCliVariantRows(parsedLines);
        cached = { at: now, models };
        return models;
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
