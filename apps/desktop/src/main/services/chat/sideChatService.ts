import fs from "node:fs";
import {
  SIDE_CHAT_UNSUPPORTED_MESSAGE,
  SIDE_CHAT_WAIT_FOR_TURN_MESSAGE,
  buildSideChatFirstPrompt,
  buildSideChatMainMessage,
  extractSideChatSendToMain,
  providerSupportsSideChatWhileBusy,
  sideChatUnavailableReason,
} from "../../../shared/sideChat";
import type {
  AgentChatCreateArgs,
  AgentChatEndSideChatArgs,
  AgentChatEndSideChatResult,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatEventMetadata,
  AgentChatProvider,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatStartSideChatArgs,
  AgentChatStartSideChatResult,
  AgentChatSteerArgs,
  AgentChatSteerResult,
  ClaudeRetainedMedia,
} from "../../../shared/types";
import {
  cursorSessionRunsInCloud,
  defaultActiveTurnDispatchMode,
  supportsActiveTurnDispatchMode,
} from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";
import { nowIso } from "../shared/utils";
import { findLastTurnUserMessage } from "./chatRerunLastTurn";
import type { ChatProviderFork, ChatProviderForkFailure, ChatProviderForkPointer } from "./chatProviderFork";
import { resolveClaudeSdkTranscriptPath } from "./claudeThinkingTranscriptRepair";
import { codexServerSupportsForkBeforeTurn } from "./codexAppServerFeatures";
import type { ChatSideChatOutcome } from "../analytics/agentTurnProductAnalytics";
import { claudeSideChatCut } from "./sideChatClaudeCut";

// Side chats (`/side`, shared/sideChat.ts). A read-only fork of a chat, shown
// inside it. Its parent link is its own pair of fields
// (`sideChatParentSessionId` / `sideChatSessionId`), never the spawn lineage:
// a side chat is not a child that reports, wakes or nests.

type SideChatManaged = {
  session: AgentChatSession;
  laneWorktreePath: string;
  deleted: boolean;
  closed: boolean;
  recentConversationEntries: Array<{ role: "user" | "assistant"; text: string; turnId?: string }>;
  /** PDFs and images the Claude history carries; a fork carries them too. */
  claudeRetainedMedia?: ClaudeRetainedMedia;
};

type SideChatLineage = { sideChatParentSessionId?: string; sideChatSessionId?: string };

type SideChatClaudeRuntime = {
  activeTurnId: string | null;
  forkFromSdkSessionId: string | null;
  forkResumeSessionAt?: string | null;
};

/** Provider settings that keep a side chat read-only. Applied at creation and held by `updateSession`. */
export function sideChatReadOnlySettings(provider: AgentChatProvider): Partial<AgentChatCreateArgs> {
  switch (provider) {
    case "claude":
      return { claudePermissionMode: "default", interactionMode: "default" };
    case "codex":
      return { codexApprovalPolicy: "never", codexSandbox: "read-only", codexConfigSource: "flags" };
    case "opencode":
      return { opencodePermissionMode: "plan" };
    case "droid":
      return { droidPermissionMode: "read-only" };
    case "copilot":
      return { copilotPermissionMode: "plan" };
    case "muse":
      return { musePermissionMode: "denyUnmatched" };
    case "pi":
      return { permissionMode: "plan" };
    case "kimi":
      // Kimi's plan mode refuses Write and Edit itself; the ACP fence in
      // `presentAcpPermissionRequest` refuses leaving it.
      return { acpPermissionMode: "plan" };
    default:
      return {};
  }
}

export type SideChatServiceDeps<
  TManaged extends SideChatManaged,
  TClaudeRuntime extends SideChatClaudeRuntime,
  TPersisted extends SideChatLineage & { updatedAt?: string },
