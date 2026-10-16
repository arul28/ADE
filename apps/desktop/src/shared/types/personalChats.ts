import type {
  AgentChatApproveArgs,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatCancelScheduledWorkArgs,
  AgentChatCancelScheduledWorkResult,
  AgentChatCancelSteerArgs,
  AgentChatCreateArgs,
  AgentChatCreateScheduledWorkArgs,
  AgentChatCreateScheduledWorkResult,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatInterruptArgs,
  AgentChatStopTaskArgs,
  AgentChatRestoreCancelledQueueArgs,
  AgentChatDispatchSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatMoveSteerArgs,
  AgentChatModelCatalog,
  AgentChatModelCatalogArgs,
  AgentChatProvider,
  AgentChatSlashCommand,
  PendingInputRequest,
  AgentChatRecoverTurnArgs,
  AgentChatRecoverTurnResult,
  AgentChatResolveUnprocessedMessageArgs,
  AgentChatResolveUnprocessedMessageResult,
  AgentChatRespondToInputArgs,
  AgentChatResumeUsageLimitNowArgs,
  AgentChatContinueUsageLimitOnAlternateArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatSetScheduledWorkPausedArgs,
  AgentChatSetScheduledWorkPausedResult,
  AgentChatUpdateSessionArgs,
} from "./chat";
import type { RemoteRuntimeStreamEventsResult } from "./remoteRuntime";
import type { PtyCreateResult, PtyDisposeResult } from "./sessions";

export const PERSONAL_CHAT_ACTIONS = [
  "list",
  "create",
  "getSummary",
  "read",
  "send",
  "steer",
  "cancelSteer",
  "editSteer",
  "moveSteer",
  "dispatchSteer",
  "cancelDispatchedSteer",
  "interrupt",
  "interruptWithQueueMode",
  "stopTask",
  "restoreCancelledQueue",
  "recoverTurn",
  "resolveUnprocessedMessage",
  "respondToInput",
  "approve",
  "pendingInputs",
  "createScheduledWork",
  "cancelScheduledWork",
  "setScheduledWorkPaused",
  "resumeUsageLimitNow",
  "continueUsageLimitOnAlternate",
  "updateSession",
  "setPinned",
  "rerunLastTurn",
  "archive",
  "unarchive",
  "delete",
  "models",
  "modelCatalog",
  "slashCommands",
  "getEventHistory",
  "getEventHistoryPage",
  "terminalCreate",
  "terminalWrite",
  "terminalResize",
  "terminalDispose",
  "saveTempAttachment",
  "getImageDataUrl",
  // The agent's own Chats-row reports (`ade chat activity|note|ask` from inside
  // a personal chat). The personal runtime has no socket of its own, so these
  // reach it through the brain like every other personal action.
  "setSessionActivity",
  "setSessionStatusNote",
  "requestSessionAttention",
] as const;

export type PersonalChatAction = (typeof PERSONAL_CHAT_ACTIONS)[number];

/** The most `attachmentRoots` one personal chat may name. */
export const MAX_PERSONAL_CHAT_ATTACHMENT_ROOTS = 32;

export type PersonalChatRemoteCommandAction =
  | `personalChats.${PersonalChatAction}`
  | "personalChats.streamEvents";

export function isPersonalChatActionQueueable(action: PersonalChatAction): boolean {
  // A queued create has no stable optimistic session id to return to clients,
  // so retrying after the host reconnects can create duplicate conversations.
  return action === "send";
}

export function isPersonalChatActionViewerAllowed(action: PersonalChatAction): boolean {
  // Cancellation and pause/resume are explicit recovery affordances for
  // paired viewers. Creating new unattended work remains owner-only, and so
  // does spending a provider turn: resuming now, or continuing on another
  // account, both use the owner's quota rather than merely cancelling something.
  return action !== "createScheduledWork"
    && action !== "resumeUsageLimitNow"
    && action !== "continueUsageLimitOnAlternate";
}

