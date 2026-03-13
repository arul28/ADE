// ---------------------------------------------------------------------------
// Agent chat types
// ---------------------------------------------------------------------------

import type { ModelId } from "./core";
import type { CtoCapabilityMode } from "./cto";
import type { ComputerUsePolicy } from "./computerUseArtifacts";

export type AgentChatProvider = "codex" | "claude" | "unified" | (string & {});

export type AgentChatSessionStatus = "active" | "idle" | "ended";
export type AgentChatSessionProfile = "light" | "workflow";

export type ChatSurfaceMode = "standard" | "resolver" | "mission-thread" | "mission-feed";

export type ChatSurfaceChipTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

export type ChatSurfaceChip = {
  label: string;
  tone?: ChatSurfaceChipTone;
};

export type ChatSurfacePresentation = {
  mode: ChatSurfaceMode;
  title?: string | null;
  subtitle?: string | null;
  accentColor?: string | null;
  chips?: ChatSurfaceChip[];
  showMcpStatus?: boolean;
};

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";

export type AgentChatFileRef = {
  path: string;
  type: "file" | "image";
};

/** Infer whether a file path points to an image or a generic file. */
export function inferAttachmentType(
  filePath: string,
  mimeType?: string | null,
): AgentChatFileRef["type"] {
  if (mimeType?.startsWith("image/")) return "image";
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(filePath) ? "image" : "file";
}

/** Merge two attachment lists, deduplicating by path (last-write wins). */
export function mergeAttachments(
  current: AgentChatFileRef[],
  incoming: AgentChatFileRef[],
): AgentChatFileRef[] {
  const deduped = new Map<string, AgentChatFileRef>();
  for (const attachment of current) deduped.set(attachment.path, attachment);
  for (const attachment of incoming) {
    if (!attachment.path.trim().length) continue;
    deduped.set(attachment.path, attachment);
  }
  return [...deduped.values()];
}

export type AgentChatPlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      attachments?: AgentChatFileRef[];
      turnId?: string;
      deliveryState?: "queued" | "delivered" | "failed";
      processed?: boolean;
    }
  | {
      type: "text";
      text: string;
      turnId?: string;
      itemId?: string;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      itemId: string;
      parentItemId?: string;
      turnId?: string;
    }
  | {
      type: "tool_result";
      tool: string;
      result: unknown;
      itemId: string;
      parentItemId?: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "file_change";
      path: string;
      diff: string;
      kind: "create" | "modify" | "delete";
      itemId: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "command";
      command: string;
      cwd: string;
      output: string;
      itemId: string;
      turnId?: string;
      exitCode?: number | null;
      durationMs?: number | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "plan";
      steps: AgentChatPlanStep[];
      turnId?: string;
      explanation?: string | null;
    }
  | {
      type: "reasoning";
      text: string;
      turnId?: string;
      itemId?: string;
      summaryIndex?: number;
    }
  | {
      type: "approval_request";
      itemId: string;
      kind: "command" | "file_change" | "tool_call";
      description: string;
      turnId?: string;
      detail?: unknown;
    }
  | {
      type: "status";
      turnStatus: "started" | "completed" | "interrupted" | "failed";
      turnId?: string;
      message?: string;
    }
  | {
      type: "error";
      message: string;
      turnId?: string;
      itemId?: string;
      errorInfo?: string | {
        category: "auth" | "rate_limit" | "budget" | "network" | "unknown";
        provider?: string;
        model?: string;
      };
    }
  | {
      type: "done";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      model?: string;
      modelId?: ModelId;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
      };
    }
  | {
      type: "activity";
      activity: "thinking" | "working" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling";
      detail?: string;
      turnId?: string;
    }
  | {
      type: "step_boundary";
      stepNumber: number;
      turnId?: string;
    };

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  provenance?: {
    messageId?: string;
    threadId?: string | null;
    role?: "user" | "orchestrator" | "worker" | "agent" | null;
    targetKind?: string | null;
    sourceSessionId?: string | null;
    attemptId?: string | null;
    stepKey?: string | null;
    laneId?: string | null;
    runId?: string | null;
  };
};

export type AgentChatPermissionMode = "default" | "plan" | "edit" | "full-auto" | "config-toml";
export type AgentChatExecutionMode = "focused" | "parallel" | "subagents" | "teams";
export type AgentChatIdentityKey = "cto" | `agent:${string}`;

export type AgentChatSession = {
  id: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  identityKey?: AgentChatIdentityKey;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  status: AgentChatSessionStatus;
  threadId?: string;
  createdAt: string;
  lastActivityAt: string;
};

export type AgentChatSessionSummary = {
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  title?: string | null;
  goal?: string | null;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  identityKey?: AgentChatIdentityKey;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  status: AgentChatSessionStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  threadId?: string;
};

export type AgentChatModelInfo = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault: boolean;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
  maxThinkingTokens?: number | null;
  // New unified fields
  modelId?: ModelId;
  family?: string;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  color?: string;
};

export type AgentChatCreateArgs = {
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
  identityKey?: AgentChatIdentityKey;
  computerUse?: ComputerUsePolicy | null;
};

export type AgentChatListArgs = {
  laneId?: string;
};

export type AgentChatSendArgs = {
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
};

export type AgentChatSteerArgs = {
  sessionId: string;
  text: string;
};

export type AgentChatInterruptArgs = {
  sessionId: string;
};

export type AgentChatResumeArgs = {
  sessionId: string;
};

export type AgentChatApproveArgs = {
  sessionId: string;
  itemId: string;
  decision: AgentChatApprovalDecision;
  responseText?: string | null;
};

export type AgentChatModelsArgs = {
  provider: AgentChatProvider;
};

export type AgentChatDisposeArgs = {
  sessionId: string;
};

export type AgentChatChangePermissionModeArgs = {
  sessionId: string;
  permissionMode: AgentChatPermissionMode;
};

export type AgentChatUpdateSessionArgs = {
  sessionId: string;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
  computerUse?: ComputerUsePolicy | null;
};

export type ContextPackScope = "project" | "lane" | "conflict" | "plan" | "mission" | "feature";

export type ContextPackOption = {
  scope: ContextPackScope;
  label: string;
  description: string;
  available: boolean;
  laneId?: string;
  featureKey?: string;
  missionId?: string;
};

export type ContextPackFetchArgs = {
  scope: ContextPackScope;
  laneId?: string;
  featureKey?: string;
  missionId?: string;
  level?: "brief" | "standard" | "detailed";
};

export type ContextPackFetchResult = {
  scope: ContextPackScope;
  content: string;
  truncated: boolean;
};

export type ContextPackListArgs = {
  laneId?: string;
};
