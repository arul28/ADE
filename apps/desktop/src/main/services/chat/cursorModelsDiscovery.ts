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

export type CursorCliModelRow = { id: string; displayName?: string };
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

const MINIMAL_FALLBACK_SDK_ROWS: CursorCliModelRow[] = [
  { id: "auto", displayName: "Auto" },
  { id: "composer-2", displayName: "Composer 2" },
];

function fallbackCursorSdkRows(): CursorCliModelRow[] {
  return MINIMAL_FALLBACK_SDK_ROWS;
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
    rows.push(displayName ? { id, displayName } : { id });
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
    rows.push(displayName ? { id, displayName } : { id });
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

function getRecentCursorSdkFailure(apiKey?: string | null): typeof sdkLastFailure {
  const normalizedApiKey = apiKey?.trim() || undefined;
  const keyHash = hashKeyForCache(normalizedApiKey);
  if (!sdkLastFailure || sdkLastFailure.keyHash !== keyHash) return null;
  if (Date.now() - sdkLastFailure.at > TTL_MS) return null;
  return sdkLastFailure;
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
  const rows = await withTimeout((async () => {
    let sdkError: unknown = null;
    try {
      const { Cursor } = await import("@cursor/sdk");
      const sdkRows = normalizeSdkModelRows(await Cursor.models.list({ apiKey }));
      if (sdkRows.length) return sdkRows;
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
  if (rows.length && sdkLastFailure?.keyHash === keyHash) {
    sdkLastFailure = null;
  }
  recordCursorModelDiscoverySuccess(rows);
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
  options?: { timeoutMs?: number },
): Promise<CursorSdkModelDiscoveryResult> {
  const cachedRows = getCachedCursorSdkModels(apiKey);
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
  options?: { timeoutMs?: number },
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
    descriptors.push(createDynamicCursorCliModelDescriptor(id, row.displayName));
  }
  return sortCursorCliDescriptorsForPicker(descriptors);
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
              if (id) models.push({ id, displayName });
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
  const rows = options?.mode === "cached-or-fallback"
    ? getCachedCursorModels() ?? []
    : await listCursorModelsFromCli(agentPath);
  const useRows: CursorCliModelRow[] = rows.length ? rows : fallbackCursorSdkRows();
  return cursorRowsToDescriptors(useRows);
}

export async function discoverCursorSdkModelDescriptors(
  apiKey?: string | null,
  options?: { mode?: CursorCliModelDiscoveryMode; timeoutMs?: number },
): Promise<ModelDescriptor[]> {
  const result = options?.mode === "probe"
    ? await probeCursorSdkModelDiscovery(apiKey, { timeoutMs: options?.timeoutMs })
    : null;
  const rows = result?.rows ?? getCachedCursorSdkModels(apiKey) ?? [];
  const recentFailure = getRecentCursorSdkFailure(apiKey);
  const knownAuthFailure = result?.failureKind === "auth" || recentFailure?.kind === "auth";
  if (!rows.length && options?.mode !== "probe") {
    warmCursorModelsFromSdk(apiKey);
  }
  const useRows: CursorCliModelRow[] = rows.length
    ? rows
    : options?.mode === "cached-only" || knownAuthFailure
      ? []
      : fallbackCursorSdkRows();
  return cursorRowsToDescriptors(useRows);
}
