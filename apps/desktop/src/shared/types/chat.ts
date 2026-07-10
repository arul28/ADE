// ---------------------------------------------------------------------------
// Agent chat types
// ---------------------------------------------------------------------------

import type { ModelId } from "./core";
import type { CtoCapabilityMode } from "./cto";
import type { FileDiff } from "./git";
import type { LaneLinearIssue, SessionLinearIssueLink } from "./lanes";
import type { OrchestrationContextItem, OrchestrationRole } from "./orchestration";
import type { SubagentCapability } from "../subagentCapabilities";

export type AgentChatProvider = "codex" | "claude" | "cursor" | "droid" | "opencode" | (string & {});

export type AgentChatSessionStatus = "active" | "idle" | "ended";
export type AgentChatSessionProfile = "light" | "workflow";

export type DelegationMode = "exclusive" | "bounded_parallel" | "recovery";

export type DelegationIntent =
  | "planner"
  | "implementation"
  | "validation"
  | "specialist"
  | "subagent"
  | "parallel_subtasks"
  | "recovery";

export type DelegationScope = {
  kind: "phase" | "step" | "worker" | "batch";
  key: string;
  label?: string | null;
};

export type DelegationContractStatus =
  | "launching"
  | "active"
  | "completed"
  | "failed"
  | "launch_failed"
  | "recovering"
  | "blocked"
  | "canceled";

export type DelegationLaunchState =
  | "awaiting_context"
  | "fetching_context"
  | "awaiting_worker_launch"
  | "launching_worker"
  | "waiting_on_worker"
  | "recovering"
  | "completed"
  | "blocked";

export type CoordinatorCapability =
  | "observe"
  | "fetch_project_context"
  | "spawn_top_level_worker"
  | "spawn_nested_worker"
  | "spawn_parallel_workers"
  | "read_repo"
  | "message_workers"
  | "ask_user"
  | "run_control"
  | "update_state";

export type DelegationFailureCategory =
  | "run_context_bug"
  | "provider_unreachable"
  | "permission_denied"
  | "tool_schema_error"
  | "native_tool_violation"
  | "unknown";

