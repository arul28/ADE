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
 * - An agent moving a chat that is not full-auto needs the person's approval,
 *   and an agent's move runs there at the source chat's own permission level,
 *   mapped to the target model's provider (never broader).
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
  AgentChatStartCrossMachineHandoffArgs,
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
};

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
};

export type CrossMachineHandoffOrchestratorDeps = {
  transport: () => CrossMachineHandoffTransport | null;
  getSource: (sessionId: string) => CrossMachineHandoffSource | null;
  readPersisted: (sessionId: string) => CrossMachineHandoffPersisted | null;
  /** Persist, then publish to live clients. Null clears it. */
  writePersisted: (sessionId: string, value: CrossMachineHandoffPersisted | null) => void;
  /** Every chat with a persisted move, for the startup sweep. */
  listPersisted: () => Array<{ sessionId: string; value: CrossMachineHandoffPersisted }>;
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
  return {
    handoffId: record.handoffId,
    live: true,
    title: `The agent wants to continue this chat on ${record.targetMachineName}`,
    subtitle: `Approve or deny it above the composer.${grants}`,
    fallbackText: `The agent asked to move this chat to ${record.targetMachineName}. Approve or deny it above the composer.${grants}`,
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

const ACP_PROVIDERS_WITHOUT_AUTO_EDIT: ReadonlySet<string> = new Set(["kimi", "copilot"]);

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

  const write = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    patch: Partial<AgentChatCrossMachineHandoffRecord>,
  ): CrossMachineHandoffPersisted => {
    const next: CrossMachineHandoffPersisted = {
      request: persisted.request,
      record: { ...persisted.record, ...patch, updatedAt: now() },
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

  const start = async (
    args: AgentChatStartCrossMachineHandoffArgs,
    caller: { requestedBy: "user" | "agent" },
  ): Promise<AgentChatCrossMachineHandoffRecord> => {
    const sourceSessionId = args.sourceSessionId?.trim();
    if (!sourceSessionId) throw new Error("A source chat is required.");
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

    const needsApproval = isAgent && source.permissionLevel !== "full-auto";
    const state: AgentChatCrossMachineHandoffState = needsApproval
      ? "awaiting_approval"
      : current.turnActive
        ? "pending"
        : "sending";
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
        handoffId: randomUUID(),
        state,
        checkpoint: null,
        targetMachineKey: machine.machineKey,
        targetMachineName: machine.name,
        mode: args.mode === "fork" ? "fork" : "brief",
        targetModelId,
        includeChanges,
        requestedBy: caller.requestedBy,
        ...(agentPermissions ? { targetPermissionLabel: agentPermissions.label } : {}),
        requestedAt,
        updatedAt: requestedAt,
        reason: null,
        targetLaneId: null,
        targetSessionId: null,
        // Where the chat already continues survives this attempt, and so does
        // the person's choice to keep working here.
        continuedOn: existing?.record.continuedOn ?? null,
        resumedHere: existing?.record.resumedHere ?? false,
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
        ...(prepared.capsule.gitBundle ? { hasGitBundle: true } : {}),
      },
    };
    let preflight = await callPreflight(transport, input);
    // A clean lane there that is only behind is safe to fast-forward: the
    // destination re-checks everything and only ever runs `merge --ff-only`.
    if (preflight.laneFastForward && !prepared.capsule.gitBundle) {
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
    if (prepared.capsule.gitBundle && preflight.gitBundleSupport !== true) {
      throw new Error(
        `${persisted.record.targetMachineName} needs an ADE update to take uncommitted changes. Update it, or push the branch and move without them.`,
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
          if (!persisted.request.approvedByPerson && level !== "full-auto") {
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
        deps.outbox.write(persisted.record.handoffId, prepared);
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
    const task = runOnce(sessionId).finally(() => running.delete(sessionId));
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
  const retry = async (sourceSessionId: string): Promise<AgentChatCrossMachineHandoffRecord> => {
    const persisted = deps.readPersisted(sourceSessionId);
    if (!persisted) throw new Error("There is no move to retry.");
    if (persisted.record.state !== "failed" && persisted.record.state !== "unknown") return persisted.record;
    if (running.has(sourceSessionId)) return persisted.record;
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
  };

  return {
    getOptions,
    start,
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
