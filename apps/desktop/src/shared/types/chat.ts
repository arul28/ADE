// ---------------------------------------------------------------------------
// Agent chat types
// ---------------------------------------------------------------------------

import type { ModelId } from "./core";
import type { CtoCapabilityMode } from "./cto";
import type { ComputerUsePolicy } from "./computerUseArtifacts";
import type { DelegationContract } from "./orchestrator";

export type AgentChatProvider = "codex" | "claude" | "unified" | (string & {});

export type AgentChatSessionStatus = "active" | "idle" | "ended";
export type AgentChatSessionProfile = "light" | "workflow";

export type ChatSurfaceMode = "standard" | "resolver" | "mission-thread" | "mission-feed";
export type ChatSurfaceProfile = "standard" | "persistent_identity";
export type ChatModelSwitchPolicy = "same-family-after-launch" | "any-after-launch";

export type ChatSurfaceChipTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

export type OperatorNavigationSurface = "work" | "missions" | "lanes" | "cto";

export type OperatorNavigationSuggestion = {
  surface: OperatorNavigationSurface;
  label: string;
  href: string;
  laneId?: string | null;
  sessionId?: string | null;
  missionId?: string | null;
};

export type ChatSurfaceChip = {
  label: string;
  tone?: ChatSurfaceChipTone;
};

export type ChatSurfacePresentation = {
  mode: ChatSurfaceMode;
  profile?: ChatSurfaceProfile;
  modelSwitchPolicy?: ChatModelSwitchPolicy;
  title?: string | null;
  subtitle?: string | null;
  accentColor?: string | null;
  assistantLabel?: string | null;
  messagePlaceholder?: string | null;
  chips?: ChatSurfaceChip[];
  showMcpStatus?: boolean;
};

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";
export type AgentChatClaudePermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type AgentChatCodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type AgentChatCodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AgentChatCodexConfigSource = "flags" | "config-toml";
export type AgentChatUnifiedPermissionMode = "plan" | "edit" | "full-auto";

export type AgentChatNoticeDetailMetric = {
  label: string;
  value: string;
  tone?: ChatSurfaceChipTone;
};

export type AgentChatNoticeDetailSection = {
  title: string;
  items: Array<string | AgentChatNoticeDetailMetric>;
};

export type AgentChatNoticeDetail = {
  title?: string;
  summary?: string;
  metrics?: AgentChatNoticeDetailMetric[];
  sections?: AgentChatNoticeDetailSection[];
};

export type AgentChatFileRef = {
  path: string;
  type: "file" | "image";
};

/** Max attachments per parallel multi-lane launch (same refs sent to each child session). */
export const PARALLEL_CHAT_MAX_ATTACHMENTS = 12;

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

export type AgentChatCompletionArtifact = {
  type: string;
  description: string;
  reference?: string;
};

export type AgentChatCompletionStatus = "completed" | "partial" | "blocked";