export type DelegationContract = {
  schemaVersion: 1;
  contractId: string;
  runId: string;
  ownerKind: "coordinator";
  workerIntent: DelegationIntent;
  mode: DelegationMode;
  scope: DelegationScope;
  phaseKey: string | null;
  status: DelegationContractStatus;
  launchState: DelegationLaunchState | null;
  activeWorkerIds: string[];
  coordinatorCapabilities: CoordinatorCapability[];
  launchPolicy: {
    maxLaunchAttempts: number;
  };
  failurePolicy: {
    retryLimit: number;
    escalation: "intervention" | "retry" | "stop";
  };
  batchId?: string | null;
  parentContractId?: string | null;
  failure?: {
    category: DelegationFailureCategory;
    message: string;
    retryAfterMs?: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSurfaceMode = "standard" | "resolver";
export type ChatSurfaceProfile = "standard" | "persistent_identity";

export type ChatSurfaceChipTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

export type OperatorNavigationSurface = "work" | "lanes" | "cto";

export type OperatorNavigationSuggestion = {
  surface: OperatorNavigationSurface;
  label: string;
  href: string;
  laneId?: string | null;
  sessionId?: string | null;
};

export type ChatSurfaceChip = {
  label: string;
  tone?: ChatSurfaceChipTone;
};

export type ChatSurfacePresentation = {
  mode: ChatSurfaceMode;
  profile?: ChatSurfaceProfile;
  title?: string | null;
  subtitle?: string | null;
  accentColor?: string | null;
  assistantLabel?: string | null;
  messagePlaceholder?: string | null;
  chips?: ChatSurfaceChip[];
  showMcpStatus?: boolean;
};

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";
export type AgentChatClaudePermissionMode = "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions";
export type AgentChatClaudeOutputStyleSource = "builtin" | "user" | "project" | "plugin";
export type AgentChatClaudeOutputStyle = {
  name: string;
  description?: string;
  source: AgentChatClaudeOutputStyleSource;
  filePath?: string;
  pluginPath?: string;
};
export type AgentChatClaudePlugin = {
  name: string;
  path: string;
  source: "local";
  description?: string;
  version?: string;
};
export type AgentChatClaudePluginsArgs = {
  sessionId?: string;
  laneId?: string;
};
export type AgentChatReloadClaudePluginsArgs = {
  sessionId: string;
};
export type AgentChatReloadClaudePluginsResult = {
  plugins: AgentChatClaudePlugin[];
  commands: Array<{ name: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
  errorCount: number;
};
export type AgentChatCodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type AgentChatCodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AgentChatCodexConfigSource = "flags" | "config-toml";
export type AgentChatOpenCodePermissionMode = "plan" | "edit" | "full-auto" | "config-toml";
export type AgentChatDroidPermissionMode = "read-only" | "auto-low" | "auto-medium" | "auto-high" | "agi";

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
  /**
   * Deep-link to a child chat session spawned from this one (the
   * "Subagent spawned" chip on `status: "subagent_spawned"` notices).
   * Desktop navigates to the session; the TUI switches to it; iOS renders
   * the notice message (extra fields are ignored by its decoder).
   */
  spawnedSession?: {
    sessionId: string;
    laneId?: string | null;
    title?: string;
  };
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

/**
 * Ephemeral plan-annotation attachment produced by the orchestration plan
 * panel popover (see `goal.md` §10.7). Lives only in the composer tray; not
 * persisted to the manifest in v1. The payload carries the anchor (what was
 * selected) and the user's free-form comment, so the lead sees what was
 * being commented on when the message is sent.
 */
export type AgentChatOrchestrationAnnotationContextAttachment = {
  type: "orchestration_annotation";
  item: OrchestrationContextItem;
  source?: "manual";
  attachedAt?: string;
};

export type AgentChatContextAttachment =
  | AgentChatLinearIssueContextAttachment
  | AgentChatOrchestrationAnnotationContextAttachment;

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
  queries?: string[];
  url?: string;
  title?: string;
  snippet?: string;
};

export type AgentChatMcpAppContext = {
  connectorId?: string;
  linkId?: string;
  resourceUri?: string;
  appName?: string;
  templateId?: string;
  actionName?: string;
};

/** Provider-neutral source identity retained from structured MCP tool events. */
export type AgentChatMcpToolSource = {
  server: string;
  tool: string;
  pluginId?: string;
  resourceUri?: string;
  appContext?: AgentChatMcpAppContext;
};

export type CodexSafetyBufferingState = {
  threadId?: string | null;
  turnId?: string | null;
  model?: string | null;
  useCases?: string[];
  reasons?: string[];
  showBufferingUi: boolean;
  fasterModel?: string | null;
};

export type CodexModerationMetadata = {
  threadId?: string | null;
  turnId?: string | null;
  metadata: Record<string, unknown> | null;
};

export type CodexTokenUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Codex `reasoningOutputTokens` (reasoning models) — surfaced in the context-usage tooltip. */
  reasoningTokens?: number;
  totalTokens?: number;
};

export type CodexThreadTokenUsage = {
  threadId?: string | null;
  turnId?: string | null;
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
};

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "cancelled"
  | "unknown";

export type CodexThreadGoal = {
  objective?: string | null;
  tokenBudget?: number | null;
  status?: CodexThreadGoalStatus;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CodexThreadGoalUpdateKind = "set" | "status" | "sync" | "budget";

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

export type AgentChatImportProvider = "claude" | "codex";

export type AgentChatImportedFrom = {
  provider: string;
  sessionId: string;
  importedAt: number;
};

export type AgentChatCloudRunStatus =
  | "creating"
  | "running"
  | "finished"
  | "error"
  | "cancelled"
  | "expired";

export type AgentChatScheduledWakeMetadata = {
  scheduleId: string;
  kind: "wakeup" | "cron" | "loop";
  firedAt: string;
  reason?: string;
  late?: boolean;
};

export type AgentChatEventMetadata = Record<string, unknown> & {
  /** Marks a synthetic unattended turn started by ADE's durable scheduler. */
  scheduledWake?: AgentChatScheduledWakeMetadata;
};

export type AgentChatScheduledWorkKind =
  | "wakeup"
  | "cron"
  | "loop"
  | "remote_trigger"
  | "background_task";

export type AgentChatScheduledWorkStatus =
  | "scheduled"
  | "paused"
  | "running"
  | "fired"
  | "missed"
  | "completed"
  | "cancelled"
  | "failed"
  | "stopped";

export type AgentChatScheduledWorkOrigin =
  | "schedule_wakeup"
  | "cron"
  | "loop"
  | "remote_trigger"
  | "background_task"
  | "sdk";

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      displayText?: string;
      metadata?: AgentChatEventMetadata | null | undefined;
      messageId?: string;
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
      mcp?: AgentChatMcpToolSource;
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
      mcp?: AgentChatMcpToolSource;
      resultOriginalBytes?: number;
      resultOmittedBytes?: number;
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
      diffOriginalBytes?: number;
      diffOmittedBytes?: number;
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
      outputOriginalBytes?: number;
      outputOmittedBytes?: number;
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
      textOriginalBytes?: number;
      textOmittedBytes?: number;
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
        category: "auth" | "rate_limit" | "budget" | "network" | "busy" | "unknown" | "agent_cli_missing" | "agent_cli_auth";
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
        /** Reasoning/thinking output tokens (Codex/Droid/OpenCode/Claude). */
        reasoningTokens?: number | null;
        /** Effective context window for the model that produced this turn, when the runtime reports one. */
        contextWindow?: number | null;
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
      agentId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      description: string;
      background?: boolean;
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      workflowName?: string;
      turnId?: string;
    }
  | {
      type: "subagent_progress";
      taskId: string;
      agentId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      description?: string;
      summary: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
        /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
        costUsd?: number;
      };
      lastToolName?: string;
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      workflowName?: string;
      turnId?: string;
    }
  | {
      type: "subagent_result";
      taskId: string;
      agentId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      status: "completed" | "failed" | "stopped";
      summary: string;
      finalSummary?: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
        /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
        costUsd?: number;
      };
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      workflowName?: string;
      turnId?: string;
    }
  | {
      type: "subagent.started";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      description?: string;
      background?: boolean;
      turnId?: string;
    }
  | {
      type: "subagent.progress";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      text?: string;
      tokens?: number;
      lastToolName?: string;
      turnId?: string;
    }
  | {
      type: "subagent.completed";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      summary: string;
      status?: "completed" | "failed" | "stopped";
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
      };
      turnId?: string;
    }
  // ── Droid AGI mission events (orchestrator mode) ──────────────────────────
  // Emitted only when a Droid session runs in AGI/orchestrator mode. They drive
  // the Missions tab; non-AGI runtimes never emit them.
  | {
      type: "mission_state";
      state: AgentChatMissionState;
      turnId?: string;
    }
  | {
      type: "mission_features";
      /** The full current feature checklist (replaces, not appends). */
      features: AgentChatMissionFeature[];
      turnId?: string;
    }
  | {
      type: "mission_progress";
      /** The full current progress log (replaces, not appends). */
      entries: AgentChatMissionProgressEntry[];
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
      type: "scheduled_work_update";
      id: string;
      kind: AgentChatScheduledWorkKind;
      status: AgentChatScheduledWorkStatus;
      origin?: AgentChatScheduledWorkOrigin;
      title?: string;
      summary?: string;
      prompt?: string;
      reason?: string;
      cron?: string;
      nextRunAt?: string;
      lastRunAt?: string;
      firedAt?: string;
      late?: boolean;
      recurring?: boolean;
      durable?: boolean;
      sourceToolUseId?: string;
      sourceTaskId?: string;
      turnId?: string;
      error?: string;
    }
  | {
      type: "transcript_retraction";
      messageIds: string[];
      reason?: "model_refusal_fallback" | "assistant_supersedes" | "provider";
      replacementMessageId?: string;
      turnId?: string;
    }
  | {
      type: "context_compact";
      trigger: "manual" | "auto";
      preTokens?: number;
      postTokens?: number;
      tokensRemoved?: number;
      durationMs?: number;
      provider?: "claude" | "codex" | "opencode" | "cursor" | "droid";
      /** Stable merge key for started→completed pairs that may land on different turns. */
      compactionId?: string;
      /** After the second compaction in a session, surfaces as "(N× this session)" in the pill. */
      sessionCompactionCount?: number;
      // Lifecycle of the compaction. Runtimes that expose a begin signal (Claude's
      // `compacting` status, OpenCode's compaction part) emit a "started" event when
      // compaction begins and a "completed" event when it ends, so the UI can show a
      // live "compacting…" indicator instead of only the finished result. Omitted by
      // legacy/completion-only sources (treated as "completed").
      state?: "started" | "completed";
      turnId?: string;
    }
  | {
      type: "codex_context_compaction";
      turnId: string;
      state: "started" | "completed";
      trigger: "manual" | "auto";
      compactionId?: string;
    }
  | {
      type: "codex_safety_buffering";
      state: CodexSafetyBufferingState;
      turnId?: string;
    }
  | {
      type: "codex_moderation_metadata";
      metadata: CodexModerationMetadata;
      turnId?: string;
    }
  | {
      type: "codex_sleep";
      itemId: string;
      turnId?: string;
      durationMs?: number | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "context_usage";
      usage: AgentChatContextUsage;
      turnId?: string;
    }
  | {
      type: "system_notice";
      noticeKind: "auth" | "rate_limit" | "hook" | "file_persist" | "info" | "provider_health" | "thread_error" | "warning" | "error" | "config";
      severity?: "info" | "warning" | "error";
      status?: string;
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
      /** Metadata when a large inline data URI was omitted from durable history or mobile sync. */
      resultOriginalBytes?: number;
      resultOmittedBytes?: number;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_image_view";
      itemId: string;
      turnId?: string;
      path?: string | null;
      url?: string | null;
      title?: string | null;
      /** Metadata when a large inline data URI was omitted from durable history or mobile sync. */
      urlOriginalBytes?: number;
      urlOmittedBytes?: number;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_token_usage";
      usage: CodexThreadTokenUsage;
      turnId?: string;
    }
  | {
      type: "codex_turn_stalled";
      turnId: string;
      threadId?: string;
      reason: "no_output" | "waiting_on_input" | "waiting_on_approval" | "app_server_state_unknown";
      message: string;
      recoveryOptions?: Array<"wait" | "steer" | "interrupt_retry_same_thread" | "restart_resume_thread">;
      sourceSessionId?: string;
      parentSessionId?: string;
    }
  | {
      type: "codex_thread_deleted";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "codex_goal_updated";
      goal: CodexThreadGoal | null;
      updateKind?: CodexThreadGoalUpdateKind;
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
    }
  | {
      /**
       * Transient push event signalling a change to a chat session's
       * summary-level metadata (title, manuallyNamed). Not persisted to
       * the transcript — purely a renderer-state patch so the chat header
       * can refresh without a full session list re-fetch.
       */
      type: "session_meta_updated";
      title?: string;
      manuallyNamed?: boolean;
      // Permission/interaction mode fields — emitted when a client (e.g. iOS)
      // changes the mode via updateSession so other renderers patch their
      // composer state without waiting for a turn-lifecycle event. All optional
      // and backward-compatible; a title-only emit carries none of them.
      permissionMode?: AgentChatPermissionMode;
      interactionMode?: AgentChatInteractionMode | null;
      claudePermissionMode?: AgentChatClaudePermissionMode;
      codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
      codexSandbox?: AgentChatCodexSandbox;
      codexConfigSource?: AgentChatCodexConfigSource;
      opencodePermissionMode?: AgentChatOpenCodePermissionMode;
      droidPermissionMode?: AgentChatDroidPermissionMode;
      cursorModeId?: string | null;
      cursorModeSnapshot?: AgentChatCursorModeSnapshot;
      cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
      // Accept turnId for uniformity with other variants — ignored by handlers.
      turnId?: string;
    };

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
  provenance?: {
    messageId?: string;
    providerMessageId?: string;
    providerParentAgentId?: string | null;
    providerOrigin?: string | null;
    providerSupersedes?: string[];
    providerRetractedMessageIds?: string[];
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

export type AgentChatEventHistorySnapshot = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  /**
   * True when any history was omitted from this snapshot, either because the
   * transcript tail was bounded or because maxEvents windowed the result.
   */
  truncated: boolean;
  transcriptTruncated?: boolean;
  windowTruncated?: boolean;
  /**
   * Explicitly false means the session id did not resolve in this project
   * runtime. Optional for compatibility with older desktop/runtime pairs.
   */
  sessionFound?: boolean;
  /**
   * Byte offset in the transcript file where the hydrated tail window began.
   * Pass it as `beforeOffset` to `getChatEventHistoryPage` to page older
   * history. Null/undefined when the session had no transcript file or the
   * transcript was not truncated at the file level (nothing older on disk).
   */
  tailStartOffset?: number | null;
};

