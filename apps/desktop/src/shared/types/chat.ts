// ---------------------------------------------------------------------------
// Agent chat types
// ---------------------------------------------------------------------------

import type { ModelId } from "./core";
import type { CtoCapabilityMode } from "./cto";
import type { FileDiff } from "./git";
import type { LaneLinearIssue } from "./lanes";
import type { DelegationContract } from "./orchestrator";

export type AgentChatProvider = "codex" | "claude" | "cursor" | "droid" | "opencode" | (string & {});

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
  rewriteMissionControlTextTools?: boolean;
};

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";
export type AgentChatClaudePermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type AgentChatCodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type AgentChatCodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AgentChatCodexConfigSource = "flags" | "config-toml";
export type AgentChatOpenCodePermissionMode = "plan" | "edit" | "full-auto";
export type AgentChatDroidPermissionMode = "read-only" | "auto-low" | "auto-medium" | "auto-high";

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
  permissionModeTransition?: "entered_plan_mode" | "exited_plan_mode";
};

export type AgentChatLocalFileRef = {
  path: string;
  type: "file" | "image";
};

export type AgentChatImageUrlRef = {
  path: string;
  type: "image-url";
  url: string;
};

export type AgentChatFileRef = AgentChatLocalFileRef | AgentChatImageUrlRef;

export type AgentChatLinearIssueContextAttachment = {
  type: "linear_issue";
  issue: LaneLinearIssue;
  source?: "manual" | "lane_link";
  attachedAt?: string;
};

export type AgentChatContextAttachment = AgentChatLinearIssueContextAttachment;

/** Max attachments per parallel multi-lane launch (same refs sent to each child session). */
export const PARALLEL_CHAT_MAX_ATTACHMENTS = 12;

