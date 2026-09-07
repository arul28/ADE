import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppControlDiagnostics,
  AppControlDomSnapshot,
  AppControlElementSnapshot,
  AppControlElementTargetArgs,
  AppControlFrame,
} from "../../../shared/types";
import {
  clampObservationInteger,
  formatObservationElementHandle,
  sanitizeObservationPathSegment,
} from "../../../shared/agentObservation";

/** Where observations live, relative to the session's project root. */
export const APP_CONTROL_OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "app-control-observations");

export const DEFAULT_OBSERVATION_KEEP_COUNT = 3;
export const MAX_OBSERVATION_KEEP_COUNT = 20;
export const DEFAULT_OBSERVATION_MAX_ELEMENTS = 80;
export const MAX_OBSERVATION_MAX_ELEMENTS = 200;
export const MAX_ELEMENT_MAP_ELEMENTS = 80;
export const MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS = 40;
export const MAX_APP_CONTROL_NETWORK_DIAGNOSTICS = 80;
export const MAX_APP_CONTROL_TRACE_ENTRIES = 80;
export const DEFAULT_APP_CONTROL_TRACE_LIMIT = 20;
export const MAX_APP_CONTROL_TRACE_LIMIT = 80;
export const DEFAULT_ACTION_OBSERVE_DELAY_MS = 150;
export const MAX_ACTION_OBSERVE_DELAY_MS = 5_000;
export const DEFAULT_APP_CONTROL_WAIT_TIMEOUT_MS = 5_000;
export const MAX_APP_CONTROL_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_APP_CONTROL_NETWORK_IDLE_MS = 500;
export const MAX_APP_CONTROL_NETWORK_IDLE_MS = 10_000;
export const APP_CONTROL_OBSERVATION_MAX_AGE_MS = 30 * 60_000;

export function normalizeObservationKeepCount(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_OBSERVATION_KEEP_COUNT,
    1,
    MAX_OBSERVATION_KEEP_COUNT,
  );
}

export function normalizeObservationMaxElements(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_OBSERVATION_MAX_ELEMENTS,
    1,
    MAX_OBSERVATION_MAX_ELEMENTS,
  );
}

export function normalizeActionObserveDelayMs(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_ACTION_OBSERVE_DELAY_MS,
    0,
    MAX_ACTION_OBSERVE_DELAY_MS,
  );
}

export function normalizeWaitTimeoutMs(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_APP_CONTROL_WAIT_TIMEOUT_MS,
    1,
    MAX_APP_CONTROL_WAIT_TIMEOUT_MS,
  );
}

export function normalizeNetworkIdleMs(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_APP_CONTROL_NETWORK_IDLE_MS,
    0,
    MAX_APP_CONTROL_NETWORK_IDLE_MS,
  );
}

export function normalizeTraceLimit(value: unknown): number {
  return clampObservationInteger(
    value,
    DEFAULT_APP_CONTROL_TRACE_LIMIT,
    1,
    MAX_APP_CONTROL_TRACE_LIMIT,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const raw = optionalFiniteNumber(value);
  if (raw == null) return null;
  const floored = Math.floor(raw);
  return floored > 0 ? floored : null;
}

export function normalizeFrame(value: unknown): AppControlFrame {
  const record = isRecord(value) ? value : {};
  return {
    x: finiteNumber(record.x),
    y: finiteNumber(record.y),
    width: Math.max(0, finiteNumber(record.width)),
    height: Math.max(0, finiteNumber(record.height)),
  };
}

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? Math.floor(entry) : null))
    .filter((entry): entry is number => entry != null && entry >= 0);
  return entries.length ? entries : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => stringOrNull(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? entries : undefined;
}

export function normalizeElementSnapshot(value: unknown): AppControlElementSnapshot | null {
  if (!isRecord(value)) return null;
  const frame = normalizeFrame(value.frame);
  const centerRecord = isRecord(value.center) ? value.center : {};
  const index = normalizePositiveInteger(value.index) ?? 0;
  const framePath = normalizeNumberArray(value.framePath);
  const shadowPath = normalizeStringArray(value.shadowPath);
  if (frame.width <= 0 || frame.height <= 0) return null;
  return {
    index,
    handle: stringOrNull(value.handle),
    ...(framePath ? { framePath } : {}),
    ...(shadowPath ? { shadowPath } : {}),
    tagName: stringOrNull(value.tagName),
    role: stringOrNull(value.role),
    label: stringOrNull(value.label),
    text: stringOrNull(value.text),
    value: stringOrNull(value.value),
    placeholder: stringOrNull(value.placeholder),
    selector: stringOrNull(value.selector),
    testId: stringOrNull(value.testId),
    href: stringOrNull(value.href),
    disabled: typeof value.disabled === "boolean" ? value.disabled : null,
    frame,
    center: {
      x: finiteNumber(centerRecord.x, frame.x + frame.width / 2),
      y: finiteNumber(centerRecord.y, frame.y + frame.height / 2),
    },
  };
}