export type AgentChatEventHistoryPage = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  /** Byte offset in the transcript where this page begins. Pass as the next request's beforeOffset. 0 = head reached. */
  startOffset: number;
  hasMore: boolean;
  sessionFound: boolean;
};

export type AgentChatPermissionMode = "default" | "auto" | "plan" | "edit" | "full-auto" | "config-toml";
export type AgentChatExecutionMode = "focused" | "parallel" | "subagents" | "teams";
export type AgentChatInteractionMode =
  | "default"
  | "plan"
  | "orchestrator-lead"
  | "orchestrator-worker"
  | "orchestrator-validator";
/**
 * Optional fields persisted on chat sessions/summaries when the session is part
 * of an orchestration run. All fields are optional for migration tolerance —
 * older sessions deserialise cleanly with these absent.
 */
export type OrchestrationSessionFields = {
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationParentSessionId?: string;
  orchestrationTag?: string;
  orchestrationStepId?: string;
  orchestrationBundlePath?: string;
};
export type AgentChatIdentityKey = "cto";
export type AgentChatSurface = "work" | "automation" | "personal";
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
export type PendingInputSource = "claude" | "codex" | "cursor" | "droid" | "opencode" | "ade";
export type PendingInputKind = "approval" | "question" | "structured_question" | "permissions" | "plan_approval" | "model_selection";

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
  autoResolutionMs?: number | null;
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
  goal?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** Effective service tier reported by the Codex app-server, when known. */
  codexServiceTier?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  claudeOutputStyle?: string | null;
  claudeBackgroundJobShort?: string | null;
  claudeBackgroundResumeSessionId?: string | null;
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
  importedFrom?: AgentChatImportedFrom;
  /** Subdirectory or absolute path under the lane worktree used as cwd; persisted for relaunch/resume. */
  requestedCwd?: string | null;
  createdAt: string;
  lastActivityAt: string;
} & OrchestrationSessionFields;

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
  fastMode?: boolean;
  /** Effective service tier reported by the Codex app-server, when known. */
  codexServiceTier?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  claudeOutputStyle?: string | null;
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
  pendingInputItemId?: string | null;
  /** Earliest armed, unpaused schedule for this chat. */
  nextWakeAt: string | null;
  /** True when this chat's durable schedules are paused. */
  scheduledWorkPaused?: boolean;
  threadId?: string;
  importedFrom?: AgentChatImportedFrom;
  requestedCwd?: string | null;
  /**
   * Linear issues attached to this session (chat or CLI), independent of any
   * lane link. Populated from `session_linear_issues`; empty/omitted when the
   * session has no attached issues.
   */
  linearIssueLinks?: SessionLinearIssueLink[];
} & OrchestrationSessionFields;

