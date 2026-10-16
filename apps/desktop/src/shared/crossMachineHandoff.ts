import type {
  AgentChatAcceptCrossMachineHandoffResult,
  AgentChatCrossMachineContinuation,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineHandoffCheckpoint,
  AgentChatCrossMachineHandoffRecord,
  AgentChatSession,
  AgentChatCrossMachineTargetConfig,
  RemoteRuntimeHandoffStoragePreflightResult,
} from "./types";

/**
 * Every move field that sets what the destination chat may do. An agent's move
 * never chooses them: the orchestrator drops what it passed and sets them from
 * the source chat's own level, so an agent cannot widen its access by moving.
 */
export const CROSS_MACHINE_PERMISSION_FIELDS = [
  "permissionMode",
  "claudePermissionMode",
  "codexApprovalPolicy",
  "codexSandbox",
  "codexConfigSource",
  "opencodePermissionMode",
  "droidPermissionMode",
  "acpPermissionMode",
  "cursorModeId",
  "cursorConfigValues",
] as const satisfies ReadonlyArray<keyof AgentChatCrossMachineTargetConfig>;

/** `args` without any permission field (see `CROSS_MACHINE_PERMISSION_FIELDS`). */
export function withoutCrossMachinePermissionFields<T extends Record<string, unknown>>(args: T): T {
  const next: Record<string, unknown> = { ...args };
  for (const field of CROSS_MACHINE_PERMISSION_FIELDS) delete next[field];
  return next as T;
}

/** A move that is still asking, waiting or in flight. */
export function isCrossMachineHandoffActive(
  record: AgentChatCrossMachineHandoffRecord | null | undefined,
): boolean {
  return record?.state === "awaiting_approval" || record?.state === "pending" || record?.state === "sending";
}

/**
 * The durable steps of a move in order, with the words every surface shows.
 * One list so desktop and iOS cannot drift (iOS mirrors it).
 */
export const CROSS_MACHINE_HANDOFF_STEPS: ReadonlyArray<{
  id: AgentChatCrossMachineHandoffCheckpoint;
  label: string;
}> = [
  { id: "prepared", label: "Packed" },
  { id: "destination_ready", label: "Ready there" },
  { id: "accepted", label: "Accepted" },
  { id: "marked", label: "Done" },
];

/**
 * Which of two records about the same chat to keep. Records arrive from a
 * live event, an action's answer and a summary refresh in any order; a late
 * older one must not replace a newer one. A different move (another
 * handoffId) wins when it was requested later; the same move by `updatedAt`.
 */
export function pickNewerCrossMachineHandoffRecord(
  current: AgentChatCrossMachineHandoffRecord | null | undefined,
  incoming: AgentChatCrossMachineHandoffRecord | null | undefined,
): AgentChatCrossMachineHandoffRecord | null {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  // A missing or unparseable timestamp falls back to the record's other one.
  const time = (value: string, fallback: string) => {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const other = Date.parse(fallback);
    return Number.isFinite(other) ? other : 0;
  };
  if (current.handoffId !== incoming.handoffId) {
    return time(incoming.requestedAt, incoming.updatedAt) >= time(current.requestedAt, current.updatedAt) ? incoming : current;
  }
  return time(incoming.updatedAt, incoming.requestedAt) >= time(current.updatedAt, current.requestedAt) ? incoming : current;
}

/**
 * Where a source chat continues, if anywhere. Records written before
 * `continuedOn` existed fall back to a `continued` record's own target.
 */
export function crossMachineContinuation(
  record: AgentChatCrossMachineHandoffRecord | null | undefined,
): AgentChatCrossMachineContinuation | null {
  if (!record) return null;
  if (record.continuedOn) return record.continuedOn;
  if (record.state !== "continued" || !record.targetLaneId || !record.targetSessionId) return null;
  return {
    handoffId: record.handoffId,
    targetMachineKey: record.targetMachineKey,
    targetMachineName: record.targetMachineName,
    targetLaneId: record.targetLaneId,
    targetSessionId: record.targetSessionId,
    continuedAt: record.updatedAt,
  };
}

/**
 * New messages in the source chat go to the destination: it continued there,
 * no move is under way, and the person hasn't chosen to work here instead.
 */