/**
 * `requestedCwd` is deliberately NOT omitted. A personal chat's agent runs in
 * the runtime's own 0700 scratch workspace, which is the right default for a
 * general tool and the wrong one for a host whose value is acting on the user's
 * own files — a file written there is, to that user, gone. The scope validates
 * the path before forwarding it (absolute, not a filesystem or drive root, not
 * the home directory itself, not inside the runtime's own state).
 */
export type PersonalChatCreateArgs = Omit<
  AgentChatCreateArgs,
  | "laneId"
  | "sessionProfile"
  | "identityKey"
  | "surface"
  | "automationId"
  | "automationRunId"
  | "orchestrationParentSessionId"
> & { kickoffText?: string };

/**
 * Sent by ADE's own Chats surfaces (desktop, web, iOS, `ade chat --personal`)
 * on the calls that use a chat. A chat written before profiles existed (no
 * `personalProfile`) becomes an `assistant` chat the first time one of these
 * claims it; an explicit `embedded` chat, and any chat on an embedded-profile
 * runtime, never does. An SDK host never sends it.
 */
export type PersonalChatAssistantClaim = { personalProfile?: "assistant" };

export type PersonalChatCallArgs =
  | { action: "list"; args?: { includeArchived?: boolean } }
  | { action: "create"; args: PersonalChatCreateArgs }
  | { action: "getSummary"; args: { sessionId: string } & PersonalChatAssistantClaim }
  | { action: "read"; args: { sessionId: string; limit?: number; since?: string } }
  | { action: "send"; args: AgentChatSendArgs & PersonalChatAssistantClaim }
  | { action: "steer"; args: AgentChatSteerArgs & PersonalChatAssistantClaim }
  | { action: "cancelSteer"; args: AgentChatCancelSteerArgs }
  | { action: "editSteer"; args: AgentChatEditSteerArgs }
  | { action: "moveSteer"; args: AgentChatMoveSteerArgs }
  | { action: "dispatchSteer"; args: AgentChatDispatchSteerArgs }
  | { action: "cancelDispatchedSteer"; args: AgentChatCancelDispatchedSteerArgs }
  | { action: "interrupt"; args: AgentChatInterruptArgs }
  | { action: "interruptWithQueueMode"; args: AgentChatInterruptArgs }
  | { action: "stopTask"; args: AgentChatStopTaskArgs }
  | { action: "restoreCancelledQueue"; args: AgentChatRestoreCancelledQueueArgs }
  | { action: "recoverTurn"; args: AgentChatRecoverTurnArgs }
  | { action: "resolveUnprocessedMessage"; args: AgentChatResolveUnprocessedMessageArgs }
  | { action: "respondToInput"; args: AgentChatRespondToInputArgs }
  | { action: "approve"; args: AgentChatApproveArgs }
  | { action: "pendingInputs"; args: { sessionId: string } }
  | { action: "createScheduledWork"; args: AgentChatCreateScheduledWorkArgs }
  | { action: "cancelScheduledWork"; args: AgentChatCancelScheduledWorkArgs }
  | { action: "setScheduledWorkPaused"; args: AgentChatSetScheduledWorkPausedArgs }
  | { action: "resumeUsageLimitNow"; args: AgentChatResumeUsageLimitNowArgs }
  | { action: "continueUsageLimitOnAlternate"; args: AgentChatContinueUsageLimitOnAlternateArgs }
  | { action: "updateSession"; args: AgentChatUpdateSessionArgs }
  /** Pin or unpin a chat in the rail. `list` rows carry `pinned: true` when pinned. */
  | { action: "setPinned"; args: { sessionId: string; pinned: boolean } }
  | { action: "archive" | "unarchive" | "delete"; args: { sessionId: string } }
  | { action: "models"; args?: { provider?: string } }
  | { action: "modelCatalog"; args?: AgentChatModelCatalogArgs }
  /** The composer's slash commands for one chat, or for a provider before a chat exists. */
  | { action: "slashCommands"; args: { sessionId?: string; provider?: AgentChatProvider | null } }
  | { action: "getEventHistory"; args: { sessionId: string; maxEvents?: number; maxBytes?: number } }
  | { action: "getEventHistoryPage"; args: { sessionId: string; beforeOffset: number; maxBytes?: number } }
  | { action: "terminalCreate"; args?: { chatSessionId?: string | null; cols?: number; rows?: number } }
  | { action: "terminalWrite"; args: { ptyId: string; data: string } }
  | { action: "terminalResize"; args: { ptyId: string; cols: number; rows: number } }
  | { action: "terminalDispose"; args: { ptyId: string; sessionId: string } }
  | {
      action: "saveTempAttachment";
      args: {
        dataUrl?: string;
        base64?: string;
        data?: string;
        filename?: string;
        mime?: string;
        mimeType?: string;
      };
    }
  | { action: "getImageDataUrl"; args: { path: string } }
  /** Activity value (`SESSION_ACTIVITY_VALUES`), or null to clear. */
  | { action: "setSessionActivity"; args: { sessionId: string; value: string | null } }
  | { action: "setSessionStatusNote"; args: { sessionId: string; note: string } }
  | { action: "requestSessionAttention"; args: { sessionId: string; message: string } };