export type AgentChatCompletionReport = {
  timestamp: string;
  summary: string;
  status: AgentChatCompletionStatus;
  artifacts: AgentChatCompletionArtifact[];
  blockerDescription?: string | null;
};

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      attachments?: AgentChatFileRef[];
      turnId?: string;
      steerId?: string;
      deliveryState?: "queued" | "delivered" | "failed";
      processed?: boolean;
    }
  | {
      type: "text";
      text: string;
      messageId?: string;
      turnId?: string;
      itemId?: string;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      itemId: string;
      logicalItemId?: string;
      parentItemId?: string;
      turnId?: string;
    }
  | {
      type: "tool_result";
      tool: string;
      result: unknown;
      itemId: string;
      logicalItemId?: string;
      parentItemId?: string;
      turnId?: string;
      status?: "running" | "completed" | "failed" | "interrupted";
    }
  | {
      type: "file_change";
      path: string;
      diff: string;
      kind: "create" | "modify" | "delete";
      itemId: string;
      logicalItemId?: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "command";
      command: string;
      cwd: string;
      output: string;
      itemId: string;
      logicalItemId?: string;
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
      logicalItemId?: string;
      kind: "command" | "file_change" | "tool_call";
      description: string;
      turnId?: string;
      detail?: unknown;
    }
  | {
      type: "pending_input_resolved";
      itemId: string;
      resolution: "accepted" | "declined" | "cancelled";
      turnId?: string;
    }
  | {
      type: "status";
      turnStatus: "started" | "completed" | "interrupted" | "failed";
      turnId?: string;
      message?: string;
    }
  | {
      type: "delegation_state";
      contract: DelegationContract;
      message?: string;
      turnId?: string;
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
        cacheReadTokens?: number | null;
        cacheCreationTokens?: number | null;
      };
      costUsd?: number | null;
    }
  | {
      type: "activity";
      activity: "thinking" | "working" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling" | "web_searching" | "spawning_agent";
      detail?: string;
      turnId?: string;
    }
  | {
      type: "step_boundary";
      stepNumber: number;
      turnId?: string;
    }
  | {
      type: "todo_update";
      items: Array<{
        id: string;
        description: string;
        status: "pending" | "in_progress" | "completed";
      }>;
      turnId?: string;
    }
  | {
      type: "subagent_started";
      taskId: string;
      description: string;
      background?: boolean;
      turnId?: string;
    }
  | {
      type: "subagent_progress";
      taskId: string;
      description?: string;
      summary: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
      };
      lastToolName?: string;
      turnId?: string;
    }
  | {
      type: "subagent_result";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
      };
      turnId?: string;
    }
  | {
      type: "structured_question";
      question: string;
      options?: Array<{ label: string; value: string }>;
      itemId: string;
      turnId?: string;
    }
  | {
      type: "tool_use_summary";
      summary: string;
      toolUseIds: string[];
      turnId?: string;
    }
  | {
      type: "context_compact";
      trigger: "manual" | "auto";
      preTokens?: number;
      turnId?: string;
    }
  | {
      type: "system_notice";
      noticeKind: "auth" | "rate_limit" | "hook" | "file_persist" | "info" | "memory" | "provider_health" | "thread_error";
      message: string;
      detail?: string | AgentChatNoticeDetail;
      steerId?: string;
      turnId?: string;
    }
  | {
      type: "completion_report";
      report: AgentChatCompletionReport;
      turnId?: string;
    }
  | {
      type: "web_search";
      query: string;
      action?: string;
      itemId: string;
      logicalItemId?: string;
      turnId?: string;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "auto_approval_review";
      targetItemId: string;
      reviewStatus: "started" | "completed";
      action?: string;
      review?: string;
      turnId?: string;
    }
  | {
      type: "prompt_suggestion";
      suggestion: string;
      turnId?: string;
    }
  | {
      type: "plan_text";
      text: string;
      turnId?: string;
      itemId?: string;
    };

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
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
export type AgentChatInteractionMode = "default" | "plan";
export type AgentChatIdentityKey = "cto" | `agent:${string}`;
export type AgentChatSurface = "work" | "automation";
export type AgentChatCursorConfigValue = string | boolean;
export type AgentChatCursorConfigSelectOption = {
  value: string;
  label: string;
  description?: string | null;
  groupId?: string | null;
  groupLabel?: string | null;
};
export type AgentChatCursorConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue: AgentChatCursorConfigValue | null;
  options?: AgentChatCursorConfigSelectOption[];
};
export type AgentChatCursorModeSnapshot = {
  modeConfigId?: string | null;
  currentModeId: string | null;
  availableModeIds: string[];
  modelConfigId?: string | null;
  currentModelId?: string | null;
  availableModelIds?: string[];
  configOptions?: AgentChatCursorConfigOption[];
};
export type PendingInputSource = "claude" | "codex" | "cursor" | "unified" | "mission" | "ade";
export type PendingInputKind = "approval" | "question" | "structured_question" | "permissions" | "plan_approval";