> = {
  logger: Logger;
  /** The chat when it is loaded; never loads it. */
  loadedSession: (sessionId: string) => TManaged | undefined;
  ensureManagedSession: (sessionId: string) => TManaged;
  /** Whether the session store has a row for this id. */
  sessionRowExists: (sessionId: string) => boolean;
  /** Whether a parent chat is still there to deliver to. */
  parentChatStillExists: (sessionId: string) => boolean;
  /** The chat's row is archived (the in-memory session never carries it). */
  isChatArchived: (sessionId: string) => boolean;
  /** Content-free analytics hook (`captureChatSideChatAnalytics`); keyed by the main chat. */
  onSideChatOutcome?: (event: { sessionId: string; outcome: ChatSideChatOutcome; provider: string }) => void;
  readPersistedState: (sessionId: string) => TPersisted | null;
  /** Rewrite the chat's state file; throws when the write fails. */
  writePersistedState: (sessionId: string, next: TPersisted) => void;
  persistChatState: (managed: TManaged) => void;
  emitTransientChatEnvelope: (sessionId: string, event: AgentChatEvent) => void;
  emitChatEvent: (managed: TManaged, event: AgentChatEvent) => void;
  readTranscriptEnvelopes: (managed: TManaged, options?: { includeBuffered?: boolean }) => AgentChatEventEnvelope[];
  runtimeMidTurn: (managed: TManaged) => boolean;
  activeTurnIdFor: (managed: TManaged) => string | null;
  hasLivePendingInput: (managed: TManaged) => boolean;
  /** The provider account the chat runs as, which its side chat keeps. */
  instanceIdOf: (managed: TManaged) => string | undefined;
  createSession: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
  deleteSession: (args: { sessionId: string }) => Promise<void>;
  sendMessage: (args: AgentChatSendArgs, options: { routeActiveToSteer: true }) => Promise<unknown>;
  steer: (args: AgentChatSteerArgs, options: { allowPendingInput: true }) => Promise<AgentChatSteerResult>;
  assertChatRuntimeOwnedHere: (sessionId: string, action: string) => void;
  turnInFlightError: (message: string) => Error;
  unsupportedError: (message: string) => Error;
  providerFork: ChatProviderFork<TManaged>;
  claude: {
    ensureRuntime: (managed: TManaged) => TClaudeRuntime;
    /** The runtime's thread id once Claude has written it; a warm-up's is not on disk yet. */
    writtenSessionId: (runtime: TClaudeRuntime) => string | null;
    configHome: (managed: TManaged) => string | null;
    /** End the runtime's query and drop its own thread id. */
    resetQuerySession: (managed: TManaged, runtime: TClaudeRuntime) => Promise<void>;
  };
};

/** Keyed by the failure's provider union, so a new provider needs its message here. */
const SIDE_CHAT_NO_FORK_ID: Record<Extract<ChatProviderForkFailure, { kind: "no_fork_id" }>["provider"], string> = {
  codex: "Codex did not return a thread for the side chat.",
  opencode: "OpenCode did not return a session for the side chat.",
  droid: "Droid did not return a session for the side chat.",
  muse: "Muse did not return a session for the side chat.",
};

export function createSideChatService<
  TManaged extends SideChatManaged,
  TClaudeRuntime extends SideChatClaudeRuntime,
  TPersisted extends SideChatLineage & { updatedAt?: string },