/** Infer whether a file path points to an image or a generic file. */
export function inferAttachmentType(
  filePath: string,
  mimeType?: string | null,
): AgentChatLocalFileRef["type"] {
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

export type CodexPlanState = "active" | "delta" | "updated" | "complete";

export type CodexWebSearchAction = {
  type: string;
  status?: "pending" | "running" | "completed" | "failed";
  query?: string;
  url?: string;
  title?: string;
  snippet?: string;
};

export type CodexTokenUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

export type CodexThreadTokenUsage = {
  threadId?: string | null;
  turnId?: string | null;
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
};

export type CodexThreadGoalStatus = "active" | "paused" | "budget_limited" | "complete" | "cancelled" | "unknown";

export type CodexThreadGoal = {
  objective?: string | null;
  tokenBudget?: number | null;
  status?: CodexThreadGoalStatus;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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

export type AgentChatRuntime = "local" | "cloud";

export type AgentChatCloudRunStatus =
  | "creating"
  | "running"
  | "finished"
  | "error"
  | "cancelled"
  | "expired";

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
      contextAttachments?: AgentChatContextAttachment[];
      turnId?: string;
      steerId?: string;
      deliveryState?: "queued" | "delivered" | "inline" | "failed";
      processed?: boolean;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "text";
      text: string;
      messageId?: string;
      turnId?: string;
      itemId?: string;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      itemId: string;
      logicalItemId?: string;
      parentItemId?: string;
      turnId?: string;
      runtime?: AgentChatRuntime;
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
      runtime?: AgentChatRuntime;
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
      runtime?: AgentChatRuntime;
    }
  | {
      type: "plan";
      steps: AgentChatPlanStep[];
      turnId?: string;
      explanation?: string | null;
      itemId?: string;
      state?: CodexPlanState;
      streamingText?: string;
    }
  | {
      type: "reasoning";
      text: string;
      turnId?: string;
      itemId?: string;
      summaryIndex?: number;
      runtime?: AgentChatRuntime;
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
      detail?: string;
      turnId?: string;
      itemId?: string;
      errorInfo?: string | {
        category: "auth" | "rate_limit" | "budget" | "network" | "unknown" | "agent_cli_missing" | "agent_cli_auth";
        provider?: string;
        model?: string;
        agentCli?: {
          agent: string;
          displayName: string;
          category: "missing" | "unauthenticated";
          installCommand: string;
          authCommand: string;
        };
      };
      runtime?: AgentChatRuntime;
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
      // Set only at render time when multiple done events from one cancellation
      // (parent + subagents) are consolidated into a single row.
      subagentStoppedCount?: number;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "activity";
      activity: "thinking" | "working" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling" | "web_searching" | "spawning_agent";
      detail?: string;
      turnId?: string;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "tokens";
      turnId: string;
      itemId?: string;
      runtime?: AgentChatRuntime;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      contextWindow?: number;
    }
  | {
      type: "cloud_artifact";
      turnId: string;
      itemId: string;
      agentId: string;
      runId: string;
      path: string;
      lanePath: string;
      mimeType?: string | null;
      sizeBytes?: number;
    }
  | {
      type: "cloud_status";
      turnId: string;
      runId: string;
      status: AgentChatCloudRunStatus;
      detail?: string | null;
      gitBranch?: string | null;
      prUrl?: string | null;
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
      type: "codex_context_compaction";
      turnId: string;
      state: "started" | "completed";
      trigger: "manual" | "auto";
    }
  | {
      type: "system_notice";
      noticeKind: "auth" | "rate_limit" | "hook" | "file_persist" | "info" | "memory" | "provider_health" | "thread_error" | "warning" | "error" | "config";
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
      actions?: CodexWebSearchAction[];
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
      type: "codex_image_generation";
      itemId: string;
      turnId?: string;
      prompt?: string | null;
      revisedPrompt?: string | null;
      result?: string | null;
      /** Local filesystem path if Codex saved the image to disk; null when the result is purely a URL/data URI. */
      savedPath?: string | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_image_view";
      itemId: string;
      turnId?: string;
      path?: string | null;
      url?: string | null;
      title?: string | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_token_usage";
      usage: CodexThreadTokenUsage;
      turnId?: string;
    }
  | {
      type: "codex_goal_updated";
      goal: CodexThreadGoal | null;
      turnId?: string;
    }
  | {
      type: "codex_goal_cleared";
      turnId?: string;
    }
  | {
      type: "turn_diff_summary";
      turnId: string;
      beforeSha: string;
      afterSha: string;
      files: TurnDiffFile[];
      totalAdditions: number;
      totalDeletions: number;
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
export type AgentChatSurface = "work" | "automation" | "mission";
export type AgentChatCursorConfigValue = string | boolean | number;
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
export type PendingInputSource = "claude" | "codex" | "cursor" | "droid" | "opencode" | "mission" | "ade";
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
  codexFastMode?: boolean;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
  /** Durable Cursor Cloud agent id once this session has been promoted to cloud. */
  cursorCloudAgentId?: string;
  /** Default runtime for new turns in this session (set on promotion). */
  cursorRuntime?: AgentChatRuntime;
  /** Turn id at which the session was first promoted to cloud (renders the system bubble). */
  cursorPromotedTurnId?: string;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  completion?: AgentChatCompletionReport | null;
  codexGoal?: CodexThreadGoal | null;
  codexTokenUsage?: CodexThreadTokenUsage | null;
  runtimeMode?: AgentChatRuntimeMode;
  status: AgentChatSessionStatus;
  idleSinceAt?: string | null;
  archivedAt?: string | null;
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
  codexFastMode?: boolean;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  cursorCloudAgentId?: string;
  cursorRuntime?: AgentChatRuntime;
  cursorPromotedTurnId?: string;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  completion?: AgentChatCompletionReport | null;
  codexGoal?: CodexThreadGoal | null;
  codexTokenUsage?: CodexThreadTokenUsage | null;
  status: AgentChatSessionStatus;
  idleSinceAt?: string | null;
  startedAt: string;
  endedAt: string | null;
  archivedAt?: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  awaitingInput?: boolean;
  threadId?: string;
  requestedCwd?: string | null;
};

export type AgentChatTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  displayText?: string;
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
  serviceTiers?: string[];
  maxThinkingTokens?: number | null;
  // OpenCode-backed model metadata
  modelId?: ModelId;
  family?: string;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  color?: string;
};

export type AgentChatModelCatalogModel = AgentChatModelInfo & {
  /** Canonical ADE registry id used for update/create calls. */
  id: ModelId;
  /** Provider/runtime model ref ADE sends under the hood. */
  runtimeModelId: string;
  provider: AgentChatProvider;
  providerKey: string;
  groupKey: AgentChatProvider;
  isAvailable: boolean;
};

export type AgentChatModelCatalogSubsection = {
  key: string;
  label: string;
  models: AgentChatModelCatalogModel[];
};

export type AgentChatModelCatalogProvider = {
  key: string;
  displayName: string;
  badgeColor: string;
  modelCount: number;
  subsections: AgentChatModelCatalogSubsection[];
};

