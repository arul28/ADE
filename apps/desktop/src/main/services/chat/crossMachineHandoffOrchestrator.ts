/**
 * Moves a Work chat to another machine on the account, from the SOURCE brain.
 *
 * Before this, the whole sequence lived in the desktop modal, so only a person
 * at that modal could move a chat, and closing the modal hid the move. Now
 * every entry point — the modal, the session menu's quick move, an agent's
 * `ade chat handoff --machine`, the phone — calls `start`, and every client
 * reads one durable record from the chat's summary.
 *
 * The record (`AgentChatCrossMachineHandoffRecord`) is persisted with the chat
 * before each step runs, so a brain restart resumes or fails the move rather
 * than forgetting it. The destination keeps its own idempotent transaction keyed
 * by `handoffId`, and the source keeps the exact capsule it sent in an outbox,
 * which together make resuming a `sending` move and retrying an `unknown` one
 * safe: the same capsule under the same id reconciles instead of duplicating.
 *
 * Rules that came from T3 Code's thread handoff and the ADE review of it:
 * - A busy chat moves only when asked to wait (`whenTurnEnds`), and then any
 *   newer message from the person cancels the move: new instructions win.
 * - An agent may move its own chat or a descendant it started; non-full-auto
 *   targets and all unrelated chats need the person's approval. An agent's
 *   move runs at the source chat's permission level, mapped to the target
 *   model's provider (never broader).
 * - Once destination acceptance starts, a lost answer is `unknown`, never
 *   `failed`, and it is never replayed automatically. An `unknown` move blocks
 *   new moves until it is retried or dismissed.
 * - A retry resends the stored capsule only while it still matches the chat.
 *   A stale `failed` move is prepared again under a new handoffId; a stale
 *   `unknown` one is refused, because the first capsule may already have landed.
 *   Only a real mismatch (`CrossMachineSourceStaleError`) is stale: when the
 *   check itself fails, a retry changes nothing and a restart parks the move
 *   as `unknown`, keeping its capsule.
 */
