import type {
  AgentChatAcceptCrossMachineHandoffResult,
  AgentChatCrossMachineContinuation,
  AgentChatCrossMachineDestinationPreflightArgs,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineHandoffCheckpoint,
  AgentChatCrossMachineHandoffRecord,
  AgentChatCrossMachineLaneImportArgs,
  AgentChatCrossMachineLaneImportResult,
  AgentChatCrossMachineLaneSetupStatus,
  AgentChatCrossMachineMoveRelation,
  AgentChatProvider,
  AgentChatSession,
  AgentChatCrossMachineTargetConfig,
  RemoteRuntimeHandoffStoragePreflightResult,
} from "./types";

/**
 * The code a destination's definitive return refusal carries (it never
 * committed the return). The source then moves the chat as a new chat there.
 */
export const CROSS_MACHINE_RETURN_REFUSED_CODE = "cross_machine_return_refused";

/** A move's continuation instruction when the person gave none (the destination then adds nothing of its own). */
export const CROSS_MACHINE_HANDOFF_DEFAULT_PROMPT =
  "This chat was handed off from another ADE machine. Continue the same task from the handoff brief, verify the destination workspace state, and keep working from the next open action.";

/** Resolve whether target is the caller's chat or one of its descendants. */
export function crossMachineMoveRelation(
  callerSessionId: string | null | undefined,
  targetSessionId: string | null | undefined,
  parentSessionIdFor: (sessionId: string) => string | null | undefined,
): AgentChatCrossMachineMoveRelation {
  if (!callerSessionId || !targetSessionId) return "other";
  if (callerSessionId === targetSessionId) return "self";
  const visited = new Set<string>();
  let currentSessionId: string | null = targetSessionId;
  for (let depth = 0; depth < 32 && currentSessionId; depth += 1) {
    if (visited.has(currentSessionId)) return "other";
    visited.add(currentSessionId);
    const parentSessionId: string | null = parentSessionIdFor(currentSessionId)?.trim() || null;
    if (!parentSessionId) return "other";
    if (parentSessionId === callerSessionId) return "descendant";
    currentSessionId = parentSessionId;
  }
  return "other";
}

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

/**
 * Every public target field a move start may carry, as a record so the type
 * checker names any field added to `AgentChatCrossMachineTargetConfig` later.
 */
const CROSS_MACHINE_TARGET_CONFIG_FIELDS: Record<keyof AgentChatCrossMachineTargetConfig, true> = {
  targetModelId: true,
  reasoningEffort: true,
  fastMode: true,
  fastTier: true,
  codexDaybreak: true,
  claudePermissionMode: true,
  codexApprovalPolicy: true,
  codexSandbox: true,
  codexConfigSource: true,
  opencodePermissionMode: true,
  droidPermissionMode: true,
  copilotPermissionMode: true,
  copilotContextTier: true,
  copilotAutoTier: true,
  musePermissionMode: true,
  permissionMode: true,
  cursorModeId: true,
  cursorConfigValues: true,
  acpPermissionMode: true,
  acpConfigSnapshot: true,
};

/**
 * Only the target config fields of `args`. A move persists what it will ask
 * the destination for; internal batch context (lane, parent link, approval)
 * never comes from a caller's arguments.
 */
export function pickCrossMachineTargetConfig(
  args: Partial<AgentChatCrossMachineTargetConfig> & Record<string, unknown>,
): Partial<AgentChatCrossMachineTargetConfig> {
  const next: Record<string, unknown> = {};
  for (const field of Object.keys(CROSS_MACHINE_TARGET_CONFIG_FIELDS)) {
    if (args[field] !== undefined) next[field] = args[field];
  }
  return next as Partial<AgentChatCrossMachineTargetConfig>;
}

/** `args` without any permission field (see `CROSS_MACHINE_PERMISSION_FIELDS`). */
export function withoutCrossMachinePermissionFields<T extends Record<string, unknown>>(args: T): T {
  const next: Record<string, unknown> = { ...args };
  for (const field of CROSS_MACHINE_PERMISSION_FIELDS) delete next[field];
  return next as T;
}

/**
 * Move fields no caller supplies. Who asked, and for which chat, is stamped by
 * the trusted host after this strip (a window is the person; the RPC server
 * derives an agent's identity and relation; an automation is an agent of an
 * unrelated chat). Batch and approval context is the orchestrator's own: it
 * builds it, and no caller, person or agent, may hand it in.
 */