export type AgentChatModelCatalogGroup = {
  key: AgentChatProvider;
  displayName: string;
  providers: AgentChatModelCatalogProvider[];
};

export type AgentChatModelCatalog = {
  groups: AgentChatModelCatalogGroup[];
  fetchedAt: string;
};

export type AgentChatCreateArgs = {
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  title?: string | null;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  openInUi?: boolean;
  requestedCwd?: string;
  runtimeMode?: AgentChatRuntimeMode;
};

export type AgentChatRuntimeMode = "interactive" | "print";

export type AgentChatHandoffArgs = {
  sourceSessionId: string;
  targetModelId: ModelId;
  /**
   * When set (including `null` for "no extra reasoning"), combined with the target
   * model to pick a valid reasoning tier. When omitted, inherits from the source
   * session the same way as a legacy handoff.
   */
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  permissionMode?: AgentChatPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
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

export type AgentChatParallelLaunchStateStatus =
  | "creating_lanes"
  | "sending"
  | "completed"
  | "cleanup_pending";

export type AgentChatParallelLaunchState = {
  parentLaneId: string;
  createdLaneIds: string[];
  sentLaneIds: string[];
  status: AgentChatParallelLaunchStateStatus;
  updatedAt: string;
  lastError?: string | null;
};

export type AgentChatParallelLaunchStateArgs = {
  projectRoot: string;
  parentLaneId: string;
};

export type AgentChatSetParallelLaunchStateArgs = AgentChatParallelLaunchStateArgs & {
  state: AgentChatParallelLaunchState | null;
};

export type AgentChatGetSummaryArgs = {
  sessionId: string;
};

export type AgentChatCloudOverrides = {
  repoUrl?: string;
  startingRef?: string | null;
  autoCreatePR?: boolean;
  workOnCurrentBranch?: boolean;
  prUrl?: string | null;
  skipReviewerRequest?: boolean;
};

export type AgentChatSendArgs = {
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  interactionMode?: AgentChatInteractionMode | null;
  /** Selected runtime for this send. Omit to use the session default (cloud once promoted). */
  runtime?: AgentChatRuntime;
  /** Cloud-only launch overrides; ignored when runtime !== "cloud". */
  cloudOverrides?: AgentChatCloudOverrides;
};

export type AgentChatSteerArgs = {
  sessionId: string;
  text: string;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
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

export type AgentChatDispatchSteerMode = "inline" | "interrupt";

export type AgentChatDispatchSteerArgs = {
  sessionId: string;
  steerId: string;
  mode: AgentChatDispatchSteerMode;
};

export type AgentChatDispatchSteerResult = {
  dispatchedAt: number | null;
};

export type AgentChatCancelDispatchedSteerArgs = {
  sessionId: string;
  steerId: string;
};

export type AgentChatCancelDispatchedSteerResult = {
  cancelled: boolean;
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
  activateRuntime?: boolean;
};

export type AgentChatDisposeArgs = {
  sessionId: string;
};

export type AgentChatDeleteArgs = {
  sessionId: string;
};

export type AgentChatArchiveArgs = {
  sessionId: string;
};

export type AgentChatUpdateSessionArgs = {
  sessionId: string;
  title?: string | null;
  manuallyNamed?: boolean;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
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

export type TurnDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  status: "A" | "M" | "D" | "R" | "C" | string;
};

export type TurnDiffSummary = {
  turnId: string;
  beforeSha: string;
  afterSha: string;
  files: TurnDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
};

export type AgentChatGetTurnFileDiffArgs = {
  sessionId: string;
  beforeSha: string;
  afterSha: string;
  filePath: string;
};

export type AgentChatTurnFileDiff = FileDiff;

export type AgentChatCodexOpenInCliMode = "ade-terminal" | "new-window";

export type AgentChatCodexOpenInCliArgs = {
  sessionId: string;
  mode: AgentChatCodexOpenInCliMode;
};

export type AgentChatCodexOpenInCliResult = {
  /** Absolute path to the codex binary to invoke (the bundled one by default). */
  binary: string;
  /** Argument vector to pass to the binary. Empty when no resume-flag exists. */
  argv: string[];
  /** Lane worktree path to `cd` into before invoking. */
  cwd: string;
  /** Codex thread to resume. */
  threadId: string;
  /** True when no `resume`/`--thread` form was detected; the renderer should copy threadId to clipboard and show a toast. */
  copyThreadIdToClipboard: boolean;
  /** Set when mode === "new-window" and a terminal launcher was spawned. */
  spawnedNewWindow?: boolean;
};
