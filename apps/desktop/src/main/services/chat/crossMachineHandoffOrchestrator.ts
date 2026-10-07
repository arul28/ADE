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
 * by `handoffId`, which is what makes resuming a `sending` move safe.
 *
 * Rules that came from T3 Code's thread handoff and the ADE review of it:
 * - A busy chat moves only when asked to wait (`whenTurnEnds`), and then any
 *   newer USER message cancels the move: new instructions win.
 * - An agent moving a chat that is not full-auto needs the person's approval.
 * - Once destination acceptance starts, a lost answer is `unknown`, never
 *   `failed`, and it is never replayed automatically.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentChatAcceptCrossMachineHandoffResult,
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
};

export type CrossMachineHandoffSource = {
  sessionId: string;
  isWorkChat: boolean;
  turnActive: boolean;
  awaitingInput: boolean;
  /** `full-auto` lets an agent move the chat without asking. */
  permissionLevel: string | null;
  title: string | null;
};

export type CrossMachineSourceInspection = {
  originUrl: string | null;
  branchRef: string | null;
  blockers: AgentChatCrossMachineHandoffBlocker[];
  changes: { unpushedCommits: number; changedFiles: number } | null;
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
  /** User message ids already in the chat; only newer ones cancel a queued move. */
  listUserMessageIds: (sessionId: string) => string[];
  prepare: (args: AgentChatPrepareCrossMachineHandoffArgs) => Promise<AgentChatPrepareCrossMachineHandoffResult>;
  validateSource: (args: {
    sourceSessionId: string;
    capsule: AgentChatPrepareCrossMachineHandoffResult["capsule"];
    capsuleFingerprint: string;
  }) => Promise<void>;
  markSource: (args: {
    sourceSessionId: string;
    handoffId: string;
    targetMachineName: string;
    targetLaneId: string;
    targetSessionId: string;
  }) => Promise<void>;
  /** The Approve/Deny card for an agent-started move; null removes it. */
  showApprovalCard: (sessionId: string, record: AgentChatCrossMachineHandoffRecord | null) => void;
  /** A durable one-line transcript notice for a move that ended badly. */
  noticeEnded: (sessionId: string, record: AgentChatCrossMachineHandoffRecord) => void;
  /** Tell the phone: an agent asked to move the chat, or an unwatched move ended. */
  notifyPerson?: (sessionId: string, record: AgentChatCrossMachineHandoffRecord, title: string | null) => void;
  isTransportFailure: (error: unknown) => boolean;
  logger: {
    info(event: string, data?: Record<string, unknown>): void;
    warn(event: string, data?: Record<string, unknown>): void;
  };
  now?: () => string;
};

/** A first lane import plus provider start over a slow link. */
const ACCEPT_TIMEOUT_MS = 180_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const IDLE_WAIT_MS = 15_000;
const IDLE_POLL_MS = 250;

const ACTIVE_STATES: ReadonlySet<AgentChatCrossMachineHandoffState> = new Set([
  "awaiting_approval",
  "pending",
  "sending",
]);