>(deps: SideChatServiceDeps<TManaged, TClaudeRuntime, TPersisted>) {
  const { logger } = deps;

  /** One start per main chat at a time: a phone and a desktop racing `/side` get one side chat. */
  const sideChatStartsInFlight = new Map<string, Promise<TManaged>>();
  /** `<side>:<turn>` already delivered to the main chat. */
  const sideChatForwardedTurns = new Set<string>();

  /**
   * A side chat's first message carries its role (`buildSideChatFirstPrompt`)
   * ahead of what the user typed, whichever surface sent it. The transcript
   * shows only the user's text.
   */
  const withSideChatRole = (managed: TManaged, args: AgentChatSendArgs): AgentChatSendArgs => {
    if (!managed.session.sideChatParentSessionId) return args;
    if (args.metadata?.sideChatRole === true) return args;
    const hasUserTurn = managed.recentConversationEntries.some((entry) => entry.role === "user")
      || deps.readTranscriptEnvelopes(managed, { includeBuffered: true }).some((envelope) => envelope.event.type === "user_message");
    if (hasUserTurn) return args;
    return {
      ...args,
      text: buildSideChatFirstPrompt(args.text),
      displayText: args.displayText ?? args.text,
      metadata: { ...(args.metadata ?? {}), hideFullPrompt: true, sideChatRole: true },
    };
  };

  const sideChatLineageOf = (sessionId: string): SideChatLineage | null =>
    deps.loadedSession(sessionId)?.session ?? deps.readPersistedState(sessionId) ?? null;

  /**
   * Point a main chat at its side chat, or clear it. The lineage merge in
   * `persistChatState` falls back to the file for a key the live session lacks,
   * so the file is rewritten first; otherwise an idle main chat would keep
   * showing a side chat that was ended.
   */
  const writeSideChatPointer = (parent: TManaged, sideSessionId: string | null): void => {
    if (parent.deleted) return;
    const current = deps.readPersistedState(parent.session.id);
    if (current && (current.sideChatSessionId ?? null) !== sideSessionId) {
      const next: TPersisted = { ...current, updatedAt: nowIso() };
      if (sideSessionId) next.sideChatSessionId = sideSessionId;
      else delete next.sideChatSessionId;
      try {
        deps.writePersistedState(parent.session.id, next);
      } catch (error) {
        logger.warn("agent_chat.side_chat_pointer_write_failed", {
          sessionId: parent.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sideSessionId) parent.session.sideChatSessionId = sideSessionId;
    else delete parent.session.sideChatSessionId;
    deps.persistChatState(parent);
    deps.emitTransientChatEnvelope(parent.session.id, { type: "session_meta_updated", sideChatSessionId: sideSessionId });
  };

  /** The main chat's live side chat, or null. A pointer to a chat that is gone is cleared. */
  const liveSideChatOf = (parent: TManaged): TManaged | null => {
    const sideSessionId = parent.session.sideChatSessionId?.trim();
    if (!sideSessionId) return null;
    const side = deps.sessionRowExists(sideSessionId)
      ? deps.loadedSession(sideSessionId) ?? deps.ensureManagedSession(sideSessionId)
      : null;
    if (!side || side.deleted || side.session.sideChatParentSessionId !== parent.session.id) {
      writeSideChatPointer(parent, null);
      return null;
    }
    return side;
  };

  /**
   * Fork the main chat's provider history for its side chat, before the side
   * chat exists, and return how to point the new chat at the fork. A main chat
   * mid-turn forks at its last finished turn where the provider can cut there.
   */
  const forkMainChatForSide = async (parent: TManaged): Promise<ChatProviderForkPointer<TManaged>> => {
    const provider = parent.session.provider;
    const busy = parent.session.status === "active" || deps.runtimeMidTurn(parent);
    if (busy && !providerSupportsSideChatWhileBusy(provider)) {
      throw deps.turnInFlightError(SIDE_CHAT_WAIT_FOR_TURN_MESSAGE);
    }
    const needsHistory = "The main chat has no finished turn yet. Send it a message first, then open a side chat.";
    if (provider === "claude") {
      const runtime = deps.claude.ensureRuntime(parent);
      const sourceSdkSessionId = deps.claude.writtenSessionId(runtime);
      if (!sourceSdkSessionId) throw new Error(needsHistory);
      let resumeAt: string | null = null;
      if (busy) {
        // The running turn's own prompt: a turn a queued steer started has
        // only steer rows, which `findLastTurnUserMessage` skips.
        const envelopes = deps.readTranscriptEnvelopes(parent, { includeBuffered: true });
        const activeTurnId = runtime.activeTurnId;
        const runningText = (activeTurnId
          ? envelopes.find((envelope) => envelope.event.type === "user_message"
            && envelope.event.turnId === activeTurnId
            && envelope.event.deliveryState !== "queued")?.event
          : undefined)
          ?? findLastTurnUserMessage(envelopes)?.event;
        const transcriptPath = resolveClaudeSdkTranscriptPath(sourceSdkSessionId, parent.laneWorktreePath, deps.claude.configHome(parent));
        // Without the running prompt or the session file there is no safe
        // cut, and a whole-file fork would carry the unfinished turn (a tool
        // call with no result): wait for the turn instead.
        if (runningText?.type !== "user_message" || !transcriptPath) {
          throw deps.turnInFlightError(SIDE_CHAT_WAIT_FOR_TURN_MESSAGE);
        }
        let transcript: string;
        try {
          transcript = await fs.promises.readFile(transcriptPath, "utf8");
        } catch {
          throw deps.turnInFlightError(SIDE_CHAT_WAIT_FOR_TURN_MESSAGE);
        }
        const cut = claudeSideChatCut(transcript, runningText.text);
        if (cut.kind === "no_finished_turn") throw new Error(needsHistory);
        if (cut.kind === "cut") resumeAt = cut.uuid;
      }
      return async (created) => {
        const createdRuntime = deps.claude.ensureRuntime(created);
        await deps.claude.resetQuerySession(created, createdRuntime);
        // Only the fork source: the main chat's id must never become this
        // chat's own pointer, or a resume before the first send would write
        // into the main chat's thread.
        createdRuntime.forkFromSdkSessionId = sourceSdkSessionId;
        createdRuntime.forkResumeSessionAt = resumeAt;
        // The fork starts with the main chat's history, documents included.
        if (parent.claudeRetainedMedia) created.claudeRetainedMedia = { ...parent.claudeRetainedMedia };
        deps.persistChatState(created);
      };
    }
    const failure = (refusal: ChatProviderForkFailure): unknown => {
      switch (refusal.kind) {
        case "no_history":
          return new Error(needsHistory);
        case "start_failed":
          return refusal.error;
        case "not_started":
          return new Error("Unable to start OpenCode to fork the main chat.");
        case "busy":
          return deps.turnInFlightError(SIDE_CHAT_WAIT_FOR_TURN_MESSAGE);
        case "no_fork_id":
          return new Error(SIDE_CHAT_NO_FORK_ID[refusal.provider]);
      }
    };
    const pointer = await deps.providerFork.forkProviderHistory(parent, {
      codexGoal: "clear_fork_after",
      codexBeforeTurnId: (serverVersion) => {
        if (!busy) return null;
        const beforeTurnId = deps.activeTurnIdFor(parent);
        if (!beforeTurnId || !codexServerSupportsForkBeforeTurn(serverVersion)) {
          throw deps.turnInFlightError(SIDE_CHAT_WAIT_FOR_TURN_MESSAGE);
        }
        return beforeTurnId;
      },
      museSideChat: { sourceBusy: busy },
      failure,
    });
    if (!pointer) throw deps.unsupportedError(SIDE_CHAT_UNSUPPORTED_MESSAGE);
    return pointer;
  };

  const createSideChat = async (
    parent: TManaged,
    runtimeActor: AgentChatStartSideChatArgs["runtimeActor"],
  ): Promise<TManaged> => {
    // A main chat that was already closed (ended, or loaded idle) can still
    // take a side chat; only one that closes while the fork runs cannot.
    const wasClosed = parent.closed;
    const pointToFork = await forkMainChatForSide(parent);
    const parentSession = parent.session;
    const instanceId = deps.instanceIdOf(parent);
    const created = await deps.createSession({
      laneId: parentSession.laneId,
      ...(runtimeActor ? { runtimeActor } : {}),
      provider: parentSession.provider,
      model: parentSession.model,
      ...(parentSession.modelId ? { modelId: parentSession.modelId } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(parentSession.presetId ? { presetId: parentSession.presetId } : {}),
      ...(parentSession.credentialId ? { credentialId: parentSession.credentialId } : {}),
      title: "Side chat",
      sessionProfile: parentSession.sessionProfile,
      reasoningEffort: parentSession.reasoningEffort ?? null,
      fastMode: parentSession.fastMode === true,
      ...(parentSession.fastMode === true && parentSession.fastTier === "ultrafast" ? { fastTier: "ultrafast" as const } : {}),
      ...(parentSession.provider === "codex" && parentSession.codexDaybreak === true ? { codexDaybreak: true } : {}),
      ...(parentSession.copilotContextTier ? { copilotContextTier: parentSession.copilotContextTier } : {}),
      ...sideChatReadOnlySettings(parentSession.provider),
      surface: parentSession.surface,
      rememberLaunchDefaults: false,
    });
    const side = deps.ensureManagedSession(created.id);
    side.session.sideChatParentSessionId = parentSession.id;
    deps.persistChatState(side);
    try {
      await pointToFork(side);
      deps.persistChatState(side);
      // The main chat may have been deleted or archived while the fork ran;
      // its cleanup could not see this chat yet, so it would stay hidden for good.
      if (parent.deleted || (!wasClosed && parent.closed) || deps.isChatArchived(parent.session.id)) {
        throw new Error("The main chat was closed while its side chat was opening.");
      }
    } catch (error) {
      await deps.deleteSession({ sessionId: side.session.id }).catch((cleanupError: unknown) => {
        logger.warn("agent_chat.side_chat_cleanup_failed", {
          sessionId: side.session.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
      throw error;
    }
    writeSideChatPointer(parent, side.session.id);
    deps.onSideChatOutcome?.({ sessionId: parentSession.id, outcome: "started", provider: parentSession.provider });
    logger.info("agent_chat.side_chat_started", {
      sessionId: side.session.id,
      parentSessionId: parentSession.id,
      provider: parentSession.provider,
    });
    return side;
  };

  const startSideChat = async (args: AgentChatStartSideChatArgs): Promise<AgentChatStartSideChatResult> => {
    const parentId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!parentId) throw new Error("A chat is required to open a side chat.");
    const text = typeof args.text === "string" ? args.text.trim() : "";
    deps.assertChatRuntimeOwnedHere(parentId, "open a side chat for");
    const parent = deps.ensureManagedSession(parentId);
    const unavailable = sideChatUnavailableReason(parent.session);
    if (unavailable) throw deps.unsupportedError(unavailable);

    let side = liveSideChatOf(parent);
    let created = false;
    if (!side) {
      let start = sideChatStartsInFlight.get(parentId);
      if (!start) {
        start = createSideChat(parent, args.runtimeActor);
        sideChatStartsInFlight.set(parentId, start);
        created = true;
        void start.finally(() => sideChatStartsInFlight.delete(parentId)).catch(() => undefined);
      }
      side = await start;
    }
    if (text) {
      await deps.sendMessage({ sessionId: side.session.id, text }, { routeActiveToSteer: true });
    }
    return { session: side.session, created };
  };

  /** Delete a main chat's side chat, if it has one; a failure is logged, not thrown. */
  const deleteSideChatOf = async (mainSessionId: string): Promise<void> => {
    const sideId = sideChatLineageOf(mainSessionId)?.sideChatSessionId?.trim();
    if (!sideId || sideId === mainSessionId) return;
    await deps.deleteSession({ sessionId: sideId }).catch((error: unknown) => {
      logger.warn("agent_chat.side_chat_delete_with_main_failed", {
        sessionId: mainSessionId,
        sideSessionId: sideId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /** Forget which turns of a deleted side chat were already delivered. */
  const forgetForwardedTurnsOf = (sideSessionId: string): void => {
    for (const key of sideChatForwardedTurns) {
      if (key.startsWith(`${sideSessionId}:`)) sideChatForwardedTurns.delete(key);
    }
  };

  const endSideChat = async (args: AgentChatEndSideChatArgs): Promise<AgentChatEndSideChatResult> => {
    const id = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!id) throw new Error("A chat is required to end its side chat.");
    // An End that races a start ends the side chat that start makes, rather
    // than finding none and letting it appear a moment later.
    await sideChatStartsInFlight.get(id)?.catch(() => undefined);
    const lineage = sideChatLineageOf(id);
    const sideId = lineage?.sideChatParentSessionId ? id : lineage?.sideChatSessionId?.trim() || null;
    if (!sideId) return { endedSessionId: null };
    const expected = typeof args.expectedSideSessionId === "string" ? args.expectedSideSessionId.trim() : "";
    if (expected && expected !== sideId) {
      throw new Error("This chat has a different side chat now. Reopen it from Tools, then end it there.");
    }
    await deps.deleteSession({ sessionId: sideId });
    return { endedSessionId: sideId };
  };

  /**
   * When a side chat finishes a turn, deliver each `<send_to_main>` block in
   * its reply to its main chat. A running main turn is steered; an idle main
   * chat starts one.
   */
  const deliverSideChatMessageToMain = async (sideSessionId: string, parentId: string, message: string): Promise<void> => {
    if (!deps.parentChatStillExists(parentId)) throw new Error("The main chat is gone.");
    const parent = deps.ensureManagedSession(parentId);
    if (parent.deleted) throw new Error("The main chat is gone.");
    const text = buildSideChatMainMessage(message);
    const metadata: AgentChatEventMetadata = { sideChat: { sideSessionId }, hideFullPrompt: true };
    const active = parent.session.status === "active" || deps.runtimeMidTurn(parent);
    if (active || deps.hasLivePendingInput(parent)) {
      const provider = parent.session.provider;
      const dispatchMode = !cursorSessionRunsInCloud(parent.session) && supportsActiveTurnDispatchMode(provider, "inline")
        ? "inline"
        : active ? defaultActiveTurnDispatchMode(provider) : "queue";
      const result = await deps.steer({
        sessionId: parentId,
        text,
        displayText: message,
        metadata,
        ...(dispatchMode === "queue" ? {} : { dispatchMode }),
      }, { allowPendingInput: true });
      if (result.reason === "queue_full") throw new Error("The main chat's queue is full.");
      return;
    }
    await deps.sendMessage({ sessionId: parentId, text, displayText: message, metadata }, { routeActiveToSteer: true });
  };

  const forwardSideChatSendsToMain = (side: TManaged, turnId: string | undefined): void => {
    const parentId = side.session.sideChatParentSessionId?.trim();
    if (!parentId) return;
    const resolvedTurnId = turnId?.trim()
      || [...side.recentConversationEntries].reverse().find((entry) => entry.role === "assistant")?.turnId?.trim()
      || "";
    if (!resolvedTurnId) return;
    const key = `${side.session.id}:${resolvedTurnId}`;
    if (sideChatForwardedTurns.has(key)) return;
    const reply = side.recentConversationEntries
      .filter((entry) => entry.role === "assistant" && entry.turnId === resolvedTurnId)
      .map((entry) => entry.text)
      .join("\n");
    const messages = extractSideChatSendToMain(reply);
    if (!messages.length) return;
    sideChatForwardedTurns.add(key);
    void (async () => {
      for (const message of messages) {
        try {
          await deliverSideChatMessageToMain(side.session.id, parentId, message);
          deps.emitChatEvent(side, {
            type: "system_notice",
            noticeKind: "info",
            message: "Sent to the main chat.",
            turnId: resolvedTurnId,
          });
          logger.info("agent_chat.side_chat_sent_to_main", { sessionId: side.session.id, parentSessionId: parentId });
          deps.onSideChatOutcome?.({ sessionId: parentId, outcome: "delivered", provider: side.session.provider });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          deps.emitChatEvent(side, {
            type: "system_notice",
            noticeKind: "warning",
            severity: "warning",
            message: "Couldn't send this to the main chat.",
            detail: reason,
            turnId: resolvedTurnId,
          });
          logger.warn("agent_chat.side_chat_send_to_main_failed", {
            sessionId: side.session.id,
            parentSessionId: parentId,
            error: reason,
          });
          deps.onSideChatOutcome?.({ sessionId: parentId, outcome: "failed", provider: side.session.provider });
        }
      }
    })();
  };

  return {
    withSideChatRole,
    sideChatLineageOf,
    writeSideChatPointer,
    startSideChat,
    endSideChat,
    deleteSideChatOf,
    forgetForwardedTurnsOf,
    forwardSideChatSendsToMain,
  };
}