export type AgentChatTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  displayText?: string;
  timestamp: string;
  turnId?: string;
  messageId?: string;
  itemId?: string;
};

export type AgentChatSubagentSnapshot = {
  taskId: string;
  agentId?: string;
  agentType?: string;
  label?: string | null;
  parentToolUseId?: string | null;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  turnId?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  summary?: string;
  finalSummary?: string;
  lastToolName?: string;
  background?: boolean;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
    /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
    costUsd?: number;
  };
};

export type AgentChatSubagentListArgs = {
  sessionId: string;
};

// ── Droid AGI mission types ────────────────────────────────────────────────
// Mirror @factory/droid-sdk 0.2.0 MissionState / FeatureStatus / MissionFeature.
export type AgentChatMissionState =
  | "awaiting_input"
  | "initializing"
  | "running"
  | "paused"
  | "orchestrator_turn"
  | "completed"
  | (string & {});

export type AgentChatMissionFeatureStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | (string & {});

export type AgentChatMissionFeature = {
  id: string;
  description: string;
  status: AgentChatMissionFeatureStatus;
  skillName?: string | null;
  milestone?: string | null;
  /** Worker session currently executing this feature (maps to a subagent row). */
  currentWorkerSessionId?: string | null;
  workerSessionIds?: string[];
  completedWorkerSessionId?: string | null;
};