export function normalizeDomSnapshot(value: unknown): AppControlDomSnapshot | null {
  if (!isRecord(value)) return null;
  const scrollRecord = isRecord(value.scroll) ? value.scroll : {};
  const elements = Array.isArray(value.elements)
    ? value.elements
        .map(normalizeElementSnapshot)
        .filter((entry): entry is AppControlElementSnapshot => Boolean(entry))
    : [];
  return {
    url: stringOrNull(value.url),
    title: stringOrNull(value.title),
    capturedAt: stringOrNull(value.capturedAt) ?? new Date().toISOString(),
    viewport: normalizeFrame(value.viewport),
    scroll: { x: finiteNumber(scrollRecord.x), y: finiteNumber(scrollRecord.y) },
    elementCount: normalizePositiveInteger(value.elementCount) ?? elements.length,
    elements,
  };
}

/** Stamp `obs-…:e:N` handles onto every element of a fresh DOM snapshot. */
export function applyObservationHandles(
  dom: AppControlDomSnapshot,
  observationId: string,
): AppControlDomSnapshot {
  return {
    ...dom,
    elements: dom.elements.map((element) => ({
      ...element,
      handle: formatObservationElementHandle(observationId, element.index),
    })),
  };
}

export function hasElementTarget(input: AppControlElementTargetArgs): boolean {
  return Boolean(
    stringOrNull(input.selector)
    || stringOrNull(input.text)
    || stringOrNull(input.testId)
    || normalizePositiveInteger(input.elementIndex) != null
    || stringOrNull(input.handle),
  );
}

export function elementLocatePayload(input: AppControlElementTargetArgs): Record<string, unknown> {
  const selector = stringOrNull(input.selector);
  const text = stringOrNull(input.text);
  const testId = stringOrNull(input.testId);
  const elementIndex = normalizePositiveInteger(input.elementIndex);
  return {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(testId ? { testId } : {}),
    ...(elementIndex == null ? {} : { elementIndex }),
  };
}

/** Trace target bag: bounded, redacts fill values down to a length. */
export function actionTargetForTrace(
  action: string,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const target: Record<string, unknown> = {};
  const copyString = (key: string): void => {
    const value = stringOrNull(input[key]);
    if (value) target[key] = value;
  };
  const copyNumber = (key: string): void => {
    const value = optionalFiniteNumber(input[key]);
    if (value != null) target[key] = value;
  };
  for (const key of ["selector", "testId", "handle", "button", "key", "url", "loadState", "targetId"]) {
    copyString(key);
  }
  for (const key of ["elementIndex", "x", "y", "deltaX", "deltaY", "clickCount", "timeoutMs", "networkIdleMs"]) {
    copyNumber(key);
  }
  if (typeof input.text === "string") {
    if (action === "type") {
      target.textLength = input.text.length;
    } else {
      target.text = input.text.slice(0, 300);
    }
  }
  if (action === "fill") {
    const fillValue = typeof input.value === "string"
      ? input.value
      : (typeof input.text === "string" ? input.text : null);
    if (fillValue != null) target.valueLength = fillValue.length;
  }
  return Object.keys(target).length ? target : null;
}

export function decodeObservationDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("App Control observation screenshot is not a base64 data URL.");
  return {
    mimeType: match[1] || "image/png",
    buffer: Buffer.from(match[2] ?? "", "base64"),
  };
}

/** Directory that holds one session's observations. */
export function observationDirectory(observationRootPath: string, sessionId: string): string {
  return path.join(observationRootPath, sanitizeObservationPathSegment(sessionId));
}

export async function pruneObservationDirectory(
  dir: string,
  keepCount: number,
): Promise<{ keepCount: number; keptCount: number; deletedCount: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { keepCount, keptCount: 0, deletedCount: 0 };
  }
  const observations = entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse();
  const stale = observations.slice(keepCount);
  let deletedCount = 0;
  for (const jsonName of stale) {
    const base = jsonName.slice(0, -".json".length);
    let deletedObservation = false;
    for (const filename of [`${base}.json`, `${base}.png`, `${base}.map.png`]) {
      try {
        await fs.rm(path.join(dir, filename), { force: true });
        deletedObservation = true;
      } catch {
        // best-effort cleanup
      }
    }
    if (deletedObservation) deletedCount += 1;
  }
  return {
    keepCount,
    keptCount: Math.min(observations.length, keepCount),
    deletedCount,
  };
}

/** Drop observation files from sessions that ended long ago. */
export async function pruneObservationCacheRoot(
  rootDir: string,
  maxAgeMs: number,
): Promise<void> {
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(rootDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const sessionDir of sessionDirs) {
    const dir = path.join(rootDir, sessionDir);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json") && !entry.endsWith(".png")) continue;
      const filePath = path.join(dir, entry);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs >= cutoff) continue;
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    const remaining = await fs.readdir(dir).catch(() => []);
    if (remaining.length === 0) await fs.rmdir(dir).catch(() => {});
  }
}

export function emptyDiagnostics(): AppControlDiagnostics {
  return {
    capturedAt: new Date().toISOString(),
    pendingRequestCount: 0,
    console: [],
    network: [],
  };
}