export function isCrossMachineHandoffActive(record: AgentChatCrossMachineHandoffRecord | null | undefined): boolean {
  return Boolean(record && ACTIVE_STATES.has(record.state));
}

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
  /** One run per chat at a time; a second trigger joins the first. */
  const running = new Map<string, Promise<void>>();
  /** User messages already in the chat when a move was queued. */
  const knownUserMessages = new Map<string, Set<string>>();

  const write = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    patch: Partial<AgentChatCrossMachineHandoffRecord>,
  ): CrossMachineHandoffPersisted => {
    const next: CrossMachineHandoffPersisted = {
      request: persisted.request,
      record: { ...persisted.record, ...patch, updatedAt: now() },
    };
    deps.writePersisted(sessionId, next);
    return next;
  };

  const end = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    state: "failed" | "cancelled" | "unknown",
    reason: string,
  ): AgentChatCrossMachineHandoffRecord => {
    const next = write(sessionId, persisted, { state, reason });
    knownUserMessages.delete(sessionId);
    // Only a move that asked for approval has a card to settle; settling one
    // that never existed wrote a stray "answered" row into the transcript.
    if (persisted.record.state === "awaiting_approval") deps.showApprovalCard(sessionId, null);
    deps.noticeEnded(sessionId, next.record);
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

  const listMachineOptions = async (
    originUrl: string | null,
  ): Promise<AgentChatCrossMachineHandoffMachineOption[]> => {
    const transport = deps.transport();
    if (!transport) return [];
    const machines = await transport.listMachines({ includeProjects: true });
    return machines
      .filter((machine) => !machine.isThisMachine)
      .map((machine) => {
        const hasRepository = machine.projects && originUrl
          ? machine.projects.some((project) => project.origin === originUrl)
          : null;
        return {
          machineKey: machine.machineKey,
          name: machine.name,
          online: machine.online,
          unavailableReason: machine.online ? null : "Offline",
          hasRepository,
        };
      });
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
      current: deps.readPersisted(sourceSessionId)?.record ?? null,
    };
  };

  const resolveMachine = async (selector: string): Promise<CrossMachineHandoffMachine> => {
    const machines = await requireTransport().listMachines();
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

  const start = async (
    args: AgentChatStartCrossMachineHandoffArgs,
    caller: { requestedBy: "user" | "agent" },
  ): Promise<AgentChatCrossMachineHandoffRecord> => {
    const sourceSessionId = args.sourceSessionId?.trim();
    if (!sourceSessionId) throw new Error("A source chat is required.");
    const source = deps.getSource(sourceSessionId);
    if (!source) throw new Error("The source chat could not be loaded.");
    if (!source.isWorkChat) throw new Error("Only Work chats can be sent to another machine.");
    const existing = deps.readPersisted(sourceSessionId);
    if (existing && isCrossMachineHandoffActive(existing.record)) {
      throw new Error(
        `This chat is already moving to ${existing.record.targetMachineName}. Cancel that move first.`,
      );
    }
    const targetModelId = args.targetModelId?.trim();
    if (!targetModelId) throw new Error("Pick the model the other machine should continue with.");
    const machine = await resolveMachine(args.machine ?? "");
    const includeChanges = args.includeChanges === true;

    const inspection = await deps.inspectSource(sourceSessionId);
    const blockers = inspection.blockers.filter((blocker) => !(includeChanges && blocker.clearedByIncludeChanges));
    if (blockers.length) {
      throw new Error(`This chat can't move yet:\n${describeCrossMachineBlockers(blockers)}`);
    }
    if (source.awaitingInput) {
      throw new Error("This chat is waiting on an approval or question. Answer it, then move the chat.");
    }
    if (source.turnActive && args.whenTurnEnds !== true) {
      throw new Error(
        "This chat is still responding. Wait for the turn to end, or queue the move for when it ends (--when-turn-ends).",
      );
    }

    const needsApproval = caller.requestedBy === "agent" && source.permissionLevel !== "full-auto";
    const state: AgentChatCrossMachineHandoffState = needsApproval
      ? "awaiting_approval"
      : source.turnActive
        ? "pending"
        : "sending";
    const requestedAt = now();
    const { sourceSessionId: _source, machine: _machine, whenTurnEnds: _when, ...target } = args;
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
      },
    };
    if (state !== "sending") {
      knownUserMessages.set(sourceSessionId, new Set(deps.listUserMessageIds(sourceSessionId)));
    }
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
      deps.showApprovalCard(sourceSessionId, persisted.record);
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
    if (!approve) return end(sourceSessionId, persisted, "cancelled", "You declined the move.");
    deps.showApprovalCard(sourceSessionId, null);
    const source = deps.getSource(sourceSessionId);
    const next = write(sourceSessionId, persisted, { state: source?.turnActive ? "pending" : "sending" });
    if (next.record.state === "sending") void run(sourceSessionId);
    return next.record;
  };

  /** The person chose to keep working here after the chat continued elsewhere. */
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

  /** Called for every committed user message. New instructions win. */
  const onUserMessage = (sessionId: string, messageId: string | null): void => {
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
    if (messageId && known.has(messageId)) return;
    end(sessionId, persisted, "cancelled", "You sent a new message, so the chat stayed here.");
  };

  const checkpoint = (
    sessionId: string,
    persisted: CrossMachineHandoffPersisted,
    value: AgentChatCrossMachineHandoffCheckpoint,
    patch: Partial<AgentChatCrossMachineHandoffRecord> = {},
  ): CrossMachineHandoffPersisted => write(sessionId, persisted, { ...patch, checkpoint: value });

  const preflightDestination = async (
    transport: CrossMachineHandoffTransport,
    persisted: CrossMachineHandoffPersisted,
    prepared: AgentChatPrepareCrossMachineHandoffResult,
  ): Promise<AgentChatCrossMachineDestinationPreflightResult> => {
    const call = async () => {
      const response = await transport.callAction({
        machine: persisted.request.machine,
        originUrl: prepared.capsule.source.originUrl,
        clone: persisted.request.clone,
        action: "preflightCrossMachineDestination",
        args: {
          targetModelId: prepared.capsule.target.targetModelId,
          sourceBranchRef: prepared.capsule.source.branchRef,
          sourceHeadSha: prepared.capsule.source.headSha,
          mode: persisted.record.mode,
          sourceProvider: prepared.capsule.source.provider,
          ...(prepared.capsule.gitBundle ? { hasGitBundle: true } : {}),
        },
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      });
      return unwrapActionResult(response.result) as AgentChatCrossMachineDestinationPreflightResult;
    };
    let preflight = await call();
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
      preflight = await call();
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
    if (preflight.blockingErrors?.length) throw new Error(preflight.blockingErrors.join(" "));
    return preflight;
  };

  const runOnce = async (sessionId: string): Promise<void> => {
    let persisted = deps.readPersisted(sessionId);
    if (!persisted || persisted.record.state !== "sending") return;
    const transport = deps.transport();
    if (!transport) {
      end(sessionId, persisted, "failed", "This ADE runtime can't reach other machines.");
      return;
    }
    let acceptanceStarted = false;
    try {
      // A queued move fires on the turn's done event, a beat before the chat
      // reads idle; prepare refuses a busy chat, so give it a moment.
      const idleBy = Date.now() + IDLE_WAIT_MS;
      while (deps.getSource(sessionId)?.turnActive && Date.now() < idleBy) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      }
      const prepared = await deps.prepare({
        ...persisted.request,
        sourceSessionId: sessionId,
        handoffId: persisted.record.handoffId,
        continuationPrompt: persisted.request.continuationPrompt,
        mode: persisted.record.mode,
        includeChanges: persisted.record.includeChanges,
      });
      persisted = checkpoint(sessionId, persisted, "prepared");
      await preflightDestination(transport, persisted, prepared);
      persisted = checkpoint(sessionId, persisted, "destination_ready");
      await deps.validateSource({
        sourceSessionId: sessionId,
        capsule: prepared.capsule,
        capsuleFingerprint: prepared.capsuleFingerprint,
      });
      acceptanceStarted = true;
      const response = await transport.callAction({
        machine: persisted.request.machine,
        originUrl: prepared.capsule.source.originUrl,
        action: "acceptCrossMachineHandoff",
        args: { capsule: prepared.capsule, capsuleFingerprint: prepared.capsuleFingerprint },
        timeoutMs: ACCEPT_TIMEOUT_MS,
      });
      const accepted = unwrapActionResult(response.result) as AgentChatAcceptCrossMachineHandoffResult;
      if (!accepted?.laneId || !accepted.session?.id) {
        throw new Error(`${persisted.record.targetMachineName} answered without the new chat.`);
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
      knownUserMessages.delete(sessionId);
      deps.logger.info("agent_chat.cross_machine_handoff_continued", {
        sessionId,
        handoffId: persisted.record.handoffId,
        reusedLane: accepted.reusedLane,
        reusedSession: accepted.reusedSession,
      });
      if (persisted.record.requestedBy === "agent" || persisted.request.queued) {
        deps.notifyPerson?.(sessionId, persisted.record, deps.getSource(sessionId)?.title ?? null);
      }
    } catch (error) {
      const current = deps.readPersisted(sessionId) ?? persisted;
      if (acceptanceStarted && deps.isTransportFailure(error)) {
        end(
          sessionId,
          current,
          "unknown",
          `ADE lost the answer from ${current.record.targetMachineName}. The chat may already be there; check before retrying.`,
        );
        return;
      }
      end(sessionId, current, "failed", errorText(error));
    }
  };

  const run = (sessionId: string): Promise<void> => {
    const inFlight = running.get(sessionId);
    if (inFlight) return inFlight;
    const task = runOnce(sessionId).finally(() => running.delete(sessionId));
    running.set(sessionId, task);
    return task;
  };

  /** Retry a failed or unknown move with the same choices. */
  const retry = (sourceSessionId: string): AgentChatCrossMachineHandoffRecord => {
    const persisted = deps.readPersisted(sourceSessionId);
    if (!persisted) throw new Error("There is no move to retry.");
    if (persisted.record.state !== "failed" && persisted.record.state !== "unknown") return persisted.record;
    const source = deps.getSource(sourceSessionId);
    if (source?.turnActive) throw new Error("This chat is responding. Retry when the turn ends.");
    // Same handoffId: the destination reconciles an `unknown` move through its
    // own record instead of creating a second lane or chat.
    const next = write(sourceSessionId, persisted, { state: "sending", reason: null, checkpoint: null });
    void run(sourceSessionId);
    return next.record;
  };

  /**
   * After a restart: a `sending` move resumes (the destination is idempotent
   * by handoffId); a `pending` move whose turn already ended starts now.
   */
  const sweep = (): void => {
    for (const { sessionId, value } of deps.listPersisted()) {
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
    resolveApproval,
    acknowledge,
    onTurnSettled,
    onUserMessage,
    sweep,
  };
}

export type CrossMachineHandoffOrchestrator = ReturnType<typeof createCrossMachineHandoffOrchestrator>;