export type AgentChatMissionProgressEntry = {
  /** ProgressLogEntryType, e.g. "worker_started" | "worker_completed" | ... */
  type: string;
  text?: string | null;
  workerSessionId?: string | null;
  featureId?: string | null;
  timestamp?: string | null;
};

/** Args for killing an individual Droid AGI mission worker. */
export type AgentChatKillDroidWorkerArgs = {
  sessionId: string;
  workerSessionId: string;
};

export type AgentChatSessionCapabilities = {
  supportsSubagentInspection: boolean;
  supportsSubagentControl: boolean;
  supportsReviewMode: boolean;
  /**
   * Per-runtime subagent capability descriptor — the single source of truth the
   * renderer branches on (list vs takeover vs inline-drawer, which stat fields
   * to show). See `shared/subagentCapabilities.ts`.
   */
  subagent: SubagentCapability;
};

export type AgentChatSessionCapabilitiesArgs = {
  sessionId: string;
};

export type AgentChatContextUsageCategory = {
  name: string;
  tokens: number;
  percentage: number;
  color?: string;
  isDeferred?: boolean;
};

export type AgentChatContextUsage = {
  categories: AgentChatContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage: number;
  model?: string;
};

export type AgentChatContextUsageArgs = {
  sessionId: string;
};