export function crossMachineSendsElsewhere(
  record: AgentChatCrossMachineHandoffRecord | null | undefined,
): AgentChatCrossMachineContinuation | null {
  if (!record || record.resumedHere || isCrossMachineHandoffActive(record)) return null;
  return crossMachineContinuation(record);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from the response.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function normalizeGitRemoteIdentity(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (!trimmed.includes("://")) {
    const withoutSuffix = trimmed.replace(/[?#].*$/, "").replace(/\.git$/i, "");
    const scpLike = /^(?:[^@/:]+@)?([^:]+):(.+)$/.exec(withoutSuffix);
    if (scpLike?.[1] && scpLike[2]) {
      return `${scpLike[1].toLowerCase()}/${scpLike[2].replace(/^\/+/, "")}`.toLowerCase();
    }
    return withoutSuffix.toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\.git$/i, "").toLowerCase();
  }
}

export function sanitizePortableGitRemote(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    // HTTP usernames are frequently tokens or other secret-bearing clone
    // credentials. SSH usernames (most commonly `git`) identify the transport
    // account and must survive so the destination can use its own SSH config.
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
    }
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // A normal SCP-style remote may contain an SSH username. Query strings and
    // fragments are not meaningful there and can carry accidental credentials.
    return trimmed.replace(/[?#].*$/, "");
  }
}

export function decodeRemoteRuntimeHandoffStoragePreflightResult(
  value: unknown,
): RemoteRuntimeHandoffStoragePreflightResult {
  const record = requireRecord(value, "Destination storage preflight");
  return {
    parentDir: requireString(record.parentDir, "Destination parent folder"),
    targetPath: requireString(record.targetPath, "Destination repository path"),
    freeBytes: requireFiniteNumber(record.freeBytes, "Destination free space"),
    requiredBytes: requireFiniteNumber(record.requiredBytes, "Destination required space"),
    hasEnoughSpace: requireBoolean(record.hasEnoughSpace, "Destination space status"),
    targetExists: requireBoolean(record.targetExists, "Destination path status"),
    blockingErrors: requireStringList(record.blockingErrors, "Destination storage errors"),
    warnings: requireStringList(record.warnings, "Destination storage warnings"),
  };
}

export function decodeCrossMachineDestinationPreflightResult(
  value: unknown,
): AgentChatCrossMachineDestinationPreflightResult {
  const record = requireRecord(value, "Destination handoff preflight");
  // Older ADE destinations omit forkHandoffSupport; callers must treat the
  // absent field as fork-unsupported, so decode it only when present.
  let forkHandoffSupport: AgentChatCrossMachineDestinationPreflightResult["forkHandoffSupport"];
  if (record.forkHandoffSupport != null) {
    const support = requireRecord(record.forkHandoffSupport, "Destination fork handoff support");
    forkHandoffSupport = {
      supported: requireBoolean(support.supported, "Destination fork handoff supported flag"),
      ...(typeof support.reason === "string" && support.reason.trim().length
        ? { reason: support.reason }
        : {}),
    };
  }
  // Also absent on older destinations, and absent whenever a fast-forward would
  // not be safe there. Its presence is the destination's own assertion that the
  // lane is clean and a strict ancestor — the source never infers it.
  let laneFastForward: AgentChatCrossMachineDestinationPreflightResult["laneFastForward"];
  if (record.laneFastForward != null) {
    const candidate = requireRecord(record.laneFastForward, "Destination lane fast-forward");
    laneFastForward = {
      laneId: requireString(candidate.laneId, "Destination fast-forward lane identifier"),
      laneName: requireString(candidate.laneName, "Destination fast-forward lane name"),
      behindBy: requirePositiveInteger(candidate.behindBy, "Destination fast-forward distance"),
    };
  }
  return {
    providerAuthorized: requireBoolean(record.providerAuthorized, "Destination provider authorization"),
    modelAvailable: requireBoolean(record.modelAvailable, "Destination model availability"),
    remoteBranchHeadSha: optionalString(record.remoteBranchHeadSha, "Destination branch commit"),
    existingLaneId: optionalString(record.existingLaneId, "Destination lane identifier"),
    blockingErrors: requireStringList(record.blockingErrors, "Destination handoff errors"),
    warnings: requireStringList(record.warnings, "Destination handoff warnings"),
    ...(forkHandoffSupport ? { forkHandoffSupport } : {}),
    ...(laneFastForward ? { laneFastForward } : {}),
    // Absent on older destinations; only an explicit true means support.
    ...(record.gitBundleSupport === true ? { gitBundleSupport: true } : {}),
  };
}

// A zero-distance fast-forward is not a thing the destination can honor — it
// refuses "already at the expected source commit" — so reject it at the door
// rather than rendering an offer that cannot succeed.
function requirePositiveInteger(value: unknown, label: string): number {
  // isSafeInteger, not isInteger: Number.isInteger(1e30) is true, and a value
  // past 2^53 has already lost precision by the time it gets here.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function decodeAcceptCrossMachineHandoffResult(
  value: unknown,
): AgentChatAcceptCrossMachineHandoffResult {
  const record = requireRecord(value, "Destination handoff");
  const sessionRecord = requireRecord(record.session, "Destination chat");
  requireString(sessionRecord.id, "Destination chat identifier");
  requireString(sessionRecord.laneId, "Destination chat lane");
  requireString(sessionRecord.provider, "Destination chat provider");
  requireString(sessionRecord.model, "Destination chat model");
  return {
    handoffId: requireString(record.handoffId, "Handoff identifier"),
    laneId: requireString(record.laneId, "Destination lane identifier"),
    session: sessionRecord as unknown as AgentChatSession,
    reusedLane: requireBoolean(record.reusedLane, "Destination lane reuse status"),
    reusedSession: requireBoolean(record.reusedSession, "Destination chat reuse status"),
  };
}
