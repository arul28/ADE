import type {
  SyncAccountDirectoryLegDurations,
  SyncAccountDirectoryState,
} from "./types/sync";

/**
 * Monotonically bumpable compatibility level for the local ADE runtime RPC.
 *
 * A runtime is compatible with this desktop when the desktop's level falls
 * inside the inclusive range advertised by the runtime.
 */
export const RUNTIME_COMPAT_LEVEL = 1;

export type RuntimePublishHealth = {
  state: SyncAccountDirectoryState;
  failingSinceMs: number | null;
  lastLegDurations: SyncAccountDirectoryLegDurations;
  lastSuccessAt: number | null;
  skipReason: string | null;
};

export type RuntimeLastWedge = {
  lastCommand: string;
  blockedMs: number;
  ts: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseRuntimePublishHealth(raw: unknown): RuntimePublishHealth | null {
  if (!isRecord(raw) || !isRecord(raw.lastLegDurations)) return null;
  const state = asTrimmedString(raw.state);
  if (!state) return null;
  return {
    state: raw.state as SyncAccountDirectoryState,
    failingSinceMs:
      typeof raw.failingSinceMs === "number" && Number.isFinite(raw.failingSinceMs)
        ? Math.max(0, raw.failingSinceMs)
        : null,
    lastLegDurations: {
      snapshot: finiteDuration(raw.lastLegDurations.snapshot),
      token: finiteDuration(raw.lastLegDurations.token),
      http: finiteDuration(raw.lastLegDurations.http),
    },
    lastSuccessAt:
      typeof raw.lastSuccessAt === "number" && Number.isFinite(raw.lastSuccessAt)
        ? Math.max(0, raw.lastSuccessAt)
        : null,
    skipReason: asTrimmedString(raw.skipReason),
  };
}

export function parseRuntimeLastWedge(raw: unknown): RuntimeLastWedge | null {
  if (!isRecord(raw)) return null;
  const lastCommand = asTrimmedString(raw.lastCommand);
  const ts = asTrimmedString(raw.ts);
  if (
    !lastCommand
    || typeof raw.blockedMs !== "number"
    || !Number.isFinite(raw.blockedMs)
    || !ts
  ) {
    return null;
  }
  return {
    lastCommand,
    blockedMs: Math.max(0, Math.floor(raw.blockedMs)),
    ts,
  };
}

export function isRuntimeProtocolCompatible(runtimeInfo: {
  minCompatibleProtocol: number | null;
  protocolVersion: number | null;
}): boolean {
  const { minCompatibleProtocol, protocolVersion } = runtimeInfo;
  return minCompatibleProtocol != null
    && protocolVersion != null
    && minCompatibleProtocol > 0
    && protocolVersion >= minCompatibleProtocol
    && minCompatibleProtocol <= RUNTIME_COMPAT_LEVEL
    && RUNTIME_COMPAT_LEVEL <= protocolVersion;
}