export type AgentChatRewindFilesArgs = {
  sessionId: string;
  userMessageId: string;
  dryRun?: boolean;
};

export type AgentChatRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  dryRun: boolean;
  conversationRollback?: boolean;
};

export type AgentChatClaudeSessionListArgs = {
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
  includeWorktrees?: boolean | null;
};

export type AgentChatClaudeSessionInfoArgs = {
  sessionId: string;
  laneId?: string | null;
};

export type AgentChatClaudeSessionMessagesArgs = {
  sessionId: string;
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
  includeSystemMessages?: boolean | null;
};

export type AgentChatClaudeSessionInfo = {
  sessionId: string;
  laneId: string | null;
  laneName: string | null;
  chatSessionId: string | null;
  summary: string;
  title: string | null;
  customTitle?: string | null;
  firstPrompt?: string | null;
  tag?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  createdAt?: string | null;
  lastModifiedAt: string | null;
  fileSize?: number | null;
};

export type AgentChatClaudeSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  sessionId: string;
  parentToolUseId: string | null;
  message: unknown;
  text?: string | null;
  subagentMetadata?: AgentChatSubagentMetadata | null;
};

export type AgentChatSubagentMetadata = {
  threadId?: string | null;
  parentThreadId?: string | null;
  label?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  name?: string | null;
  preview?: string | null;
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

export type AgentChatSubagentTranscriptArgs = {
  sessionId: string;
  agentId: string;
  /** Optional task id from the legacy `system:task_*` path; the SDK keys on agentId. */
  taskId?: string | null;
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
};

/**
 * One subagent transcript entry. Shape mirrors AgentChatClaudeSessionMessage
 * (the SDK's `SessionMessage` is identical for parent sessions and subagent
 * transcripts). Returns null for runtimes that don't surface subagent
 * transcripts (LM Studio, Droid).
 */
export type AgentChatSubagentTranscriptMessage = AgentChatClaudeSessionMessage;

export type AgentChatModelInfo = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault: boolean;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
  defaultReasoningEffort?: string | null;
  serviceTiers?: string[];
  aliases?: string[];
  maxThinkingTokens?: number | null;
  // OpenCode-backed model metadata
  modelId?: ModelId;
  family?: string;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  color?: string;
  cursorAvailability?: {
    cli: boolean;
    sdk: boolean;
  };
  cursorCliVariants?: Array<{
    modelId: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }>;
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
  connected?: boolean;
  requiresConfiguration?: boolean;
  sourceRuntime?: AgentChatProvider;
  providerId?: string;
  providerName?: string;
  stale?: boolean;
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
  stale?: boolean;
};

