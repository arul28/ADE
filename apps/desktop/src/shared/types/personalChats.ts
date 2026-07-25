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
  AgentChatDispatchSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatModelCatalog,
  AgentChatModelCatalogArgs,
  AgentChatRecoverTurnArgs,
  AgentChatRecoverTurnResult,
  AgentChatResolveUnprocessedMessageArgs,
  AgentChatResolveUnprocessedMessageResult,
  AgentChatRespondToInputArgs,
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
  "dispatchSteer",
  "cancelDispatchedSteer",
  "interrupt",
  "recoverTurn",
  "resolveUnprocessedMessage",
  "respondToInput",
  "approve",
  "createScheduledWork",
  "cancelScheduledWork",
  "setScheduledWorkPaused",
  "updateSession",
  "archive",
  "unarchive",
  "delete",
  "models",
  "modelCatalog",
  "getEventHistory",
  "getEventHistoryPage",
  "terminalCreate",
  "terminalWrite",
  "terminalResize",
  "terminalDispose",
  "saveTempAttachment",
  "getImageDataUrl",
] as const;

export type PersonalChatAction = (typeof PERSONAL_CHAT_ACTIONS)[number];

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
  // paired viewers. Creating new unattended work remains owner-only.
  return action !== "createScheduledWork";
}

export type PersonalChatCreateArgs = Omit<
  AgentChatCreateArgs,
  | "laneId"
  | "sessionProfile"
  | "identityKey"
  | "surface"
  | "automationId"
  | "automationRunId"
  | "requestedCwd"
  | "orchestrationRunId"
  | "orchestrationRole"
  | "orchestrationParentSessionId"
  | "orchestrationTag"
  | "orchestrationStepId"
  | "orchestrationBundlePath"
> & { kickoffText?: string };

export type PersonalChatCallArgs =
  | { action: "list"; args?: { includeArchived?: boolean } }
  | { action: "create"; args: PersonalChatCreateArgs }
  | { action: "getSummary"; args: { sessionId: string } }
  | { action: "read"; args: { sessionId: string; limit?: number; since?: string } }
  | { action: "send"; args: AgentChatSendArgs }
  | { action: "steer"; args: AgentChatSteerArgs }
  | { action: "cancelSteer"; args: AgentChatCancelSteerArgs }
  | { action: "editSteer"; args: AgentChatEditSteerArgs }
  | { action: "dispatchSteer"; args: AgentChatDispatchSteerArgs }
  | { action: "cancelDispatchedSteer"; args: AgentChatCancelDispatchedSteerArgs }
  | { action: "interrupt"; args: AgentChatInterruptArgs }
  | { action: "recoverTurn"; args: AgentChatRecoverTurnArgs }
  | { action: "resolveUnprocessedMessage"; args: AgentChatResolveUnprocessedMessageArgs }
  | { action: "respondToInput"; args: AgentChatRespondToInputArgs }
  | { action: "approve"; args: AgentChatApproveArgs }
  | { action: "createScheduledWork"; args: AgentChatCreateScheduledWorkArgs }
  | { action: "cancelScheduledWork"; args: AgentChatCancelScheduledWorkArgs }
  | { action: "setScheduledWorkPaused"; args: AgentChatSetScheduledWorkPausedArgs }
  | { action: "updateSession"; args: AgentChatUpdateSessionArgs }
  | { action: "archive" | "unarchive" | "delete"; args: { sessionId: string } }
  | { action: "models"; args?: { provider?: string } }
  | { action: "modelCatalog"; args?: AgentChatModelCatalogArgs }
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
  | { action: "getImageDataUrl"; args: { path: string } };

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
};

export type PersonalChatStreamEventsArgs = {
  cursor?: number;
  limit?: number;
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