import { randomUUID } from "node:crypto";
import { deterministicChatSessionId } from "../../../shared/deterministicChatSessionId";
import {
  decodeAcceptCrossMachineHandoffResult,
  decodeCrossMachineDestinationPreflightResult,
  isCrossMachineHandoffActive,
  normalizeGitRemoteIdentity,
  withoutCrossMachinePermissionFields,
} from "../../../shared/crossMachineHandoff";
import { getModelById, resolveModelAlias, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import {
  isPermissionLevel,
  permissionFieldsForLevel,
  permissionLevelLabel,
  permissionLevelRank,
  resolvePermissionLevel,
  type PermissionLevel,
} from "../../../shared/permissionLadder";
import { isRemoteRuntimeConnectionError, isRuntimeTransportTimeoutError } from "../../../shared/runtimeErrors";
import type {
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineBatchMoveArgs,
  AgentChatCrossMachineBatchMoveItem,
  AgentChatCrossMachineBatchMoveRecord,
  AgentChatCrossMachineLaneImportArgs,
  AgentChatCrossMachineLaneImportResult,
  AgentChatCrossMachineHandoffBlocker,
  AgentChatCrossMachineHandoffCheckpoint,
  AgentChatCrossMachineHandoffMachineOption,
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatCrossMachineHandoffState,
  AgentChatCrossMachineTargetConfig,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatPreviewCrossMachineHandoffArgs,
  AgentChatPreviewCrossMachineHandoffResult,
  AgentChatStartCrossMachineBatchMoveArgs,
  AgentChatStartCrossMachineHandoffArgs,
  AgentChatCrossMachineBatchMoveItemState,
} from "../../../shared/types";

/** One machine on the account, as the brain's machine bridge lists it. */
export type CrossMachineHandoffMachine = {
  machineKey: string;
  name: string;
  online: boolean;
  isThisMachine: boolean;
  /** Projects there, when the bridge could list them. */
  projects?: Array<{ origin: string | null }>;
  note?: string | null;
};

/**
 * How the source brain reaches the destination. Backed by the brain's agent
 * machine bridge (`apps/ade-cli/src/services/account/agentMachineBridge.ts`);
 * null on a runtime that can't reach other machines (an embedded guest).
 */
export type CrossMachineHandoffTransport = {
  /** `includeProjects` asks each online machine for its projects (slower). */
  listMachines(options?: { includeProjects?: boolean }): Promise<CrossMachineHandoffMachine[]>;
  callAction(input: {
    machine: string;
    /** Selects the project on the destination by git origin. */
    originUrl: string;
    /** Set the repository up there first when it is missing (GitHub only). */
    clone?: boolean;
    action: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ machine: { machineKey: string; name: string }; result: unknown }>;
  /**
   * The request may have reached the destination but its answer was lost
   * (timeout, dropped connection). Errors raised before sending (offline,
   * this machine) and the destination's own refusals are not lost answers.
   */
  isLostAnswer?(error: unknown): boolean;
};

/** What the orchestrator persists per chat. `request` stays on the brain. */
export type CrossMachineHandoffPersisted = {
  record: AgentChatCrossMachineHandoffRecord;
  request: CrossMachineHandoffRequest;
};

export type CrossMachineHandoffRequest = AgentChatCrossMachineTargetConfig & {
  machine: string;
  mode: "brief" | "fork";
  continuationPrompt: string | null;
  includeChanges: boolean;
  clone: boolean;
  /** Waited for a turn or an approval, so the person may not be watching. */
  queued?: boolean;
  /** An agent's move: the source chat's level when the agent asked. */
  agentSourceLevel?: string | null;
  /** An agent's move the person approved (not one full-auto let through). */
  approvedByPerson?: boolean;
  batchMove?: CrossMachineBatchMoveContext;
  /** An agent may move chats it started without approval. */
  agentAuthorizedDescendant?: boolean;
};

type CrossMachineBatchMoveContext = NonNullable<AgentChatPrepareCrossMachineHandoffArgs["batchMove"]> & {
  destinationParentLaneId?: string;
  parentLink?: NonNullable<AgentChatPrepareCrossMachineHandoffArgs["parentLink"]>;
  sourceLane: NonNullable<AgentChatPrepareCrossMachineHandoffArgs["sourceLane"]>;
};

export type CrossMachineBatchChat = {
  sessionId: string;
  laneId: string;
  parentSessionId: string | null;
  spawnKind: "subagent" | "peer";
  isWorkChat: boolean;
  turnActive: boolean;
  awaitingInput: boolean;
  permissionLevel: string | null;
  provider: string;
  model: string;
  modelId?: string | null;
  title: string | null;
  /** Is the chat's parent included in the selected batch? */
  parentInBatch?: boolean;
};

export type CrossMachineBatchLane = {
  laneId: string;
  parentLaneId: string | null;
  name: string;
  branchRef: string;
};

type CrossMachineBatchMovePersisted = AgentChatCrossMachineBatchMoveRecord;

export type CrossMachineHandoffSource = {
  sessionId: string;
  isWorkChat: boolean;
  turnActive: boolean;
  awaitingInput: boolean;
  /** The unified level (permissionLadder.ts); `full-auto` lets an agent move the chat without asking. */
  permissionLevel: string | null;
  provider?: string | null;
  title: string | null;
};

export type CrossMachineSourceInspection = {
  /** Normalized identity (host/owner/repo), for matching machines' projects. */
  originUrl: string | null;
  /** `git remote get-url origin` as configured, for the capsule. */
  rawOriginUrl?: string | null;
  branchRef: string | null;
  headSha?: string | null;
  blockers: AgentChatCrossMachineHandoffBlocker[];
  changes: { unpushedCommits: number; changedFiles: number } | null;
};

/** The capsule a move sent, exactly, so a retry can send it again. */
export type CrossMachinePreparedCapsule = Pick<AgentChatPrepareCrossMachineHandoffResult, "capsule" | "capsuleFingerprint">;

export type CrossMachineHandoffOutbox = {
  read(handoffId: string): CrossMachinePreparedCapsule | null;
  /** Durable before it returns: written the moment acceptance is about to start. */
  write(handoffId: string, prepared: CrossMachinePreparedCapsule): void;
  remove(handoffId: string): void;
  readLane?(importId: string): AgentChatCrossMachineLaneImportArgs | null;
  writeLane?(importId: string, payload: AgentChatCrossMachineLaneImportArgs): void;
  removeLane?(importId: string): void;
};

export type CrossMachineHandoffOrchestratorDeps = {
  transport: () => CrossMachineHandoffTransport | null;
  getSource: (sessionId: string) => CrossMachineHandoffSource | null;
  readPersisted: (sessionId: string) => CrossMachineHandoffPersisted | null;
  /** Persist, then publish to live clients. Null clears it. */
  writePersisted: (sessionId: string, value: CrossMachineHandoffPersisted | null) => void;
  /** Every chat with a persisted move, for the startup sweep. */
  listPersisted: () => Array<{ sessionId: string; value: CrossMachineHandoffPersisted }>;
  readBatch?: (batchId: string) => CrossMachineBatchMovePersisted | null;
  writeBatch?: (batchId: string, value: CrossMachineBatchMovePersisted | null) => void;
  listBatches?: () => CrossMachineBatchMovePersisted[];
  listBatchChats?: () => Promise<CrossMachineBatchChat[]>;
  listBatchLanes?: () => Promise<CrossMachineBatchLane[]>;
  inspectBatchLane?: (laneId: string) => Promise<CrossMachineSourceInspection>;
  getSourceMachineName?: () => string;
  prepareBatchLane?: (args: {
    batchId: string;
    importId: string;
    lane: CrossMachineBatchLane;
    destinationParentLaneId?: string;
    includeChanges: boolean;
    sourceMachineName: string;
  }) => Promise<AgentChatCrossMachineLaneImportArgs>;
  validateBatchLane?: (payload: AgentChatCrossMachineLaneImportArgs) => Promise<void>;
  interruptBatchChat?: (sessionId: string) => Promise<void>;
  inspectSource: (sessionId: string) => Promise<CrossMachineSourceInspection>;
  /** False once the chat is deleted: its move is cleared (row and outbox), not written or announced. */
  chatExists?: (sessionId: string) => boolean;
  /** User message ids and steer ids already in the chat; only newer ones cancel a queued move. */
  listUserMessageIds: (sessionId: string) => string[];
  prepare: (args: AgentChatPrepareCrossMachineHandoffArgs) => Promise<AgentChatPrepareCrossMachineHandoffResult>;
  validateSource: (args: {
    sourceSessionId: string;
    capsule: AgentChatPrepareCrossMachineHandoffResult["capsule"];
    capsuleFingerprint: string;
    includeChanges: boolean;
  }) => Promise<void>;
  markSource: (args: {
    sourceSessionId: string;
    handoffId: string;
    targetMachineName: string;
    targetLaneId: string;
    targetSessionId: string;
  }) => Promise<void>;
  outbox: CrossMachineHandoffOutbox;
  /** The Approve/Deny card for an agent-started move, live or settled. */
  showApprovalCard: (sessionId: string, card: CrossMachineMoveApprovalCard) => void;
  /** A durable one-line transcript notice for a move that ended without landing. */
  noticeEnded: (sessionId: string, notice: CrossMachineMoveEndedNotice) => void;
  /** Tell the phone: an agent asked to move the chat, or an unwatched move ended. */
  notifyPerson?: (sessionId: string, record: AgentChatCrossMachineHandoffRecord, title: string | null) => void;
  /** Content-free hook for product analytics: a move reached a terminal state (never for a deleted chat). */
  onMoveOutcome?: (event: { sessionId: string; handoffId: string; outcome: CrossMachineMoveOutcome }) => void;
  logger: {
    info(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
  now?: () => string;
  /** Wall clock in ms, for the decline cooldown. */
  nowMs?: () => number;
};

/** The terminal states of a move, as product analytics records them. */
export type CrossMachineMoveOutcome = "continued" | "failed" | "cancelled" | "unknown";

/** The approval card's words; the host only emits it. */
export type CrossMachineMoveApprovalCard = {
  handoffId: string;
  live: boolean;
  title: string;
  subtitle: string | null;
  fallbackText: string;
};

export type CrossMachineMoveEndedNotice = {
  record: AgentChatCrossMachineHandoffRecord;
  noticeKind: "info" | "warning";
  message: string;
};

/** Transcript card id of a move's approval card (also skipped by the stale-capsule check). */
export const CROSS_MACHINE_MOVE_APPROVAL_CARD_PREFIX = "cross-machine-move-approval:";

export function crossMachineMoveApprovalCard(
  record: AgentChatCrossMachineHandoffRecord,
  live: boolean,
): CrossMachineMoveApprovalCard {
  if (!live) {
    return {
      handoffId: record.handoffId,
      live: false,
      title: "Move request answered",
      subtitle: null,
      fallbackText: "The move request was answered.",
    };
  }
  const grants = record.targetPermissionLabel
    ? ` It would run there at this chat's own permission level ("${record.targetPermissionLabel}").`
    : "";
  const requesterTitle = record.requestedByTitle?.trim();
  const requester = requesterTitle && record.requestedBySessionId
    ? `${requesterTitle} (${record.requestedBySessionId})`
    : requesterTitle || (record.requestedBySessionId ? `Agent chat ${record.requestedBySessionId}` : "An agent");
  const sourceChat = record.sourceChatTitle?.trim() || "this chat";
  return {
    handoffId: record.handoffId,
    live: true,
    title: `${requester} wants to move “${sourceChat}” to ${record.targetMachineName}`,
    subtitle: `Approve or deny it above the composer.${grants}`,
    fallbackText: `${requester} asked to move “${sourceChat}” to ${record.targetMachineName}. Approve or deny it above the composer.${grants}`,
  };
}

export function crossMachineMoveEndedNotice(record: AgentChatCrossMachineHandoffRecord): CrossMachineMoveEndedNotice {
  return {
    record,
    noticeKind: record.state === "cancelled" ? "info" : "warning",
    message: record.state === "cancelled"
      ? `Stayed here: ${record.reason ?? "the move was cancelled."}`
      : `Couldn't move to ${record.targetMachineName}: ${record.reason ?? "unknown error."}`,
  };
}

/**
 * Permission fields that run an agent's move at the source chat's own level in
 * the target model's provider, and that level in words. A provider that can't
 * express the level steps down the ladder, never up.
 */
export function crossMachineAgentTargetPermissions(
  sourceLevel: string | null | undefined,
  targetModelId: string,
): { fields: Partial<AgentChatCrossMachineTargetConfig>; label: string } {
  const descriptor = getModelById(targetModelId) ?? resolveModelAlias(targetModelId);
  if (!descriptor) throw new Error(`ADE doesn't know the model "${targetModelId}". Pick another model.`);
  const provider = resolveProviderGroupForModel(descriptor);
  // The source reads an unreadable posture as `ask` (sessionPermissionLevel).
  const level: PermissionLevel = isPermissionLevel(sourceLevel) ? sourceLevel : "ask";
  let applied = resolvePermissionLevel(
    level,
    provider === "opencode" ? "opencode" : provider === "cursor" ? "cursor" : undefined,
  ).level;
  // Kimi refuses auto-edit at launch and Copilot quietly runs it as ask; both
  // step down to ask so the label says what the chat will actually do.
  if (applied === "auto-edit" && ACP_PROVIDERS_WITHOUT_AUTO_EDIT.has(provider)) applied = "ask";
  // interactionMode is the session's own field, not a move field.
  const { interactionMode: _interaction, ...fields } = permissionFieldsForLevel(provider, applied);
  // The generic word for the same level too: a destination that doesn't read
  // the provider's own field (an older ADE, or a provider that maps from the
  // generic one) must not fall back to the source chat's broader setting.
  return { fields: { ...fields, permissionMode: GENERIC_PERMISSION_MODE_BY_LEVEL[applied] }, label: permissionLevelLabel(applied) };
}

const ACP_PROVIDERS_WITHOUT_AUTO_EDIT: ReadonlySet<string> = new Set(["kimi"]);

/** ADE's generic composer word for each level (mirrors permissionLadder's own table). */
const GENERIC_PERMISSION_MODE_BY_LEVEL: Record<PermissionLevel, "plan" | "default" | "edit" | "full-auto"> = {
  plan: "plan",
  ask: "default",
  "auto-edit": "edit",
  "full-auto": "full-auto",
};

/** A first lane import plus provider start over a slow link. */
const ACCEPT_TIMEOUT_MS = 180_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const IDLE_WAIT_MS = 15_000;
const IDLE_POLL_MS = 250;
/** After the person denies an agent's move, the agent may not ask again for this long. */
const AGENT_ASK_AFTER_DECLINE_MS = 2 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrapActionResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return current;
    const record = current as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "structuredContent")) {
      current = record.structuredContent;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(record, "result") && ("domain" in record || "action" in record)) {
      current = record.result;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * The chat no longer matches a prepared capsule (branch, commit, origin, files,
 * model, or newer chat activity). Only these mismatches mean "stale"; any
 * other failure of the source check (git unreachable, a blocker, a corrupt
 * capsule) says nothing about whether the capsule still describes the chat.
 */
export class CrossMachineSourceStaleError extends Error {
  readonly code = "source_stale" as const;
}

export function isCrossMachineSourceStaleError(error: unknown): boolean {
  return error instanceof CrossMachineSourceStaleError
    || (error instanceof Error && (error as { code?: unknown }).code === "source_stale");
}

/** The chat changed after a capsule that may have landed was sent. */
class StaleCapsuleError extends Error {
  constructor(machineName: string, dismissable: boolean) {
    super(
      `This chat changed after the move was sent. Open ${machineName} to check whether it arrived; if it didn't, ${
        dismissable ? "dismiss this move and start a new one" : "start a new move"
      }.`,
    );
  }
}

/** After a restart the source check itself failed, so the stored capsule was neither resent nor dropped. */
class UncheckedCapsuleError extends Error {
  constructor(reason: string) {
    super(`ADE couldn't check this chat after a restart: ${reason.replace(/[.\s]+$/, "")}. Retry when it's reachable.`);
  }
}

/** The destination answered acceptance in a shape ADE can't read; it may hold the chat. */
class UnreadableAcceptError extends Error {
  constructor(machineName: string) {
    super(
      `${machineName} answered without the new chat. It may already be there; open ${machineName} to check, then retry or dismiss this move.`,
    );
  }
}

function normalizeMachineSelector(value: string): string {
  return value.trim().toLowerCase();
}

function isDescendantOf(
  sessionId: string,
  ancestorId: string,
  bySession: Map<string, CrossMachineBatchChat>,
): boolean {
  const visited = new Set<string>();
  let current = bySession.get(sessionId)?.parentSessionId ?? null;
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = bySession.get(current)?.parentSessionId ?? null;
  }
  return false;
}

/** Lines an agent can act on: one per blocker, with its fix. */
export function describeCrossMachineBlockers(blockers: AgentChatCrossMachineHandoffBlocker[]): string {
  return blockers
    .map((blocker) => `- ${blocker.title}. ${blocker.detail}${blocker.fixHint ? ` Fix: ${blocker.fixHint}` : ""}`)
    .join("\n");
}

export function createCrossMachineHandoffOrchestrator(deps: CrossMachineHandoffOrchestratorDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());
  /** One run per chat at a time; a second trigger joins the first. */
  const running = new Map<string, Promise<void>>();
  /** User messages already in the chat when a move was queued. */
  const knownUserMessages = new Map<string, Set<string>>();
  /** When the person last denied an agent's move, per chat. */
  const declinedAt = new Map<string, number>();
  /** Outbox capsules `retry` just checked against the chat; runOnce skips re-checking them once. */
  const checkedOutbox = new Set<string>();

  /**
   * `now()`, but strictly after `previous`: clients keep the record with the
   * later `updatedAt`, so two writes in one millisecond (or a stalled clock)
   * must not tie, or a late `sending` could replace the `continued` after it.
   */
  const laterThan = (previous: string): string => {
    const at = now();
    const previousMs = Date.parse(previous);
    const atMs = Date.parse(at);
    if (Number.isFinite(previousMs) && Number.isFinite(atMs) && atMs <= previousMs) {
      return new Date(previousMs + 1).toISOString();
    }
    return at;
  };

  const write = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    patch: Partial<AgentChatCrossMachineHandoffRecord>,
  ): CrossMachineHandoffPersisted => {
    const next: CrossMachineHandoffPersisted = {
      request: persisted.request,
      record: { ...persisted.record, ...patch, updatedAt: laterThan(persisted.record.updatedAt) },
    };
    // A chat deleted mid-move has nowhere to keep its move: clear its row and
    // its capsule, or the startup sweep would keep finding (and resuming) it.
    if (!chatExists(sessionId)) {
      forgetMove(sessionId, [persisted.record.handoffId, next.record.handoffId]);
      return next;
    }
    deps.writePersisted(sessionId, next);
    return next;
  };

  const chatExists = (sessionId: string): boolean => !deps.chatExists || deps.chatExists(sessionId);

  /** Drop a deleted chat's move: its row and every capsule it could resend. */
  const forgetMove = (sessionId: string, handoffIds: string[]): void => {
    deps.writePersisted(sessionId, null);
    for (const handoffId of new Set(handoffIds)) deps.outbox.remove(handoffId);
    knownUserMessages.delete(sessionId);
    deps.logger.info("agent_chat.cross_machine_handoff_chat_gone", { sessionId, handoffIds: [...new Set(handoffIds)] });
  };

  const end = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    state: "failed" | "cancelled" | "unknown",
    reason: string,
    options: { acceptanceStarted?: boolean } = {},
  ): AgentChatCrossMachineHandoffRecord => {
    const next = write(sessionId, persisted, { state, reason });
    knownUserMessages.delete(sessionId);
    // A deleted chat: `write` already dropped the move and its capsule, and
    // there is no transcript to note it in and no chat to tell anyone about.
    if (!chatExists(sessionId)) return next.record;
    // Keep the sent capsule only while the destination may hold this move:
    // a retry then resends it and the destination reconciles.
    if (state !== "unknown" && !options.acceptanceStarted) deps.outbox.remove(next.record.handoffId);
    // Only a move that asked for approval has a card to settle; settling one
    // that never existed wrote a stray "answered" row into the transcript.
    if (persisted.record.state === "awaiting_approval") {
      deps.showApprovalCard(sessionId, crossMachineMoveApprovalCard(persisted.record, false));
    }
    deps.noticeEnded(sessionId, crossMachineMoveEndedNotice(next.record));
    deps.onMoveOutcome?.({ sessionId, handoffId: next.record.handoffId, outcome: state });
    deps.logger.info("agent_chat.cross_machine_handoff_ended", {
      sessionId,
      handoffId: next.record.handoffId,
      state,
      requestedBy: next.record.requestedBy,
    });
    if (state !== "cancelled" && (next.record.requestedBy === "agent" || persisted.request.queued)) {
      deps.notifyPerson?.(sessionId, next.record, deps.getSource(sessionId)?.title ?? null);
    }
    return next.record;
  };

  const requireTransport = (): CrossMachineHandoffTransport => {
    const transport = deps.transport();
    if (!transport) throw new Error("This ADE runtime can't reach other machines.");
    return transport;
  };

  const isLostAnswer = (transport: CrossMachineHandoffTransport, error: unknown): boolean =>
    isRemoteRuntimeConnectionError(error)
    || isRuntimeTransportTimeoutError(error)
    || transport.isLostAnswer?.(error) === true;

  const machineOption = (
    machine: CrossMachineHandoffMachine,
    originUrl: string | null,
  ): AgentChatCrossMachineHandoffMachineOption => ({
    machineKey: machine.machineKey,
    name: machine.name,
    online: machine.online,
    unavailableReason: machine.online ? null : "Offline",
    // Both sides normalized here: SSH and HTTPS forms of one remote must
    // match whatever shape the transport reports.
    hasRepository: machine.projects && originUrl
      ? machine.projects.some((project) =>
        normalizeGitRemoteIdentity(project.origin) === normalizeGitRemoteIdentity(originUrl))
      : null,
  });

  const listMachineOptions = async (
    originUrl: string | null,
  ): Promise<AgentChatCrossMachineHandoffMachineOption[]> => {
    const transport = deps.transport();
    if (!transport) return [];
    const machines = await transport.listMachines({ includeProjects: true });
    return machines.filter((machine) => !machine.isThisMachine).map((machine) => machineOption(machine, originUrl));
  };

  const getOptions = async (sourceSessionId: string): Promise<AgentChatCrossMachineHandoffOptionsResult> => {
    const source = deps.getSource(sourceSessionId);
    if (!source) throw new Error("The source chat could not be loaded.");
    const inspection = await deps.inspectSource(sourceSessionId);
    const blockers = [...inspection.blockers];
    if (!source.isWorkChat) {
      blockers.unshift({
        id: "not_work_chat",
        title: "Only Work chats can move",
        detail: "Personal and automation chats stay on this machine.",
        clearedByIncludeChanges: false,
        fixHint: null,
      });
    }
    if (source.awaitingInput) {
      blockers.push({
        id: "awaiting_input",
        title: "This chat is waiting on you",
        detail: "Answer the pending approval or question in the chat first.",
        clearedByIncludeChanges: false,
        fixHint: null,
      });
    }
    const current = deps.readPersisted(sourceSessionId)?.record ?? null;
    if (current && mayHaveLanded(current)) {
      blockers.push({
        id: "move_unknown",
        title: `A move to ${current.targetMachineName} may have landed`,
        detail: `Retry it, or open ${current.targetMachineName} to check, or dismiss it.`,
        clearedByIncludeChanges: false,
        fixHint: "run `ade chat handoff <session> --retry`, or `--cancel` to dismiss it",
      });
    }
    let machines: AgentChatCrossMachineHandoffMachineOption[] = [];
    try {
      machines = await listMachineOptions(inspection.originUrl);
    } catch (error) {
      deps.logger.warn("agent_chat.cross_machine_handoff_machines_failed", { error: errorText(error) });
    }
    return {
      machines,
      blockers,
      changes: inspection.changes,
      current,
    };
  };

  const resolveMachine = async (
    selector: string,
    options: { includeProjects?: boolean } = {},
  ): Promise<CrossMachineHandoffMachine> => {
    const machines = await requireTransport().listMachines(options);
    const needle = normalizeMachineSelector(selector);
    const match = machines.find((machine) => machine.machineKey === selector.trim())
      ?? machines.find((machine) => normalizeMachineSelector(machine.name) === needle);
    if (!match) {
      const known = machines.filter((machine) => !machine.isThisMachine).map((machine) => machine.name);
      throw new Error(
        `No machine named "${selector}" on this account.${known.length ? ` Machines: ${known.join(", ")}.` : ""}`,
      );
    }
    if (match.isThisMachine) throw new Error(`${match.name} is this machine. Pick another machine.`);
    if (!match.online) throw new Error(`${match.name} is offline. Try again when it is back.`);
    return match;
  };

  /**
   * The destination may already hold this move's chat: the answer was lost
   * (`unknown`), or it failed after acceptance started (its capsule is still
   * kept for a reconciling retry). A new move would get a new handoffId the
   * destination can't reconcile, so it could start a second chat there.
   */
  const mayHaveLanded = (record: AgentChatCrossMachineHandoffRecord | null | undefined): boolean =>
    Boolean(record && (record.state === "unknown"
      || (record.state === "failed" && deps.outbox.read(record.handoffId))));

  const refuseIfMoving = (sourceSessionId: string): CrossMachineHandoffPersisted | null => {
    const existing = deps.readPersisted(sourceSessionId);
    if (existing && isCrossMachineHandoffActive(existing.record)) {
      throw new Error(
        `This chat is already moving to ${existing.record.targetMachineName}. Cancel that move first.`,
      );
    }
    if (mayHaveLanded(existing?.record)) {
      const name = existing!.record.targetMachineName;
      throw new Error(`A move to ${name} may have landed. Retry it, or open ${name} to check, or dismiss it.`);
    }
    return existing;
  };

  /**
   * Starts still awaiting their checks, per chat. A person's message during
   * those awaits has no record to cancel yet, so it is noted here and a move
   * that would be queued is refused instead of saved.
   */
  const startsInFlight = new Map<string, Set<{ before: Set<string>; newMessage: boolean }>>();

  const start = async (
    args: AgentChatStartCrossMachineHandoffArgs,
    caller: {
      requestedBy: "user" | "agent";
      requestedFor?: "self" | "descendant" | "other";
      requestedBySessionId?: string | null;
      requestedByTitle?: string | null;
    },
    batchOptions: {
      handoffId?: string;
      batchMove?: CrossMachineBatchMoveContext;
    } = {},
  ): Promise<AgentChatCrossMachineHandoffRecord> => {
    const sourceSessionId = args.sourceSessionId?.trim();
    if (!sourceSessionId) throw new Error("A source chat is required.");
    // Load the chat first (getSource does, synchronously): loading can emit a
    // delivery update of an old message, which must land before the snapshot.
    if (!deps.getSource(sourceSessionId)) throw new Error("The source chat could not be loaded.");
    const watch = { before: new Set(deps.listUserMessageIds(sourceSessionId)), newMessage: false };
    const watches = startsInFlight.get(sourceSessionId) ?? new Set();
    watches.add(watch);
    startsInFlight.set(sourceSessionId, watches);
    try {
      return await startWatched(sourceSessionId, args, caller, watch, batchOptions);
    } finally {
      watches.delete(watch);
      if (!watches.size) startsInFlight.delete(sourceSessionId);
    }
  };

  const startWatched = async (
    sourceSessionId: string,
    args: AgentChatStartCrossMachineHandoffArgs,
    caller: {
      requestedBy: "user" | "agent";
      requestedFor?: "self" | "descendant" | "other";
      requestedBySessionId?: string | null;
      requestedByTitle?: string | null;
    },
    watch: { newMessage: boolean },
    batchOptions: { handoffId?: string; batchMove?: CrossMachineBatchMoveContext },
  ): Promise<AgentChatCrossMachineHandoffRecord> => {
    const source = deps.getSource(sourceSessionId);
    if (!source) throw new Error("The source chat could not be loaded.");
    if (!source.isWorkChat) throw new Error("Only Work chats can be sent to another machine.");
    refuseIfMoving(sourceSessionId);
    const isAgent = caller.requestedBy === "agent";
    if (isAgent) {
      const deniedAt = declinedAt.get(sourceSessionId);
      if (deniedAt !== undefined && nowMs() - deniedAt < AGENT_ASK_AFTER_DECLINE_MS) {
        throw new Error(
          "The person just declined moving this chat. Don't ask again for a couple of minutes; ask them in the chat if it matters.",
        );
      }
    }
    const targetModelId = args.targetModelId?.trim();
    if (!targetModelId) throw new Error("Pick the model the other machine should continue with.");
    // An agent's move never chooses its own permissions (whatever the caller
    // passed is dropped): it runs at the source chat's level, in the target
    // provider's words, so moving a chat can never widen what its agent may do.
    const agentPermissions = isAgent
      ? crossMachineAgentTargetPermissions(source.permissionLevel, targetModelId)
      : null;
    const machine = await resolveMachine(args.machine ?? "");
    const includeChanges = args.includeChanges === true;

    const inspection = await deps.inspectSource(sourceSessionId);
    const blockers = inspection.blockers.filter((blocker) => !(includeChanges && blocker.clearedByIncludeChanges));
    if (blockers.length) {
      throw new Error(`This chat can't move yet:\n${describeCrossMachineBlockers(blockers)}`);
    }
    // The machine lookup and git checks above were awaits; a turn may have
    // ended (or started) meanwhile. Decide from the chat as it is now, or a
    // move saved as `pending` after its turn already ended would never run.
    const current = deps.getSource(sourceSessionId) ?? source;
    if (current.awaitingInput) {
      throw new Error("This chat is waiting on an approval or question. Answer it, then move the chat.");
    }
    if (current.turnActive && args.whenTurnEnds !== true) {
      throw new Error(
        "This chat is still responding. Wait for the turn to end, or queue the move for when it ends (--when-turn-ends).",
      );
    }

    const requestedFor = caller.requestedFor ?? "self";
    const needsApproval = isAgent && requestedFor === "other";
    const state: AgentChatCrossMachineHandoffState = needsApproval
      ? "awaiting_approval"
      : current.turnActive
        ? "pending"
        : "sending";
    // The person wrote while the checks ran: a queued move would ignore it.
    if (state !== "sending" && watch.newMessage) {
      throw new Error("You sent a new message, so the chat stayed here.");
    }
    const requestedAt = now();
    const { sourceSessionId: _source, machine: _machine, whenTurnEnds: _when, ...requested } = args;
    const target = agentPermissions
      ? { ...withoutCrossMachinePermissionFields(requested), ...agentPermissions.fields }
      : requested;
    // The awaits above leave room for a second start on this chat; the last
    // read before the write is the one that counts.
    const existing = refuseIfMoving(sourceSessionId);
    const persisted: CrossMachineHandoffPersisted = {
      record: {
        handoffId: batchOptions.handoffId ?? randomUUID(),
        state,
        checkpoint: null,
        targetMachineKey: machine.machineKey,
        targetMachineName: machine.name,
        mode: args.mode === "fork" ? "fork" : "brief",
        targetModelId,
        includeChanges,
        requestedBy: caller.requestedBy,
        ...(isAgent ? {
          requestedFor,
          requestedBySessionId: caller.requestedBySessionId ?? null,
          requestedByTitle: caller.requestedByTitle?.trim() || null,
          sourceChatTitle: source.title?.trim() || null,
        } : {}),
        ...(agentPermissions ? { targetPermissionLabel: agentPermissions.label } : {}),
        requestedAt,
        updatedAt: requestedAt,
        reason: null,
        targetLaneId: null,
        targetSessionId: null,
        // Keep the previous return address until this move lands. A new move
        // revokes the earlier Work here instead choice once it continues.
        continuedOn: existing?.record.continuedOn ?? null,
        resumedHere: false,
      },
      request: {
        ...target,
        targetModelId,
        machine: machine.machineKey,
        mode: args.mode === "fork" ? "fork" : "brief",
        continuationPrompt: args.continuationPrompt?.trim() || null,
        includeChanges,
        clone: args.clone === true,
        queued: state !== "sending",
        ...(isAgent ? { agentSourceLevel: source.permissionLevel } : {}),
        ...(batchOptions.batchMove ? { batchMove: batchOptions.batchMove } : {}),
      },
    };
    if (state !== "sending") {
      knownUserMessages.set(sourceSessionId, new Set(deps.listUserMessageIds(sourceSessionId)));
    }
    // A new move replaces the old one, and with it the old capsule.
    if (existing) deps.outbox.remove(existing.record.handoffId);
    deps.writePersisted(sourceSessionId, persisted);
    deps.logger.info("agent_chat.cross_machine_handoff_requested", {
      sessionId: sourceSessionId,
      handoffId: persisted.record.handoffId,
      state,
      mode: persisted.record.mode,
      requestedBy: caller.requestedBy,
      includeChanges,
    });
    if (state === "awaiting_approval") {
      deps.showApprovalCard(sourceSessionId, crossMachineMoveApprovalCard(persisted.record, true));
      deps.notifyPerson?.(sourceSessionId, persisted.record, source.title);
    }
    if (state === "sending") void run(sourceSessionId);
    return persisted.record;
  };

  const cancel = (sourceSessionId: string, reason = "You kept it here."): AgentChatCrossMachineHandoffRecord | null => {
    const persisted = deps.readPersisted(sourceSessionId);
    if (!persisted) return null;
    if (persisted.record.state === "sending") {
      throw new Error("The move is already being sent and can't be stopped now.");
    }
    // Dismissing a move that may have landed: the person checked (or chose
    // not to), and its capsule goes with it so nothing can resend it.
    if (mayHaveLanded(persisted.record) || persisted.record.state === "failed") {
      return end(sourceSessionId, persisted, "cancelled", "You dismissed the move.");
    }
    if (persisted.record.state !== "pending" && persisted.record.state !== "awaiting_approval") {
      return persisted.record;
    }
    return end(sourceSessionId, persisted, "cancelled", reason);
  };

  const resolveApproval = (
    sourceSessionId: string,
    handoffId: string,
    approve: boolean,
  ): AgentChatCrossMachineHandoffRecord => {
    const persisted = deps.readPersisted(sourceSessionId);
    if (!persisted || persisted.record.handoffId !== handoffId) {
      throw new Error("That move is no longer waiting for approval.");
    }
    if (persisted.record.state !== "awaiting_approval") return persisted.record;
    if (!approve) {
      declinedAt.set(sourceSessionId, nowMs());
      return end(sourceSessionId, persisted, "cancelled", "You declined the move.");
    }
    deps.showApprovalCard(sourceSessionId, crossMachineMoveApprovalCard(persisted.record, false));
    const source = deps.getSource(sourceSessionId);
    const next = write(
      sourceSessionId,
      { ...persisted, request: { ...persisted.request, approvedByPerson: true } },
      { state: source?.turnActive ? "pending" : "sending" },
    );
    if (next.record.state === "sending") void run(sourceSessionId);
    return next.record;
  };

  /**
   * The person chose to keep working here although the chat continues on
   * another machine ("Work here instead"). Keyed by the move that landed it,
   * so a stale click from an older banner can't flip a newer continuation.
   */
  const acknowledge = (sourceSessionId: string, handoffId: string): AgentChatCrossMachineHandoffRecord | null => {
    const persisted = deps.readPersisted(sourceSessionId);
    const continuedOn = persisted?.record.continuedOn;
    if (!persisted || !continuedOn || continuedOn.handoffId !== handoffId) return persisted?.record ?? null;
    if (persisted.record.resumedHere) return persisted.record;
    return write(sourceSessionId, persisted, { resumedHere: true }).record;
  };

  /** Called when a turn on this chat ends. */
  const onTurnSettled = (sessionId: string): void => {
    const persisted = deps.readPersisted(sessionId);
    if (persisted?.record.state !== "pending") return;
    write(sessionId, persisted, { state: "sending" });
    void run(sessionId);
  };

  /**
   * Called for every committed user message the PERSON sent (the caller
   * filters out host-authored deliveries), with its message id and steer id.
   * New instructions win; a delivery update of a known message (either id)
   * is not new.
   */
  const onUserMessage = (
    sessionId: string,
    ids: { messageId?: string | null; steerId?: string | null },
  ): void => {
    const isNew = (known: Set<string>) =>
      !((ids.messageId && known.has(ids.messageId)) || (ids.steerId && known.has(ids.steerId)));
    for (const watch of startsInFlight.get(sessionId) ?? []) {
      if (isNew(watch.before)) watch.newMessage = true;
    }
    const persisted = deps.readPersisted(sessionId);
    if (persisted?.record.state !== "pending" && persisted?.record.state !== "awaiting_approval") return;
    // After a restart the snapshot is gone. The caller runs this BEFORE the
    // message is written, so rebuilding from the transcript still tells a new
    // message from a delivery update of one that predates the request.
    let known = knownUserMessages.get(sessionId);
    if (!known) {
      known = new Set(deps.listUserMessageIds(sessionId));
      knownUserMessages.set(sessionId, known);
    }
    if ((ids.messageId && known.has(ids.messageId)) || (ids.steerId && known.has(ids.steerId))) return;
    end(sessionId, persisted, "cancelled", "You sent a new message, so the chat stayed here.");
  };

  const checkpoint = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    value: AgentChatCrossMachineHandoffCheckpoint,
    patch: Partial<AgentChatCrossMachineHandoffRecord> = {},
  ): CrossMachineHandoffPersisted => write(sessionId, persisted, { ...patch, checkpoint: value });

  const callPreflight = async (
    transport: CrossMachineHandoffTransport,
    input: {
      machine: string;
      originUrl: string;
      clone?: boolean;
      args: Record<string, unknown>;
    },
  ): Promise<AgentChatCrossMachineDestinationPreflightResult> => {
    const response = await transport.callAction({
      machine: input.machine,
      originUrl: input.originUrl,
      ...(input.clone ? { clone: true } : {}),
      action: "preflightCrossMachineDestination",
      args: input.args,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    return decodeCrossMachineDestinationPreflightResult(unwrapActionResult(response.result));
  };

  const preflightDestination = async (
    transport: CrossMachineHandoffTransport,
    persisted: CrossMachineHandoffPersisted,
    prepared: AgentChatPrepareCrossMachineHandoffResult,
  ): Promise<AgentChatCrossMachineDestinationPreflightResult> => {
    const input = {
      machine: persisted.request.machine,
      originUrl: prepared.capsule.source.originUrl,
      clone: persisted.request.clone,
      args: {
        targetModelId: prepared.capsule.target.targetModelId,
        sourceBranchRef: prepared.capsule.source.branchRef,
        sourceHeadSha: prepared.capsule.source.headSha,
        mode: persisted.record.mode,
        sourceProvider: prepared.capsule.source.provider,
        ...(prepared.capsule.gitBundle || prepared.capsule.batchMove?.carriedChanges ? { hasGitBundle: true } : {}),
        ...(prepared.capsule.batchMove
          ? { requireBatchMoveSupport: true, batchLaneImportId: prepared.capsule.batchMove.laneImportId }
          : {}),
      },
    };
    let preflight = await callPreflight(transport, input);
    // A clean lane there that is only behind is safe to fast-forward: the
    // destination re-checks everything and only ever runs `merge --ff-only`.
    if (preflight.laneFastForward && !prepared.capsule.gitBundle && !prepared.capsule.batchMove) {
      await transport.callAction({
        machine: persisted.request.machine,
        originUrl: prepared.capsule.source.originUrl,
        action: "fastForwardCrossMachineHandoffLane",
        args: { laneId: preflight.laneFastForward.laneId, expectedHead: prepared.capsule.source.headSha },
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      });
      preflight = await callPreflight(transport, input);
    }
    // An older destination would accept the capsule and drop the changes, so
    // the absence of an explicit `true` refuses rather than degrades.
    if ((prepared.capsule.gitBundle || prepared.capsule.batchMove?.carriedChanges) && preflight.gitBundleSupport !== true) {
      throw new Error(
        `${persisted.record.targetMachineName} needs an ADE update to take uncommitted changes. Update it, or push the branch and move without them.`,
      );
    }
    if (prepared.capsule.batchMove && preflight.batchMoveSupport !== 1) {
      throw new Error(
        `${persisted.record.targetMachineName} needs an ADE update to preserve batch lane trees, chat parents, scheduled work, and arrival instructions.`,
      );
    }
    if (persisted.record.mode === "fork" && preflight.forkHandoffSupport?.supported !== true) {
      throw new Error(
        preflight.forkHandoffSupport?.reason
          ?? `${persisted.record.targetMachineName} needs an ADE update to take a full-history fork. Send a brief instead.`,
      );
    }
    if (preflight.blockingErrors.length) throw new Error(preflight.blockingErrors.join(" "));
    return preflight;
  };

  /** Whether a stored capsule still describes the chat (throws when it doesn't). */
  const validateStored = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    prepared: CrossMachinePreparedCapsule,
  ): Promise<void> =>
    deps.validateSource({
      sourceSessionId: sessionId,
      capsule: prepared.capsule,
      capsuleFingerprint: prepared.capsuleFingerprint,
      includeChanges: persisted.record.includeChanges,
    });

  const runOnce = async (sessionId: string): Promise<void> => {
    let persisted = deps.readPersisted(sessionId);
    if (!persisted || persisted.record.state !== "sending") return;
    const transport = deps.transport();
    if (!transport) {
      // An outbox means acceptance may have started: keep the capsule.
      end(sessionId, persisted, "failed", "This ADE runtime can't reach other machines.", {
        acceptanceStarted: Boolean(deps.outbox.read(persisted.record.handoffId)),
      });
      return;
    }
    let acceptanceStarted = false;
    try {
      // Acceptance already started once for this handoffId (a retry after a
      // lost answer, or a restart mid-send): resend exactly what was sent. The
      // destination answers from its record for this id instead of making a
      // second lane or chat, and a re-prepared capsule would not match it.
      let prepared: CrossMachinePreparedCapsule | null = deps.outbox.read(persisted.record.handoffId);
      if (prepared && !checkedOutbox.delete(persisted.record.handoffId)) {
        // A restart mid-send: the capsule may already be there, so a chat
        // that changed since is not resent and not re-prepared either.
        try {
          await validateStored(sessionId, persisted, prepared);
        } catch (error) {
          acceptanceStarted = true;
          if (isCrossMachineSourceStaleError(error)) throw new StaleCapsuleError(persisted.record.targetMachineName, true);
          // The check itself failed (git, the lane): nothing is known about the
          // chat, so nothing is resent. Keep the capsule for a retry.
          throw new UncheckedCapsuleError(errorText(error));
        }
      }
      if (prepared) {
        deps.logger.info("agent_chat.cross_machine_handoff_reconcile", {
          sessionId,
          handoffId: persisted.record.handoffId,
        });
        persisted = checkpoint(sessionId, persisted, "destination_ready");
      } else {
        // A queued move fires on the turn's done event, a beat before the chat
        // reads idle; prepare refuses a busy chat, so give it a moment.
        const idleBy = Date.now() + IDLE_WAIT_MS;
        while (deps.getSource(sessionId)?.turnActive && Date.now() < idleBy) {
          await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
        }
        // An agent's move runs at the LOWER of the chat's level when it asked
        // and its level now: the person may have lowered access while the
        // move waited. A move full-auto let through goes back for approval
        // once the chat is no longer full-auto.
        if (persisted.record.requestedBy === "agent") {
          const levelNow = deps.getSource(sessionId)?.permissionLevel ?? null;
          const asked = persisted.request.agentSourceLevel ?? null;
          const level = isPermissionLevel(asked) && isPermissionLevel(levelNow)
            ? (permissionLevelRank(asked) <= permissionLevelRank(levelNow) ? asked : levelNow)
            : (isPermissionLevel(levelNow) ? levelNow : "ask");
          if (
            !persisted.request.approvedByPerson
            && (persisted.record.requestedFor === "other" || level !== "full-auto")
          ) {
            const waiting = write(sessionId, persisted, { state: "awaiting_approval", checkpoint: null });
            deps.showApprovalCard(sessionId, crossMachineMoveApprovalCard(waiting.record, true));
            deps.notifyPerson?.(sessionId, waiting.record, deps.getSource(sessionId)?.title ?? null);
            return;
          }
          const applied = crossMachineAgentTargetPermissions(level, persisted.request.targetModelId);
          persisted = write(
            sessionId,
            {
              ...persisted,
              request: {
                ...withoutCrossMachinePermissionFields(persisted.request),
                ...applied.fields,
              } as CrossMachineHandoffRequest,
            },
            { targetPermissionLabel: applied.label },
          );
        }
        const fresh = await deps.prepare({
          ...persisted.request,
          sourceSessionId: sessionId,
          handoffId: persisted.record.handoffId,
          continuationPrompt: persisted.request.continuationPrompt,
          mode: persisted.record.mode,
          includeChanges: persisted.record.includeChanges,
          ...(persisted.request.batchMove
            ? {
                sourceLane: persisted.request.batchMove.sourceLane,
                destinationParentLaneId: persisted.request.batchMove.destinationParentLaneId,
                parentLink: persisted.request.batchMove.parentLink,
                batchMove: persisted.request.batchMove,
              }
            : {}),
        });
        persisted = checkpoint(sessionId, persisted, "prepared");
        await preflightDestination(transport, persisted, fresh);
        persisted = checkpoint(sessionId, persisted, "destination_ready");
        await deps.validateSource({
          sourceSessionId: sessionId,
          capsule: fresh.capsule,
          capsuleFingerprint: fresh.capsuleFingerprint,
          includeChanges: persisted.record.includeChanges,
        });
        prepared = { capsule: fresh.capsule, capsuleFingerprint: fresh.capsuleFingerprint };
        // Deleted while a step awaited: nothing is stored or sent for it.
        if (!chatExists(sessionId)) {
          forgetMove(sessionId, [persisted.record.handoffId]);
          return;
        }
        deps.outbox.write(persisted.record.handoffId, prepared);
      }
      if (!chatExists(sessionId)) {
        forgetMove(sessionId, [persisted.record.handoffId]);
        return;
      }
      acceptanceStarted = true;
      const response = await transport.callAction({
        machine: persisted.request.machine,
        originUrl: prepared.capsule.source.originUrl,
        action: "acceptCrossMachineHandoff",
        args: { capsule: prepared.capsule, capsuleFingerprint: prepared.capsuleFingerprint },
        timeoutMs: ACCEPT_TIMEOUT_MS,
      });
      let accepted: ReturnType<typeof decodeAcceptCrossMachineHandoffResult>;
      try {
        accepted = decodeAcceptCrossMachineHandoffResult(unwrapActionResult(response.result));
      } catch {
        // The destination answered, but not in a shape ADE can read: it may
        // have made the lane and chat. Keep the capsule; a retry reconciles.
        throw new UnreadableAcceptError(persisted.record.targetMachineName);
      }
      persisted = checkpoint(sessionId, persisted, "accepted", {
        targetLaneId: accepted.laneId,
        targetSessionId: accepted.session.id,
      });
      try {
        await deps.markSource({
          sourceSessionId: sessionId,
          handoffId: persisted.record.handoffId,
          targetMachineName: persisted.record.targetMachineName,
          targetLaneId: accepted.laneId,
          targetSessionId: accepted.session.id,
        });
        persisted = checkpoint(sessionId, persisted, "marked");
      } catch (markError) {
        // Destination acceptance is the commit point; the transcript marker is
        // bookkeeping and its failure must not hide the new chat.
        deps.logger.warn("agent_chat.cross_machine_handoff_mark_failed", {
          sessionId,
          handoffId: persisted.record.handoffId,
          error: errorText(markError),
        });
      }
      persisted = write(sessionId, persisted, {
        state: "continued",
        reason: null,
        // A fresh landing: new messages go there until the person says
        // otherwise, even if they had kept working here after an earlier move.
        resumedHere: false,
        continuedOn: {
          handoffId: persisted.record.handoffId,
          targetMachineKey: persisted.record.targetMachineKey,
          targetMachineName: persisted.record.targetMachineName,
          targetLaneId: accepted.laneId,
          targetSessionId: accepted.session.id,
          continuedAt: now(),
        },
      });
      deps.outbox.remove(persisted.record.handoffId);
      knownUserMessages.delete(sessionId);
      if (chatExists(sessionId)) {
        deps.onMoveOutcome?.({ sessionId, handoffId: persisted.record.handoffId, outcome: "continued" });
      }
      deps.logger.info("agent_chat.cross_machine_handoff_continued", {
        sessionId,
        handoffId: persisted.record.handoffId,
        reusedLane: accepted.reusedLane,
        reusedSession: accepted.reusedSession,
      });
      if ((persisted.record.requestedBy === "agent" || persisted.request.queued) && chatExists(sessionId)) {
        deps.notifyPerson?.(sessionId, persisted.record, deps.getSource(sessionId)?.title ?? null);
      }
    } catch (error) {
      const current = deps.readPersisted(sessionId) ?? persisted;
      if (
        error instanceof StaleCapsuleError
        || error instanceof UncheckedCapsuleError
        || error instanceof UnreadableAcceptError
      ) {
        end(sessionId, current, "unknown", error.message, { acceptanceStarted: true });
        return;
      }
      if (acceptanceStarted && isLostAnswer(transport, error)) {
        end(
          sessionId,
          current,
          "unknown",
          `ADE lost the answer from ${current.record.targetMachineName}. The chat may already be there; check before retrying.`,
          { acceptanceStarted },
        );
        return;
      }
      end(sessionId, current, "failed", errorText(error), { acceptanceStarted });
    }
  };

  const run = (sessionId: string): Promise<void> => {
    const inFlight = running.get(sessionId);
    if (inFlight) return inFlight;
    const task = runOnce(sessionId).finally(() => {
      running.delete(sessionId);
      wakeBatchRunsForSession(sessionId);
    });
    running.set(sessionId, task);
    return task;
  };

  /**
   * Retry a failed or unknown move with the same choices. Same handoffId, and
   * once acceptance had started, the same capsule from the outbox: the
   * destination reconciles through its own record instead of creating a
   * second lane or chat. That capsule is resent only while it still matches
   * the chat (branch, files, model, no newer messages). When it doesn't,
   * the retry is refused. A stored capsule exists only once acceptance had
   * started, so even a `failed` move may have started its chat there (the
   * destination can fail after the continuation began); a new handoffId would
   * bypass the destination's record and could start a second agent on the
   * same branch. The person checks that machine, then starts a new move.
   */
  const retry = async (
    sourceSessionId: string,
    options: { asBrief?: boolean } = {},
  ): Promise<AgentChatCrossMachineHandoffRecord> => {
    let persisted = deps.readPersisted(sourceSessionId);
    if (!persisted) throw new Error("There is no move to retry.");
    if (persisted.record.state !== "failed" && persisted.record.state !== "unknown") return persisted.record;
    if (running.has(sourceSessionId)) return persisted.record;
    if (options.asBrief) {
      // Only a fork that failed before it was packed: nothing was sent, so a
      // brief with the same saved choices can replace it.
      if (persisted.record.mode !== "fork" || persisted.record.state !== "failed" || persisted.record.checkpoint != null
        || deps.outbox.read(persisted.record.handoffId)) {
        throw new Error("Only a fork that failed before it was sent can continue as a brief.");
      }
      persisted = {
        request: { ...persisted.request, mode: "brief" },
        record: { ...persisted.record, mode: "brief" },
      };
    }
    const source = deps.getSource(sourceSessionId);
    if (source?.turnActive) throw new Error("This chat is responding. Retry when the turn ends.");
    const oldId = persisted.record.handoffId;
    const stored = deps.outbox.read(oldId);
    if (stored) {
      let stale = false;
      let checkError: unknown = null;
      try {
        await validateStored(sourceSessionId, persisted, stored);
      } catch (error) {
        if (isCrossMachineSourceStaleError(error)) stale = true;
        else checkError = error;
      }
      // The check awaited: take the record as it is now.
      const latest = deps.readPersisted(sourceSessionId);
      if (!latest || latest.record.handoffId !== oldId || latest.record.state !== persisted.record.state) {
        return latest?.record ?? persisted.record;
      }
      // The check itself failed: whether the capsule still matches is
      // unknown, so neither resend it nor prepare a new one. Nothing changes.
      if (checkError) {
        throw new Error(`Couldn't check the chat before retrying: ${errorText(checkError)}`);
      }
      if (stale) {
        throw new StaleCapsuleError(persisted.record.targetMachineName, persisted.record.state === "unknown");
      }
      checkedOutbox.add(oldId);
    }
    const next = write(sourceSessionId, persisted, { state: "sending", reason: null, checkpoint: null });
    void run(sourceSessionId);
    return next.record;
  };

  const batchRuns = new Map<string, Promise<void>>();
  const batchRunAgain = new Set<string>();
  const requireBatchStore = (): void => {
    if (!deps.readBatch || !deps.writeBatch || !deps.listBatches || !deps.listBatchChats || !deps.listBatchLanes) {
      throw new Error("Batch moves are unavailable on this runtime.");
    }
  };
  const readBatch = (batchId: string): CrossMachineBatchMovePersisted | null => deps.readBatch?.(batchId) ?? null;
  const writeBatch = (
    batchId: string,
    record: CrossMachineBatchMovePersisted,
  ): CrossMachineBatchMovePersisted => {
    const next = { ...record, updatedAt: laterThan(record.updatedAt) };
    deps.writeBatch?.(batchId, next);
    return next;
  };
  const updateBatchItem = (
    batchId: string,
    itemId: string,
    patch: Partial<AgentChatCrossMachineBatchMoveItem>,
  ): CrossMachineBatchMovePersisted | null => {
    const record = readBatch(batchId);
    if (!record) return null;
    const items = record.items.map((item) => item.id === itemId
      ? { ...item, ...patch, updatedAt: laterThan(item.updatedAt) }
      : item);
    return writeBatch(batchId, { ...record, items });
  };
  const dependenciesReady = (
    record: CrossMachineBatchMovePersisted,
    item: AgentChatCrossMachineBatchMoveItem,
  ): "ready" | "waiting" | "blocked" => {
    const byId = new Map(record.items.map((candidate) => [candidate.id, candidate]));
    for (const dependencyId of item.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) return "blocked";
      if (dependency.state === "cancelled" || dependency.state === "failed" || dependency.state === "unknown" || dependency.state === "blocked") return "blocked";
      if (dependency.state !== "continued") return "waiting";
    }
    return "ready";
  };
  const batchRequestFor = (args: AgentChatStartCrossMachineBatchMoveArgs): AgentChatCrossMachineBatchMoveArgs => ({
    machine: args.machine,
    ...(args.sessionIds ? { sessionIds: args.sessionIds } : {}),
    ...(args.includeDescendants !== undefined ? { includeDescendants: args.includeDescendants } : {}),
    ...(args.allWorkOnThisMachine !== undefined ? { allWorkOnThisMachine: args.allWorkOnThisMachine } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.includeChanges !== undefined ? { includeChanges: args.includeChanges } : {}),
    ...(args.whenBusy ? { whenBusy: args.whenBusy } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
  });

  const startBatch = async (
    args: AgentChatStartCrossMachineBatchMoveArgs,
  ): Promise<AgentChatCrossMachineBatchMoveRecord> => {
    requireBatchStore();
    const input = batchRequestFor(args);
    const selector = input.machine?.trim();
    if (!selector) throw new Error("A destination machine is required.");
    const note = input.note?.trim() || null;
    if (note && note.length > 4_000) throw new Error("Keep the batch continuation note under 4,000 characters.");
    if (input.allWorkOnThisMachine === true && (input.sessionIds?.length ?? 0) > 0) {
      throw new Error("Choose --all or explicit chat ids, not both.");
    }
    const selectedIds = (input.sessionIds ?? []).map((id) => id.trim()).filter(Boolean);
    if (!input.allWorkOnThisMachine && selectedIds.length === 0) {
      throw new Error("Choose --all or at least one Work chat id.");
    }

    const allChats = await deps.listBatchChats!();
    const eligible = allChats.filter((chat) => chat.isWorkChat);
    if (input.allWorkOnThisMachine === true && eligible.length === 0) {
      throw new Error("There are no active Work chats on this project to move.");
    }
    const bySession = new Map(eligible.map((chat) => [chat.sessionId, chat]));
    const lineageBySession = new Map(allChats.map((chat) => [chat.sessionId, chat]));
    let selected = new Set(input.allWorkOnThisMachine
      ? eligible.map((chat) => chat.sessionId)
      : selectedIds);
    const missing = [...selected].filter((id) => !bySession.has(id));
    if (missing.length) throw new Error(`These chats are not active Work chats on this project: ${missing.join(", ")}.`);

    if (input.includeDescendants !== false) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const chat of eligible) {
          if (chat.parentSessionId && selected.has(chat.parentSessionId) && !selected.has(chat.sessionId)) {
            selected.add(chat.sessionId);
            changed = true;
          }
        }
      }
    }
    const orderedChats: CrossMachineBatchChat[] = [];
    const remaining = new Set(selected);
    while (remaining.size) {
      const ready = eligible.filter((chat) => remaining.has(chat.sessionId)
        && (!chat.parentSessionId || !selected.has(chat.parentSessionId) || !remaining.has(chat.parentSessionId)));
      if (!ready.length) throw new Error("The selected chat tree contains a parent cycle and can't be moved.");
      for (const chat of ready) {
        orderedChats.push(chat);
        remaining.delete(chat.sessionId);
      }
    }
    for (const chat of orderedChats) {
      if (chat.awaitingInput) throw new Error(`Resolve the pending approval or question in '${chat.title ?? chat.sessionId}' before moving the batch.`);
    }

    const lanes = await deps.listBatchLanes!();
    const lanesById = new Map(lanes.map((lane) => [lane.laneId, lane]));
    const selectedLaneIds = new Set<string>();
    for (const chat of orderedChats) {
      let laneId: string | null = chat.laneId;
      while (laneId) {
        if (selectedLaneIds.has(laneId)) break;
        const lane = lanesById.get(laneId);
        if (!lane) throw new Error(`The source lane '${laneId}' could not be loaded.`);
        selectedLaneIds.add(laneId);
        laneId = lane.parentLaneId;
      }
    }
    const orderedLanes: CrossMachineBatchLane[] = [];
    const remainingLanes = new Set(selectedLaneIds);
    while (remainingLanes.size) {
      const ready = lanes.filter((lane) => remainingLanes.has(lane.laneId)
        && (!lane.parentLaneId || !selectedLaneIds.has(lane.parentLaneId) || !remainingLanes.has(lane.parentLaneId)));
      if (!ready.length) throw new Error("The selected lane tree contains a parent cycle and can't be moved.");
      for (const lane of ready) {
        orderedLanes.push(lane);
        remainingLanes.delete(lane.laneId);
      }
    }

    const machine = await resolveMachine(selector);
    const transport = requireTransport();
    const includeChanges = input.includeChanges !== false;
    const requestedMode = input.mode === "brief" ? "brief" : "fork";
    const laneInspections = new Map<string, CrossMachineSourceInspection>();
    for (const lane of orderedLanes) {
      const inspection = await deps.inspectBatchLane?.(lane.laneId);
      if (!inspection) throw new Error("Batch lane inspection is unavailable on this runtime.");
      const blockers = inspection.blockers.filter((blocker) => !(includeChanges && blocker.clearedByIncludeChanges));
      if (blockers.length) throw new Error(`Lane '${lane.name}' can't move yet:\n${describeCrossMachineBlockers(blockers)}`);
      if (!inspection.originUrl || !inspection.branchRef || !inspection.headSha) {
        throw new Error(`Lane '${lane.name}' needs a published branch and origin before it can move.`);
      }
      laneInspections.set(lane.laneId, inspection);
    }

    const batchId = randomUUID();
    const chosenModes = new Map<string, { mode: "brief" | "fork"; fallbackReason: string | null }>();
    for (const chat of orderedChats) {
      const inspection = await deps.inspectSource(chat.sessionId);
      const blockers = inspection.blockers.filter((blocker) => !(includeChanges && blocker.clearedByIncludeChanges));
      if (blockers.length) throw new Error(`Chat '${chat.title ?? chat.sessionId}' can't move yet:\n${describeCrossMachineBlockers(blockers)}`);
      if (!inspection.originUrl || !inspection.branchRef || !inspection.headSha) {
        throw new Error(`Chat '${chat.title ?? chat.sessionId}' needs a published branch and origin before it can move.`);
      }
      const targetModelId = chat.modelId?.trim() || chat.model.trim();
      if (!targetModelId) throw new Error(`Chat '${chat.title ?? chat.sessionId}' has no model to continue with.`);
      const hasBundle = includeChanges && inspection.changes !== null;
      let mode: "brief" | "fork" = requestedMode;
      let fallbackReason: string | null = null;
      const makePreflightArgs = (candidateMode: "brief" | "fork") => ({
        targetModelId,
        sourceBranchRef: inspection.branchRef!,
        sourceHeadSha: inspection.headSha!,
        mode: candidateMode,
        sourceProvider: chat.provider,
        requireBatchMoveSupport: true,
        batchLaneImportId: `${batchId}:lane:${chat.laneId}`,
        ...(hasBundle ? { hasGitBundle: true } : {}),
      });
      let preflight = await callPreflight(transport, {
        machine: machine.machineKey,
        originUrl: inspection.originUrl,
        args: makePreflightArgs(mode),
      });
      if (preflight.batchMoveSupport !== 1) {
        throw new Error(`${machine.name} needs an ADE update to preserve batch lane trees, chat parents, scheduled work, and arrival instructions.`);
      }
      if (hasBundle && preflight.gitBundleSupport !== true) {
        throw new Error(`${machine.name} needs an ADE update to take uncommitted changes. Update it, or move without them.`);
      }
      if (mode === "fork" && preflight.forkHandoffSupport?.supported === false) {
        fallbackReason = preflight.forkHandoffSupport.reason ?? "This provider cannot move its full history between machines.";
        mode = "brief";
        preflight = await callPreflight(transport, {
          machine: machine.machineKey,
          originUrl: inspection.originUrl,
          args: makePreflightArgs(mode),
        });
      } else if (mode === "fork" && preflight.forkHandoffSupport?.supported !== true) {
        throw new Error(`${machine.name} needs an ADE update to check whether this chat can move as a fork.`);
      }
      if (preflight.blockingErrors.length) {
        throw new Error(`Chat '${chat.title ?? chat.sessionId}': ${preflight.blockingErrors.join(" ")}`);
      }
      chosenModes.set(chat.sessionId, { mode, fallbackReason });
    }

    const modelForLanePreflight = orderedChats[0]?.modelId?.trim() || orderedChats[0]?.model.trim();
    if (!modelForLanePreflight) throw new Error("The batch has no chat model to use for lane preflight.");
    const chattedLaneIds = new Set(orderedChats.map((chat) => chat.laneId));
    for (const lane of orderedLanes) {
      if (chattedLaneIds.has(lane.laneId)) continue;
      const inspection = laneInspections.get(lane.laneId)!;
      const hasBundle = includeChanges && inspection.changes !== null;
      const preflight = await callPreflight(transport, {
        machine: machine.machineKey,
        originUrl: inspection.originUrl!,
        args: {
          targetModelId: modelForLanePreflight,
          sourceBranchRef: inspection.branchRef!,
          sourceHeadSha: inspection.headSha!,
          mode: "brief",
          requireBatchMoveSupport: true,
          batchLaneImportId: `${batchId}:lane:${lane.laneId}`,
          ...(hasBundle ? { hasGitBundle: true } : {}),
        },
      });
      if (preflight.batchMoveSupport !== 1) {
        throw new Error(`${machine.name} needs an ADE update to preserve the selected lane tree.`);
      }
      if (hasBundle && preflight.gitBundleSupport !== true) {
        throw new Error(`${machine.name} needs an ADE update to take changes from lane '${lane.name}'.`);
      }
      if (preflight.blockingErrors.length) {
        throw new Error(`Lane '${lane.name}': ${preflight.blockingErrors.join(" ")}`);
      }
    }

    const requestedBy = args.requestedBy === "user" ? "user" : "agent";
    const requestingSessionId = args.requestingSessionId?.trim() || null;
    const laneItems: AgentChatCrossMachineBatchMoveItem[] = orderedLanes.map((lane) => {
      const id = `lane:${lane.laneId}`;
      return {
        id,
        kind: "lane",
        state: "pending",
        dependsOn: lane.parentLaneId && selectedLaneIds.has(lane.parentLaneId) ? [`lane:${lane.parentLaneId}`] : [],
        sourceLaneId: lane.laneId,
        importId: `${batchId}:lane:${lane.laneId}`,
        updatedAt: now(),
      };
    });
    const orderedChatIds = new Set(orderedChats.map((chat) => chat.sessionId));
    const chatItems: AgentChatCrossMachineBatchMoveItem[] = orderedChats.map((chat) => {
      const parentSelected = Boolean(chat.parentSessionId && orderedChatIds.has(chat.parentSessionId));
      const requestedFor = requestedBy !== "agent"
        ? undefined
        : chat.sessionId === requestingSessionId
          ? "self"
          : requestingSessionId && isDescendantOf(chat.sessionId, requestingSessionId, lineageBySession)
            ? "descendant"
            : "other";
      const mode = chosenModes.get(chat.sessionId)!;
      const dependsOn = [`lane:${chat.laneId}`];
      if (parentSelected) dependsOn.push(`chat:${chat.parentSessionId}`);
      return {
        id: `chat:${chat.sessionId}`,
        kind: "chat",
        state: "pending",
        dependsOn,
        sourceLaneId: chat.laneId,
        sourceSessionId: chat.sessionId,
        handoffId: `${batchId}:chat:${chat.sessionId}`,
        mode: mode.mode,
        requestedFor,
        modeFallbackReason: mode.fallbackReason,
        updatedAt: now(),
      };
    });
    for (const chat of allChats) {
      if (orderedChatIds.has(chat.sessionId) || !chat.parentSessionId || !orderedChatIds.has(chat.parentSessionId)) continue;
      deps.logger.warn("agent_chat.cross_machine_batch_parent_left_on_source", {
        batchId,
        parentSessionId: chat.parentSessionId,
        childSessionId: chat.sessionId,
      });
    }
    const requestedAt = now();
    const record: CrossMachineBatchMovePersisted = {
      batchId,
      state: "pending",
      machineKey: machine.machineKey,
      machineName: machine.name,
      requestedBy,
      requestingSessionId,
      requestedAt,
      updatedAt: requestedAt,
      includeChanges,
      whenBusy: input.whenBusy === "interrupt" ? "interrupt" : "wait",
      note,
      items: [...laneItems, ...chatItems],
    };
    writeBatch(batchId, record);
    void runBatch(batchId);
    return record;
  };

  const importBatchLaneItem = async (
    batchId: string,
    item: AgentChatCrossMachineBatchMoveItem,
    batch: CrossMachineBatchMovePersisted,
  ): Promise<void> => {
    const lane = (await deps.listBatchLanes!()).find((candidate) => candidate.laneId === item.sourceLaneId);
    if (!lane || !deps.prepareBatchLane || !deps.validateBatchLane || !deps.outbox.readLane || !deps.outbox.writeLane) {
      throw new Error("Batch lane import is unavailable on this runtime.");
    }
    const transport = requireTransport();
    let payload = deps.outbox.readLane(item.importId!) ?? null;
    if (!payload) {
      const parentLaneItem = lane.parentLaneId
        ? batch.items.find((candidate) => candidate.id === `lane:${lane.parentLaneId}`)
        : null;
      if (lane.parentLaneId && !parentLaneItem?.destinationLaneId) {
        throw new Error("The destination parent lane was not imported before its child lane.");
      }
      payload = await deps.prepareBatchLane({
        batchId,
        importId: item.importId!,
        lane,
        ...(parentLaneItem?.destinationLaneId ? { destinationParentLaneId: parentLaneItem.destinationLaneId } : {}),
        includeChanges: batch.includeChanges,
        sourceMachineName: deps.getSourceMachineName?.() || "source machine",
      });
      deps.outbox.writeLane!(item.importId!, payload);
    }
    await deps.validateBatchLane(payload);
    updateBatchItem(batchId, item.id, { state: "sending", error: null });
    let callStarted = false;
    try {
      callStarted = true;
      const response = await transport.callAction({
        machine: batch.machineKey,
        originUrl: payload.originUrl,
        action: "importCrossMachineHandoffLane",
        args: payload as unknown as Record<string, unknown>,
        timeoutMs: ACCEPT_TIMEOUT_MS,
      });
      const result = unwrapActionResult(response.result);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("The destination answered without the imported lane details.");
      }
      const returned = result as Partial<AgentChatCrossMachineLaneImportResult>;
      if (
        returned.importId !== item.importId
        || typeof returned.laneId !== "string"
        || typeof returned.reusedLane !== "boolean"
        || !Array.isArray(returned.warnings)
      ) {
        throw new Error("The destination answered with invalid lane import details.");
      }
      updateBatchItem(batchId, item.id, {
        state: "continued",
        destinationLaneId: returned.laneId,
        carriedChanges: returned.carriedChanges === true,
        snapshotSha: typeof returned.snapshotSha === "string" ? returned.snapshotSha : null,
        ...(returned.setupStatus === "running" || returned.setupStatus === "completed" || returned.setupStatus === "failed" || returned.setupStatus === "not_configured"
          ? { laneSetupStatus: returned.setupStatus }
          : {}),
        warning: returned.warnings.filter((warning): warning is string => typeof warning === "string").join(" ") || null,
        error: null,
      });
      deps.outbox.removeLane!(item.importId!);
    } catch (error) {
      const unknown = callStarted && isLostAnswer(transport, error);
      updateBatchItem(batchId, item.id, {
        state: unknown ? "unknown" : "failed",
        error: errorText(error),
      });
      if (!callStarted) deps.outbox.removeLane!(item.importId!);
    }
  };

  const runBatchOnce = async (batchId: string): Promise<void> => {
    requireBatchStore();
    const initialBatch = readBatch(batchId);
    if (!initialBatch || initialBatch.state === "completed") return;
    let batch: CrossMachineBatchMovePersisted = writeBatch(batchId, { ...initialBatch, state: "running" });
    if (batch.whenBusy === "interrupt") {
      for (const snapshot of batch.items) {
        const item = readBatch(batchId)?.items.find((candidate) => candidate.id === snapshot.id);
        if (!item || item.kind !== "chat" || item.state !== "pending") continue;
        const source = deps.getSource(item.sourceSessionId!);
        if (!source?.turnActive) continue;
        try {
          if (!deps.interruptBatchChat) throw new Error("This runtime cannot interrupt a chat for a batch move.");
          await deps.interruptBatchChat(item.sourceSessionId!);
        } catch (error) {
          updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
        }
      }
    }
    for (const snapshot of batch.items) {
      const refreshedBatch = readBatch(batchId);
      if (refreshedBatch) batch = refreshedBatch;
      const item = batch.items.find((candidate) => candidate.id === snapshot.id);
      if (!item || item.state === "continued" || item.state === "cancelled" || item.state === "unknown" || item.state === "failed" || item.state === "blocked") continue;
      const dependencyState = dependenciesReady(batch, item);
      if (dependencyState === "blocked") {
        updateBatchItem(batchId, item.id, { state: "blocked", error: "A required parent lane or chat did not arrive." });
        continue;
      }
      if (dependencyState === "waiting") continue;
      if (item.kind === "lane") {
        try {
          await importBatchLaneItem(batchId, item, batch);
        } catch (error) {
          updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
        }
        continue;
      }

      const sourceSessionId = item.sourceSessionId!;
      const move = deps.readPersisted(sourceSessionId);
      if (move && move.record.handoffId === item.handoffId) {
        if (move.record.state === "failed" || move.record.state === "unknown") {
          try {
            await retry(sourceSessionId);
          } catch (error) {
            updateBatchItem(batchId, item.id, { state: move.record.state, error: errorText(error) });
            continue;
          }
        }
        if (move.record.state === "sending" || move.record.state === "failed" || move.record.state === "unknown") {
          await run(sourceSessionId);
        }
        else if (move.record.state === "pending" && !deps.getSource(sourceSessionId)?.turnActive) onTurnSettled(sourceSessionId);
        const current = deps.readPersisted(sourceSessionId);
        const currentRecord = current && current.record.handoffId === item.handoffId ? current.record : null;
        const state = currentRecord?.state ?? null;
        if (state === "continued") {
          updateBatchItem(batchId, item.id, {
            state: "continued",
            destinationLaneId: currentRecord?.targetLaneId,
            destinationSessionId: currentRecord?.targetSessionId,
            error: null,
          });
        } else if (state === "unknown" || state === "failed") {
          updateBatchItem(batchId, item.id, { state, error: currentRecord?.reason ?? null });
        } else if (state === "cancelled") {
          updateBatchItem(batchId, item.id, { state: "cancelled", error: currentRecord?.reason ?? null });
        } else if (state === "awaiting_approval") {
          updateBatchItem(batchId, item.id, { state: "awaiting_approval", error: currentRecord?.reason ?? null });
        } else {
          updateBatchItem(batchId, item.id, { state: "pending" });
        }
        continue;
      }

      const source = deps.getSource(sourceSessionId);
      if (!source) {
        updateBatchItem(batchId, item.id, { state: "failed", error: "The source chat could not be loaded." });
        continue;
      }
      try {
        const laneItem = batch.items.find((candidate) => candidate.id === `lane:${item.sourceLaneId}`);
        const lane = (await deps.listBatchLanes!()).find((candidate) => candidate.laneId === item.sourceLaneId);
        if (!laneItem?.destinationLaneId || !lane) throw new Error("The destination lane was not imported before its chat.");
        const parentLaneItem = lane.parentLaneId
          ? batch.items.find((candidate) => candidate.id === `lane:${lane.parentLaneId}`)
          : null;
        const parentChatItem = item.dependsOn
          .map((id) => batch.items.find((candidate) => candidate.id === id))
          .find((candidate) => candidate?.kind === "chat");
        const sourceChats = await deps.listBatchChats!();
        const selectedChat = sourceChats.find((chat) => chat.sessionId === sourceSessionId);
        if (!selectedChat) throw new Error("The selected chat is no longer available for a batch move.");
        const parentLink = parentChatItem?.destinationSessionId
          ? { destinationParentSessionId: parentChatItem.destinationSessionId, spawnKind: selectedChat.spawnKind }
          : undefined;
        const context: CrossMachineBatchMoveContext = {
          batchId,
          laneImportId: laneItem.importId!,
          destinationLaneId: laneItem.destinationLaneId,
          carriedChanges: laneItem.carriedChanges === true,
          snapshotSha: laneItem.snapshotSha ?? null,
          ...(batch.note ? { note: batch.note } : {}),
          ...(item.modeFallbackReason ? { modeFallbackReason: item.modeFallbackReason } : {}),
          sourceLane: { laneId: lane.laneId, parentLaneId: lane.parentLaneId, name: lane.name },
          ...(parentLaneItem?.destinationLaneId ? { destinationParentLaneId: parentLaneItem.destinationLaneId } : {}),
          ...(parentLink ? { parentLink } : {}),
        };
        const record = await start({
          sourceSessionId,
          machine: batch.machineKey,
          targetModelId: selectedChat.modelId?.trim() || selectedChat.model,
          mode: item.mode ?? "brief",
          includeChanges: batch.includeChanges,
          whenTurnEnds: true,
        }, {
          requestedBy: batch.requestedBy,
          ...(item.requestedFor ? { requestedFor: item.requestedFor } : {}),
          ...(batch.requestingSessionId ? { requestedBySessionId: batch.requestingSessionId } : {}),
        }, {
          handoffId: item.handoffId,
          batchMove: {
            ...context,
            sourceLane: context.sourceLane,
          },
        });
        if (record.state === "sending") await run(sourceSessionId);
        const current = deps.readPersisted(sourceSessionId);
        const currentRecord = current && current.record.handoffId === item.handoffId ? current.record : null;
        if (currentRecord) {
          const state: AgentChatCrossMachineBatchMoveItemState = currentRecord.state === "continued"
            ? "continued"
          : currentRecord.state === "cancelled"
            ? "cancelled"
            : currentRecord.state === "unknown" || currentRecord.state === "failed"
              ? currentRecord.state
              : currentRecord.state === "awaiting_approval"
                ? "awaiting_approval"
                : "pending";
          updateBatchItem(batchId, item.id, {
            state,
            destinationLaneId: currentRecord.targetLaneId,
            destinationSessionId: currentRecord.targetSessionId
              ?? deterministicChatSessionId(`cross-machine-handoff:${item.handoffId}`),
            error: currentRecord.reason,
          });
        }
      } catch (error) {
        updateBatchItem(batchId, item.id, { state: "failed", error: errorText(error) });
      }
    }
    const latest = readBatch(batchId);
    if (!latest) return;
    const hasWaiting = latest.items.some((item) => item.state === "pending" || item.state === "sending" || item.state === "awaiting_approval");
    const hasFailures = latest.items.some((item) => item.state === "cancelled" || item.state === "failed" || item.state === "unknown" || item.state === "blocked");
    const state = latest.items.every((item) => item.state === "continued")
      ? "completed"
      : hasWaiting
        ? "pending"
        : hasFailures ? "partial" : "pending";
    writeBatch(batchId, { ...latest, state });
  };

  const runBatch = (batchId: string): Promise<void> => {
    const existing = batchRuns.get(batchId);
    if (existing) {
      batchRunAgain.add(batchId);
      return existing;
    }
    const task = runBatchOnce(batchId).finally(() => {
      batchRuns.delete(batchId);
      if (batchRunAgain.delete(batchId)) void runBatch(batchId);
    });
    batchRuns.set(batchId, task);
    return task;
  };

  function wakeBatchRunsForSession(sessionId: string): void {
    for (const batch of deps.listBatches?.() ?? []) {
      if (batch.items.some((item) => item.kind === "chat" && item.sourceSessionId === sessionId)) {
        void runBatch(batch.batchId);
      }
    }
  }

  const getBatch = (batchId: string): AgentChatCrossMachineBatchMoveRecord | null => {
    requireBatchStore();
    return readBatch(batchId);
  };

  const retryBatch = async (batchId: string): Promise<AgentChatCrossMachineBatchMoveRecord> => {
    requireBatchStore();
    const batch = readBatch(batchId);
    if (!batch) throw new Error("Batch move not found.");
    // Reset all failed branches together. runBatch walks the durable dependency
    // order, so a child cannot be retried until its parent has arrived.
    for (const item of batch.items) {
      if (item.state === "failed" || item.state === "unknown" || item.state === "blocked") {
        updateBatchItem(batchId, item.id, { state: "pending", error: null });
      }
    }
    const next = readBatch(batchId)!;
    writeBatch(batchId, { ...next, state: "pending" });
    void runBatch(batchId);
    return readBatch(batchId)!;
  };

  /**
   * What the destination would say about a move, asked through this brain's
   * own transport: nothing is prepared, packed or cloned.
   */
  const preview = async (
    args: AgentChatPreviewCrossMachineHandoffArgs,
  ): Promise<AgentChatPreviewCrossMachineHandoffResult> => {
    const sourceSessionId = args.sourceSessionId?.trim();
    if (!sourceSessionId) throw new Error("A source chat is required.");
    const source = deps.getSource(sourceSessionId);
    if (!source) throw new Error("The source chat could not be loaded.");
    const targetModelId = args.targetModelId?.trim();
    if (!targetModelId) throw new Error("Pick the model the other machine should continue with.");
    const transport = requireTransport();
    const machine = await resolveMachine(args.machine ?? "", { includeProjects: true });
    const inspection = await deps.inspectSource(sourceSessionId);
    if (!inspection.originUrl) throw new Error("This project has no origin remote, so no other machine can find it.");
    const base = { machineKey: machine.machineKey, machineName: machine.name };
    if (machineOption(machine, inspection.originUrl).hasRepository === false) {
      return { ...base, hasRepository: false, preflight: null };
    }
    if (!inspection.branchRef || !inspection.headSha) {
      throw new Error("This chat's lane is not on a branch with a commit, so it can't move.");
    }
    const preflight = await callPreflight(transport, {
      machine: machine.machineKey,
      originUrl: inspection.originUrl,
      args: {
        targetModelId,
        sourceBranchRef: inspection.branchRef,
        sourceHeadSha: inspection.headSha,
        mode: args.mode === "fork" ? "fork" : "brief",
        ...(source.provider ? { sourceProvider: source.provider } : {}),
        ...(args.includeChanges === true && inspection.changes ? { hasGitBundle: true } : {}),
      },
    });
    return { ...base, hasRepository: true, preflight };
  };

  /**
   * After a restart: a `sending` move resumes (the destination is idempotent
   * by handoffId, and the outbox resends the same capsule); a `pending` move
   * whose turn already ended starts now. A runtime without a transport owns
   * no moves and touches none.
   */
  const sweep = (): void => {
    if (!deps.transport()) return;
    for (const { sessionId, value } of deps.listPersisted()) {
      // A chat deleted while its move was saved: drop the move, never run it.
      if (!chatExists(sessionId)) {
        forgetMove(sessionId, [value.record.handoffId]);
        continue;
      }
      if (value.record.state === "sending") {
        void run(sessionId);
      } else if (value.record.state === "pending" && !deps.getSource(sessionId)?.turnActive) {
        onTurnSettled(sessionId);
      }
    }
    // Per-chat outboxes keep each move idempotent. Batch records only order
    // those moves, so a restart resumes the same remaining items in order.
    for (const batch of deps.listBatches?.() ?? []) {
      if (batch.state !== "completed") void runBatch(batch.batchId);
    }
  };

  return {
    getOptions,
    start,
    startBatch,
    getBatch,
    retryBatch,
    cancel,
    retry,
    preview,
    resolveApproval,
    acknowledge,
    onTurnSettled,
    onUserMessage,
    sweep,
  };
}

export type CrossMachineHandoffOrchestrator = ReturnType<typeof createCrossMachineHandoffOrchestrator>;