export type AgentChatModelCatalogRefreshProvider =
  | "opencode"
  | "cursor"
  | "droid"
  | "lmstudio"
  | "ollama";

export type AgentChatModelCatalogMode = "cached" | "refresh-stale" | "force";

/**
 * Which cursor discovery source the requesting surface needs synchronously.
 * Chat surfaces run models through the Cursor SDK ("sdk"); Work-tab CLI lane
 * drafts run the cursor-agent CLI ("cli"). "all" (default) probes both, which
 * makes the refresh wait on the slower CLI spawn — surfaces that know their
 * flavor should pass it so the other source revalidates in the background.
 */
export type AgentChatCursorModelSource = "sdk" | "cli" | "all";

export type AgentChatModelCatalogArgs = {
  mode?: AgentChatModelCatalogMode;
  refreshProvider?: AgentChatModelCatalogRefreshProvider;
  cursorSource?: AgentChatCursorModelSource;
};

export type AgentChatCreateArgs = {
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  title?: string | null;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  claudeOutputStyle?: string | null;
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
  goal?: string | null;
  // Orchestration-mode fields — set when spawning into an orchestration run.
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationParentSessionId?: string;
  orchestrationTag?: string;
  orchestrationStepId?: string;
  orchestrationBundlePath?: string;
};

export type AgentChatImportExternalSessionArgs = {
  provider: AgentChatImportProvider;
  externalSessionId: string;
  laneId: string;
  cwd: string | null;
  fork: boolean;
  title?: string;
};

export type AgentChatImportExternalSessionResult = {
  chatSessionId: string;
  chatSummary: AgentChatSessionSummary;
};

/**
 * Args for headlessly launching an agent in a lane with no mounted chat pane.
 * Creates the session and fires the first turn off without awaiting it, so a
 * caller (e.g. the multi-lane Linear launch flow) can spin up N lanes that each
 * start working immediately. The kickoff text drives the first turn; optional
 * context attachments (Linear issue / orchestration annotations) are forwarded
 * to that turn the same way an interactive send would.
 */
export type AgentChatLaunchArgs = AgentChatCreateArgs & {
  kickoffText: string;
  kickoffDisplayText?: string;
  contextAttachments?: AgentChatContextAttachment[];
};

/** CLI provider profiles a headless CLI launch can target. */
export type AgentChatCliLaunchProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode";

/**
 * Launch a tracked CLI/terminal agent (not the in-process chat SDK) with one or
 * more Linear issues attached before the process spawns, so the agent inherits
 * `ADE_LINEAR_ISSUE_IDS` + `ADE_LINEAR_CONTEXT_FILE` and can read/update its
 * issue through `ade linear`. The kickoff prompt is submitted to the agent on
 * launch. Provider/model/permission build the startup command server-side.
 */
export type AgentChatLaunchCliArgs = {
  laneId: string;
  provider: AgentChatCliLaunchProvider;
  /** Runtime model ref for the provider's fresh-launch CLI flags. */
  model?: string | null;
  reasoningEffort?: string | null;
  /** Fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean | null;
  permissionMode?: AgentChatPermissionMode;
  /** Optional orchestration role; when present, role policy overrides the requested permission mode. */
  orchestrationRole?: OrchestrationRole | null;
  /** Prompt submitted to the CLI agent once it starts. */
  kickoffPrompt: string;
  /** Linear issues to attach to the new session before spawn. */
  linearIssues?: LaneLinearIssue[];
  title?: string;
  /** Foreground opens/focuses the session; background leaves focus alone. */
  disposition?: "foreground" | "background";
};