/** Result of the `pendingInputs` action: every request still awaiting an answer. */
export type PersonalChatPendingInputsResult = {
  requests: PendingInputRequest[];
};

export type PersonalChatCallResult =
  | AgentChatSession
  | AgentChatSessionSummary
  | AgentChatSessionSummary[]
  | AgentChatEventHistorySnapshot
  | AgentChatEventHistoryPage
  | AgentChatCreateScheduledWorkResult
  | AgentChatCancelScheduledWorkResult
  | AgentChatSetScheduledWorkPausedResult
  | AgentChatRecoverTurnResult
  | AgentChatResolveUnprocessedMessageResult
  | AgentChatModelCatalog
  | AgentChatSlashCommand[]
  | PersonalChatPendingInputsResult
  | PtyCreateResult
  | PtyDisposeResult
  | unknown;

export type PersonalChatCallResponse = {
  action: PersonalChatAction;
  result: PersonalChatCallResult;
};

export type PersonalChatCapabilities = {
  version: 1;
  actions: PersonalChatAction[];
  /**
   * The runtime supports `personalChats.subscribeEvents` push notifications on
   * this connection, so a client can stop polling `streamEvents`. Optional: an
   * older runtime omits it and the client keeps draining.
   */
  pushEvents?: boolean;
  /**
   * `create` accepts `mcpServers` / `strictMcpConfig` (caller-injected MCP).
   * Optional for the same reason — absent means an older runtime that would
   * silently ignore them.
   */
  mcpServers?: boolean;
  /**
   * `updateSession` accepts `mcpServers` for a personal chat and replaces the
   * caller servers wholesale (restarting the provider on the next turn). Absent
   * on runtimes before 1.2.81, which ignore the field.
   */
  updateMcpServers?: boolean;
};

export type PersonalChatStreamEventsArgs = {
  cursor?: number;
  limit?: number;
};

export type PersonalChatSubscribeEventsArgs = {
  category?: string;
  cursor?: number;
  limit?: number;
  /** Replay buffered events before the live stream. Defaults to true. */
  replay?: boolean;
};

export type PersonalChatSubscribeEventsResult = {
  subscriptionId: string;
  nextCursor: number;
  hasMore: boolean;
  eventEpoch: string;
  gap: boolean;
  oldestCursor: number | null;
};

export type PersonalChatStreamEventsResult = RemoteRuntimeStreamEventsResult;

/** Backend contract shared by machine RPC and both sync-host ingress paths. */
export type PersonalChatScopeContract = {
  capabilities(): PersonalChatCapabilities;
  call(action: unknown, args: unknown, signal?: AbortSignal): Promise<PersonalChatCallResponse>;
  streamEvents(args: unknown): Promise<PersonalChatStreamEventsResult>;
  transcriptPath(sessionId: unknown): Promise<string | null>;
  isTurnActive(sessionId: unknown): Promise<boolean>;
};