export const CROSS_MACHINE_CALLER_FIELDS = [
  // Caller identity and relation, stamped by the host.
  "requestedBy",
  "requestedFor",
  "requestingSessionId",
  "requestedBySessionId",
  "requestedByTitle",
  // Batch and approval context, built by the orchestrator.
  "batchMove",
  "parentLink",
  "sourceLane",
  "approvedByPerson",
  "handoffId",
  "sourceChatTitle",
] as const;

/** `args` without any caller-stamped or orchestrator-owned field (see `CROSS_MACHINE_CALLER_FIELDS`). */
export function withoutCrossMachineCallerFields<T extends Record<string, unknown>>(
  args: T,
): Omit<T, (typeof CROSS_MACHINE_CALLER_FIELDS)[number]> {
  const next: Record<string, unknown> = { ...args };
  for (const field of CROSS_MACHINE_CALLER_FIELDS) delete next[field];
  return next as Omit<T, (typeof CROSS_MACHINE_CALLER_FIELDS)[number]>;
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
  if (record.state === "returned") return null;
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

/** The fields of a registered project that say which checkout is the one in use. */
export type RegisteredCheckoutRank = {
  lastOpenedAt?: number | null;
  /** "system" is a folder something ran ADE in, not one the person opened. */
  catalogVisibility?: "recent" | "system" | null;
  /**
   * Set by `projects.list`: false when the project's folder is not on that
   * machine (deleted, or on a drive that isn't mounted). Older brains leave it
   * out, which counts as present.
   */
  exists?: boolean;
};

/**
 * Picks the checkout of one repository to route to on another machine. A
 * machine often registers a repository several times (a moved checkout, release
 * copies in a temp folder, another tool's worktrees), and every caller that
 * routes by repository must land on the same one: a folder that is there beats
 * one that is gone, a project the person opened beats one ADE registered on its
 * own, then the most recently opened wins, then registry order. A folder that is
 * gone still wins when nothing else matches, so the caller hears why it can't
 * be opened (an unplugged drive) instead of "not found".
 *
 * `candidates` are the records that already match the repository.
 */
export function pickLiveCheckout<T extends RegisteredCheckoutRank>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (!best || checkoutOutranks(candidate, best)) best = candidate;
  }
  return best;
}

function checkoutOutranks(candidate: RegisteredCheckoutRank, current: RegisteredCheckoutRank): boolean {
  const candidatePresent = candidate.exists !== false;
  if (candidatePresent !== (current.exists !== false)) return candidatePresent;
  const candidateOpened = candidate.catalogVisibility !== "system";
  if (candidateOpened !== (current.catalogVisibility !== "system")) return candidateOpened;
  return (candidate.lastOpenedAt ?? 0) > (current.lastOpenedAt ?? 0);
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
    ...(record.batchMoveSupport === 1 ? { batchMoveSupport: 1 } : {}),
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
    ...(Array.isArray(record.warnings)
      ? { warnings: requireStringList(record.warnings, "Destination handoff warnings") }
      : {}),
    // Absent on older destinations, which never recreate scheduled work: the
    // source then keeps every job it has.
    ...(Array.isArray(record.scheduledWorkIds)
      ? { scheduledWorkIds: requireStringList(record.scheduledWorkIds, "Destination scheduled work ids") }
      : {}),
  };
}

const LANE_SETUP_STATUSES: ReadonlySet<string> = new Set<AgentChatCrossMachineLaneSetupStatus>([
  "running",
  "completed",
  "failed",
  "not_configured",
  "not_needed",
]);

export function decodeCrossMachineLaneImportResult(value: unknown): AgentChatCrossMachineLaneImportResult {
  const record = requireRecord(value, "Destination lane import");
  const setupStatus = typeof record.setupStatus === "string" && LANE_SETUP_STATUSES.has(record.setupStatus)
    ? record.setupStatus as AgentChatCrossMachineLaneSetupStatus
    : null;
  return {
    importId: requireString(record.importId, "Destination lane import identifier"),
    laneId: requireString(record.laneId, "Destination lane identifier"),
    reusedLane: requireBoolean(record.reusedLane, "Destination lane reuse status"),
    carriedChanges: record.carriedChanges === true,
    snapshotSha: typeof record.snapshotSha === "string" && record.snapshotSha.trim() ? record.snapshotSha : null,
    warnings: requireStringList(record.warnings, "Destination lane import warnings"),
    ...(setupStatus ? { setupStatus } : {}),
  };
}

function isArgsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArgString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

/** Absent (undefined or null) stays absent; anything else must be a non-empty string. */
function optionalArgString(value: unknown, message: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

/**
 * A batch lane import as the destination receives it, from any transport (the
 * sync remote command, `run_ade_action`) and from the source's own outbox.
 * Deep checks of the git bundle stay with `validateHandoffGitBundle`.
 */
export function decodeCrossMachineLaneImportArgs(value: unknown): AgentChatCrossMachineLaneImportArgs {
  if (!isArgsRecord(value)) throw new Error("The batch lane import is malformed.");
  const sourceLane = value.sourceLane;
  if (!isArgsRecord(sourceLane) || typeof sourceLane.name !== "string" || !sourceLane.name.trim()) {
    throw new Error("The batch lane import is missing its source lane details.");
  }
  if (value.gitBundle != null && !isArgsRecord(value.gitBundle)) {
    throw new Error("The batch lane import has an invalid git bundle.");
  }
  const sourceMachineKey = optionalArgString(value.sourceMachineKey, "The batch lane import has an invalid source machine key.");
  const returnToLaneId = optionalArgString(value.returnToLaneId, "The batch lane return has an invalid origin lane id.");
  return {
    importId: requireArgString(value.importId, "The batch lane import is missing its import id."),
    sourceMachineName: requireArgString(value.sourceMachineName, "The batch lane import is missing its source machine name."),
    ...(sourceMachineKey ? { sourceMachineKey } : {}),
    sourceLane: {
      laneId: requireArgString(sourceLane.laneId, "The batch lane import is missing its source lane id."),
      parentLaneId: null,
      name: sourceLane.name,
    },
    ...(returnToLaneId ? { returnToLaneId } : {}),
    branchRef: requireArgString(value.branchRef, "The batch lane import is missing its branch."),
    headSha: requireArgString(value.headSha, "The batch lane import is missing its source commit."),
    originUrl: requireArgString(value.originUrl, "The batch lane import is missing its origin."),
    ...(value.gitBundle != null
      ? { gitBundle: value.gitBundle as unknown as NonNullable<AgentChatCrossMachineLaneImportArgs["gitBundle"]> }
      : {}),
  };
}

export function decodeCrossMachineDestinationPreflightArgs(value: unknown): AgentChatCrossMachineDestinationPreflightArgs {
  if (!isArgsRecord(value)) throw new Error("The destination preflight request is malformed.");
  const mode = value.mode == null ? undefined : typeof value.mode === "string" ? value.mode.trim() : value.mode;
  if (mode !== undefined && mode !== "brief" && mode !== "fork") {
    throw new Error("The destination preflight mode must be brief or fork.");
  }
  const sourceProvider = typeof value.sourceProvider === "string" ? value.sourceProvider.trim() : "";
  const batchLaneImportId = optionalArgString(value.batchLaneImportId, "The destination preflight has an invalid batch lane import id.");
  const returnToLaneId = optionalArgString(value.returnToLaneId, "The destination preflight has an invalid return lane id.");
  return {
    targetModelId: requireArgString(
      value.targetModelId,
      "The destination preflight requires targetModelId.",
    ) as AgentChatCrossMachineDestinationPreflightArgs["targetModelId"],
    sourceBranchRef: requireArgString(value.sourceBranchRef, "The destination preflight requires sourceBranchRef."),
    sourceHeadSha: requireArgString(value.sourceHeadSha, "The destination preflight requires sourceHeadSha."),
    ...(mode !== undefined ? { mode } : {}),
    ...(sourceProvider ? { sourceProvider: sourceProvider as AgentChatProvider } : {}),
    ...(value.hasGitBundle === true ? { hasGitBundle: true } : {}),
    ...(value.requireBatchMoveSupport === true ? { requireBatchMoveSupport: true } : {}),
    ...(batchLaneImportId ? { batchLaneImportId } : {}),
    ...(returnToLaneId ? { returnToLaneId } : {}),
  };
}