export type AgentChatLaunchCliResult = {
  sessionId: string;
  ptyId: string;
  pid: number | null;
  /** Identifiers of the issues attached to the launched session. */
  attachedLinearIssueIds: string[];
};

export type AgentChatRuntimeMode = "interactive" | "print";

export type AgentChatHandoffArgs = {
  sourceSessionId: string;
  targetModelId: ModelId;
  mode?: "brief" | "fork";
  /** Optional user-authored note appended to the handoff prompt. Blank notes are ignored. */
  handoffNote?: string | null;
  /**
   * When set (including `null` for "no extra reasoning"), combined with the target
   * model to pick a valid reasoning tier. When omitted, inherits from the source
   * session the same way as a legacy handoff.
   */
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
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
  includeArchived?: boolean;
};

export type AgentChatSuggestLaneNameArgs = {
  /** Lane the user is launching from (worktree path for the naming model call). */
  laneId: string;
  /** User prompt for the chat launch (used to derive a short lane name prefix). */
  prompt: string;
  /** Registry model ID used to run the naming call (e.g. first selected model). */
  modelId: string;
  /** Optional fallback used when model-backed naming is disabled or unavailable. */
  fallbackName?: string;
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
  metadata?: AgentChatEventMetadata | null | undefined;
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
  metadata?: AgentChatEventMetadata | null | undefined;
};

export type AgentChatSteerResult = {
  steerId: string;
  queued: boolean;
};

export type AgentChatMessageSessionKind =
  | "auto"
  | "queue"
  | "wake"
  | "interrupt-replace";

export type AgentChatMessageSessionArgs = {
  sessionId: string;
  text: string;
  kind?: AgentChatMessageSessionKind;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  metadata?: AgentChatEventMetadata | null | undefined;
};

export type AgentChatMessageSessionResult = {
  sessionId: string;
  kind: AgentChatMessageSessionKind;
  routedAction: "sendMessage" | "steer" | "interrupt-replace";
  statusBefore: AgentChatSessionStatus;
  awaitingInputBefore: boolean;
  delivery: "sent" | "delivered" | "queued";
  steerId?: string;
  queued?: boolean;
};

export type AgentChatSetScheduledWorkPausedArgs = {
  sessionId: string;
  paused: boolean;
};

export type AgentChatSetScheduledWorkPausedResult = {
  sessionId: string;
  paused: boolean;
  nextWakeAt: string | null;
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

export type AgentChatCodexRecoveryAction =
  | "wait"
  | "steer"
  | "interrupt_retry_same_thread"
  | "restart_resume_thread";

export type AgentChatRecoverCodexTurnArgs = {
  sessionId: string;
  turnId: string;
  action: AgentChatCodexRecoveryAction;
};

export type AgentChatRecoverCodexTurnResult = {
  action: AgentChatCodexRecoveryAction;
  turnId: string;
  status: "waiting" | "nudged" | "retrying" | "resumed";
};

export type AgentChatCodexGetGoalArgs = {
  sessionId: string;
};

export type AgentChatCodexSetGoalArgs = {
  sessionId: string;
  objective: string;
};

export type AgentChatCodexSetGoalStatusArgs = {
  sessionId: string;
  status: Extract<CodexThreadGoalStatus, "active" | "paused" | "blocked" | "complete">;
};

export type AgentChatCodexClearGoalArgs = {
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
  provider?: AgentChatProvider;
  activateRuntime?: boolean;
  cursorSource?: AgentChatCursorModelSource;
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
  tag?: string | null;
  manuallyNamed?: boolean;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
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
  sessionId?: string;
  laneId?: string | null;
  provider?: AgentChatProvider | null;
  projectRoot?: string | null;
};

export type AgentChatClaudeOutputStylesArgs = {
  sessionId?: string;
  laneId?: string;
};

export type AgentChatSetClaudeOutputStyleArgs = {
  sessionId: string;
  outputStyle: string;
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
