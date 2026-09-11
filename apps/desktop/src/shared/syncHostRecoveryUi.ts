import type {
  SyncHostReadinessSnapshot,
  SyncHostReadinessState,
  SyncHostRecoveryResult,
} from "./types/syncHostRecovery";
import { SYNC_HOST_REDACTED_CONFLICT_DETAIL } from "./types/syncHostRecovery";

export const PROJECT_HOST_SILENT_RETRY_MS = [2_000, 4_000, 8_000] as const;

export type ProjectHostUiPhase = "ready" | "retrying" | "takeover" | "recovering";

/** Why a conflict offers no one-tap repair. `null` when repair is on offer. */
export type ProjectHostBlockedReason = "unauthorized" | "unidentified";

/**
 * The transport closing is a normal step of a repair that restarts the brain,
 * so these codes must never be read as "the repair failed".
 */
const PROJECT_HOST_TRANSPORT_DROP_CODES = new Set([
  "connection_lost_outcome_unknown",
  "not_connected",
  "disconnected",
  "restoration_missing",
  "timeout",
]);

export type HostUnavailableErrorShape = {
  code?: string;
  message?: string;
  reason?: "conflict" | "starting" | "unavailable";
  recoveryEligible?: boolean;
  snapshot?: unknown;
  conflict?: unknown;
};

export function isHostUnavailableCode(code: string | null | undefined): boolean {
  return (code ?? "").trim().toLowerCase() === "host_unavailable";
}

export function readHostUnavailableDetails(error: unknown): HostUnavailableErrorShape | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; details?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : record as Record<string, unknown>;
  const nestedCode = typeof details.code === "string" ? details.code : code;
  if (!isHostUnavailableCode(code) && !isHostUnavailableCode(nestedCode)) {
    const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
    if (!message.includes("host_unavailable") && !isHostUnavailableCode(nestedCode)) return null;
  }
  return {
    code: nestedCode || code || "host_unavailable",
    message: typeof details.message === "string"
      ? details.message
      : typeof record.message === "string" ? record.message : undefined,
    reason: details.reason === "conflict" || details.reason === "starting" || details.reason === "unavailable"
      ? details.reason
      : undefined,
    recoveryEligible: typeof details.recoveryEligible === "boolean" ? details.recoveryEligible : undefined,
    snapshot: details.snapshot,
    conflict: details.conflict,
  };
}

export function parseSyncHostReadinessSnapshot(raw: unknown): SyncHostReadinessSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const state = parseReadinessState(record.state);
  const headline = typeof record.headline === "string" ? record.headline.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!state || !headline || !body) return null;
  const conflict = parseSyncHostConflict(record.conflict);
  return {
    state,
    headline,
    body,
    conflict,
    recoveryEligible: record.recoveryEligible === true || conflict?.recoveryEligible === true,
  };
}

function parseReadinessState(raw: unknown): SyncHostReadinessState | null {
  if (raw === "ready" || raw === "starting" || raw === "conflict" || raw === "unavailable") {
    return raw;
  }
  return null;
}

export function parseSyncHostConflict(raw: unknown): SyncHostReadinessSnapshot["conflict"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const reason = record.reason === "lock" || record.reason === "listener" ? record.reason : null;
  const ownerKind = record.ownerKind === "installed"
    || record.ownerKind === "development"
    || record.ownerKind === "unknown"
    ? record.ownerKind
    : null;
  const ownerLabel = typeof record.ownerLabel === "string" ? record.ownerLabel.trim() : "";
  const technicalDetail = typeof record.technicalDetail === "string" ? record.technicalDetail : "";
  if (!reason || !ownerKind || !ownerLabel) return null;
  return {
    reason,
    ownerKind,
    ownerLabel,
    projectLabel: typeof record.projectLabel === "string" && record.projectLabel.trim()
      ? record.projectLabel.trim()
      : null,
    impact: typeof record.impact === "string" && record.impact.trim() ? record.impact.trim() : null,
    recoveryEligible: record.recoveryEligible === true,
    technicalDetail,
  };
}

export function parseSyncHostRecoveryResult(raw: unknown): SyncHostRecoveryResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const snapshot = parseSyncHostReadinessSnapshot(record.snapshot);
  if (!snapshot) return null;
  const status = record.status === "idle"
    || record.status === "running"
    || record.status === "succeeded"
    || record.status === "failed"
    || record.status === "restarting"
    ? record.status
    : "failed";
  return {
    operationId: typeof record.operationId === "string" ? record.operationId : "",
    ok: record.ok === true,
    status,
    snapshot,
    steps: Array.isArray(record.steps) ? record.steps as SyncHostRecoveryResult["steps"] : [],
    message: typeof record.message === "string" ? record.message : snapshot.body,
  };
}

export function projectHostShouldTakeOverImmediately(
  snapshot: SyncHostReadinessSnapshot | null,
): boolean {
  if (!snapshot) return false;
  return snapshot.state === "conflict" || snapshot.conflict != null;
}

export function projectHostBlockedReason(
  snapshot: SyncHostReadinessSnapshot | null,
): ProjectHostBlockedReason | null {
  const conflict = snapshot?.conflict;
  if (!conflict || snapshot?.recoveryEligible) return null;
  return conflict.technicalDetail.trim() === SYNC_HOST_REDACTED_CONFLICT_DETAIL
    ? "unauthorized"
    : "unidentified";
}

export function isProjectHostTransportDrop(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (PROJECT_HOST_TRANSPORT_DROP_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("connection lost")
    || message.includes("not connected")
    || message.includes("reconnecting")
    || message.includes("timed out");
}

export function nextProjectHostPhase(args: {
  current: ProjectHostUiPhase;
  snapshot: SyncHostReadinessSnapshot | null;
  retriesExhausted?: boolean;
}): ProjectHostUiPhase {
  const snapshot = args.snapshot;
  if (!snapshot || snapshot.state === "ready") return "ready";
  if (args.current === "recovering") return "recovering";
  if (projectHostShouldTakeOverImmediately(snapshot) || args.retriesExhausted) {
    return "takeover";
  }
  if (args.current === "takeover") return "takeover";
  return "retrying";
}