export type PendingInputOption = {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
};

export type PendingInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: PendingInputOption[] | null;
  multiSelect?: boolean;
  allowsFreeform?: boolean;
  isSecret?: boolean;
  defaultAssumption?: string | null;
  impact?: string | null;
};

export type PendingInputRequest = {
  requestId: string;
  itemId?: string;
  source: PendingInputSource;
  kind: PendingInputKind;
  title?: string | null;
  description?: string | null;
  questions: PendingInputQuestion[];
  allowsFreeform: boolean;
  blocking: boolean;
  canProceedWithoutAnswer: boolean;
  options?: PendingInputOption[];
  providerMetadata?: Record<string, unknown>;
  turnId?: string | null;
};

export type AgentChatSession = {
  id: string;
  laneId: string;
  provider: AgentChatProvider;
  /** Runtime-facing model token (CLI shortId or direct API model id), persisted as a plain string for compatibility. */
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  completion?: AgentChatCompletionReport | null;
  status: AgentChatSessionStatus;
  threadId?: string;
  /** Subdirectory or absolute path under the lane worktree used as cwd; persisted for relaunch/resume. */
  requestedCwd?: string | null;
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
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  completion?: AgentChatCompletionReport | null;
  status: AgentChatSessionStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  awaitingInput?: boolean;
  threadId?: string;
};

export type AgentChatTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  turnId?: string;
};

export type AgentChatSubagentSnapshot = {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  turnId?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  summary?: string;
  lastToolName?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
};

export type AgentChatSubagentListArgs = {
  sessionId: string;
};

export type AgentChatSessionCapabilities = {
  supportsSubagentInspection: boolean;
  supportsSubagentControl: boolean;
  supportsReviewMode: boolean;
};

export type AgentChatSessionCapabilitiesArgs = {
  sessionId: string;
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
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  computerUse?: ComputerUsePolicy | null;
  requestedCwd?: string;
};

export type AgentChatHandoffArgs = {
  sourceSessionId: string;
  targetModelId: ModelId;
};

export type AgentChatHandoffResult = {
  session: AgentChatSession;
  usedFallbackSummary: boolean;
};

export type AgentChatListArgs = {
  laneId?: string;
  includeAutomation?: boolean;
};

export type AgentChatSuggestLaneNameArgs = {
  /** Lane the user is launching from (worktree path for the naming model call). */
  laneId: string;
  /** User prompt for the parallel chat launch (used to derive a short lane name prefix). */
  prompt: string;
  /** Registry model ID used to run the naming call (e.g. first selected model). */
  modelId: string;
};

export type AgentChatGetSummaryArgs = {
  sessionId: string;
};

export type AgentChatSendArgs = {
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  interactionMode?: AgentChatInteractionMode | null;
};

export type AgentChatSteerArgs = {
  sessionId: string;
  text: string;
};

export type AgentChatSteerResult = {
  steerId: string;
  queued: boolean;
};

export type AgentChatCancelSteerArgs = {
  sessionId: string;
  steerId: string;
};

export type AgentChatEditSteerArgs = {
  sessionId: string;
  steerId: string;
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

export type AgentChatRespondToInputArgs = {
  sessionId: string;
  itemId: string;
  decision?: AgentChatApprovalDecision;
  answers?: Record<string, string | string[]>;
  responseText?: string | null;
};

export type AgentChatModelsArgs = {
  provider: AgentChatProvider;
};

export type AgentChatDisposeArgs = {
  sessionId: string;
};

export type AgentChatUpdateSessionArgs = {
  sessionId: string;
  title?: string | null;
  manuallyNamed?: boolean;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  computerUse?: ComputerUsePolicy | null;
};

export type AgentChatSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "local";
};

export type AgentChatSlashCommandsArgs = {
  sessionId: string;
};

export type AgentChatFileSearchArgs = {
  sessionId: string;
  query: string;
};

export type AgentChatFileSearchResult = {
  path: string;
  score?: number;
};
