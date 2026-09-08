import path from "node:path";
import type {
  AppControlDiagnostics,
  AppControlObservationCleanup,
} from "../../../shared/types";
import {
  clampObservationInteger,
  sanitizeObservationPathSegment,
} from "../../../shared/agentObservation";
import {
  agentActionTargetForTrace,
  applyAgentObservationHandles,
  agentElementLocatePayload,
  agentHasElementTarget,
} from "../../../shared/agentObservationNormalizers";
import {
  pruneAgentObservationCacheRoot,
  pruneAgentObservationDirectory,
} from "../shared/agentObservationCache";

/**
 * App Control's observation bounds and cache layout. The value normalizers and
 * cache pruners it needs are shared with the built-in browser (both surfaces
 * evaluate the same in-page collector), so they are re-exported from
 * `shared/agentObservationNormalizers` and `shared/agentObservationCache`
 * rather than forked here.
 */

export {
  isRecord,
  stringOrNull,
  finiteNumber,
  optionalFiniteNumber,
  normalizePositiveInteger,
  normalizeAgentFrame as normalizeFrame,
  normalizeAgentElementSnapshot as normalizeElementSnapshot,
  normalizeAgentDomSnapshot as normalizeDomSnapshot,
} from "../../../shared/agentObservationNormalizers";

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

export const applyObservationHandles = applyAgentObservationHandles;

export const hasElementTarget = agentHasElementTarget;
export const elementLocatePayload = agentElementLocatePayload;

/**
 * Trace target bag: bounded, redacts typed secrets down to a length.
 *
 * `targetId` is App Control's only addition to the shared key set — a window
 * switch names the CDP target it moved to.
 */
export function actionTargetForTrace(
  action: string,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  return agentActionTargetForTrace(action, input, { stringKeys: ["targetId"] });
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

export function pruneObservationDirectory(
  dir: string,
  keepCount: number,
): Promise<AppControlObservationCleanup> {
  return pruneAgentObservationDirectory(dir, keepCount);
}

/** Drop observation files from sessions that ended long ago. */
export function pruneObservationCacheRoot(rootDir: string, maxAgeMs: number): Promise<void> {
  return pruneAgentObservationCacheRoot(rootDir, maxAgeMs);
}

export function emptyDiagnostics(): AppControlDiagnostics {
  return {
    capturedAt: new Date().toISOString(),
    pendingRequestCount: 0,
    console: [],
    network: [],
  };
}
