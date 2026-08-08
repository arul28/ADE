// ---------------------------------------------------------------------------
// Terminal session types
// ---------------------------------------------------------------------------

import type {
  AgentChatPermissionMode,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCliLaunchProvider,
  AgentChatSpawnKind,
} from "./chat";
import type { LaneLinearIssue } from "./lanes";
import type { OrchestrationRole } from "./orchestration";

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed" | "detached";

export type TerminalToolType =
  | "shell"
  | "claude"
  | "codex"
  | "cursor-cli"
  | "droid"
  | "opencode"
  | "pi"
  | "claude-orchestrated"
  | "codex-orchestrated"
  | "opencode-orchestrated"
  | "codex-chat"
  | "claude-chat"
  | "opencode-chat"
  | "cursor"
  | "droid-chat"
  | "pi-chat"
  | "aider"
  | "continue"
  | "other";

export type TrackedAgentCliToolType =
  | "claude"
  | "codex"
  | "cursor-cli"
  | "droid"
  | "opencode"
  | "pi"
  | "claude-orchestrated"
  | "codex-orchestrated"
  | "opencode-orchestrated";

export const PTY_SEND_PRE_DELIVERY_ERROR_CODE = "pty_send_pre_delivery" as const;

export function isPtySendPreDeliveryError(
  error: unknown,
): error is Error & { code: typeof PTY_SEND_PRE_DELIVERY_ERROR_CODE } {
  return error instanceof Error
    && "code" in error
    && error.code === PTY_SEND_PRE_DELIVERY_ERROR_CODE;
}

export function isTrackedAgentCliToolType(
  toolType: TerminalToolType | null | undefined,
): toolType is TrackedAgentCliToolType {
  return toolType === "claude"
    || toolType === "codex"
    || toolType === "cursor-cli"
    || toolType === "droid"
    || toolType === "opencode"
    || toolType === "pi"
    || toolType === "claude-orchestrated"
    || toolType === "codex-orchestrated"
    || toolType === "opencode-orchestrated";
}

export type TerminalRuntimeState = "running" | "waiting-input" | "idle" | "exited" | "killed";

/** Explicit settle pin. Cleared on activity with `settled_at`. */
export type SessionSettleOverride = "settled" | "active";

/**
 * Why a snoozed session woke. Persisted on `terminal_sessions.woke_reason` so
 * the row can show a "woke" marker explaining itself until the user visits it.
 *   "timer"         — the snooze window elapsed (DERIVED from snoozed_until),
 *   "needs_you"     — a pending approval / input request appeared,
 *   "error"         — a session error strictly newer than snoozed_at,
 *   "turn_complete" — a running turn finished,
 *   "manual"        — the user woke it by hand.
 */
export const SESSION_WAKE_REASONS = [
  "timer",
  "needs_you",
  "error",
  "turn_complete",
  "manual",
] as const;

export type SessionWakeReason = typeof SESSION_WAKE_REASONS[number];

/**
 * The one parser for a settle-override value crossing a boundary — IPC args,
 * sync-command JSON, CLI flags, a SQLite text column.
 *
 * Callers previously hand-rolled this four times with three different
 * behaviors: the registry and sync parsers were case-sensitive and threw, while
 * the service lowercased and silently returned null — so `"Settled"` was
 * rejected over IPC but accepted underneath it, and a typo like `"activ"`
 * silently CLEARED a pin instead of failing. Returning `undefined` for
 * unrecognized input lets throwing call sites keep their own error message
 * while non-throwing ones can no longer mistake garbage for "clear".
 *
 * `"clear"` / `"none"` / `""` / null are the explicit clear sentinels — iOS
 * sends the string because JSON null is not representable in its arg dict.
 */
export function parseSessionSettleOverride(
  value: unknown,
): SessionSettleOverride | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "" || text === "clear" || text === "none") return null;
  if (text === "settled" || text === "active") return text;
  return undefined;
}

export type TerminalResumeProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi";

export type TerminalResumeTargetKind = "session" | "thread";

export type TerminalResumeLaunchConfig = {
  permissionMode?: AgentChatPermissionMode | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  /** @deprecated Use fastMode. Accepted for resume metadata written before the fast-mode rename. */
  codexFastMode?: boolean | null;
  claudePermissionMode?: AgentChatClaudePermissionMode | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy | null;
  codexSandbox?: AgentChatCodexSandbox | null;
  codexConfigSource?: AgentChatCodexConfigSource | null;
};

export type TerminalResumeMetadata = {
  provider: TerminalResumeProvider;
  targetKind: TerminalResumeTargetKind;
  targetId: string | null;
  launch: TerminalResumeLaunchConfig;
  /** Chat that spawned this tracked CLI session, independent of terminal ownership. */
  orchestrationParentSessionId?: string;
  /** Cosmetic/reporting relationship declared by the spawning chat. */
  spawnKind?: AgentChatSpawnKind;
  importedFrom?: {
    provider: TerminalResumeProvider;
    targetId: string;
    mode: "resume" | "fork";
    importedAt?: string | null;
  } | null;
  // Legacy aliases kept for compatibility with existing helpers and stored rows.
  target?: string | null;
  permissionMode?: AgentChatPermissionMode | null;
};

export type TrackedCliResumeProvider = TerminalResumeProvider;
export type TrackedCliResumeMetadata = TerminalResumeMetadata;

export type TerminalSessionSummary = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  ownerPid?: number | null;
  ownerProcessStartedAt?: string | null;
  tracked: boolean;
  pinned: boolean;
  manuallyNamed?: boolean;
  goal: string | null;
  toolType: TerminalToolType | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  archivedAt?: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  /**
   * ISO timestamp of the session's most recent output/activity
   * (terminal_sessions.last_output_at). Null when it has never produced output;
   * optional so optimistic/partial UI constructions need not supply it. The DB
   * boundary normalizes it to a valid ISO string or null, and consumers treat
   * undefined/null/empty identically, so the extra state is harmless.
   * Used to detect sessions that are old *and untouched*, vs. old-but-active.
   */
  lastActivityAt?: string | null;
  /** Start of the current chat turn. Unlike lastActivityAt, output does not move it. */
  currentTurnStartedAt?: string | null;
  summary: string | null;
  runtimeState: TerminalRuntimeState;
  pendingInputItemId?: string | null;
  /**
   * Settled-lifecycle columns (terminal_sessions.settled_at / status_note /
   * attention_requested_at / attention_message / last_turn_failed_at). All
   * optional for migration tolerance; nullable-ISO semantics match
   * lastActivityAt. settledAt presence = the settled tier (activity clears it
   * at the write site). statusNote is the agent-authored glanceable status line,
   * trimmed to at most 72 characters — agents are asked to aim for 6 words or
   * fewer (and it is used as the outcome once settled).
   * attentionRequestedAt/-Message carry an
   * `ade chat ask` escalation for chat sessions. lastTurnFailedAt marks a chat
   * turn that died on a runtime/API error (cleared on next turn start).
   */
  settledAt?: string | null;
  statusNote?: string | null;
  attentionRequestedAt?: string | null;
  attentionMessage?: string | null;
  /** Auditable owner of the current explicit attention declaration. */
  attentionSource?: SessionAttentionSource | null;
  lastTurnFailedAt?: string | null;
  /**
   * Tri-state settle override (terminal_sessions.settle_override). Optional for
   * migration tolerance; null/undefined both mean "no override". Unlike
   * `settledAt` this is an explicit lifecycle control.
   */
  settleOverride?: SessionSettleOverride | null;
  /** Auditable owner/policy that declared the current settled state. */
  settleSource?: SessionSettleSource | null;
  /**
   * Snooze is a synced VISIBILITY OVERLAY, never a lifecycle phase — it does
   * not touch `canonicalSessionState()`, only where the UI files the row.
   * `snoozedUntil` is the derived-expiry deadline (there is no scheduler: every
   * surface compares it to now via `isSessionSnoozed`). `snoozedAt` is when the
   * snooze was taken and is load-bearing for early wake — an error is only a
   * hand-raise when it is strictly newer than `snoozedAt`, otherwise the error
   * you snoozed on top of would instantly re-wake the row. Nullable-ISO
   * semantics match `settledAt` / `lastActivityAt`.
   */
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  /**
   * "Woke" marker: set when a snooze is cleared, so the UI can explain why the
   * row came back. `wokeAt` is nullable-ISO; the UI clears both on visit
   * (`sessionService.clearWokeMarker`).
   */
  wokeAt?: string | null;
  wokeReason?: SessionWakeReason | null;
  resumeCommand: string | null;
  resumeMetadata?: TerminalResumeMetadata | null;
  chatIdleSinceAt?: string | null;
  /** Earliest armed, unpaused scheduled wake for chat-backed sessions. */
  nextWakeAt?: string | null;
  /** Current ADE-chat mode, projected for desktop Work-row presentation only. */
  chatActivityMode?: "planning" | null;
  /** Authoritative provider-reported background tasks still running after the foreground turn. */
  activeBackgroundTaskCount?: number;
  /** First tag mirrored from the backing Claude SDK session pointer. */
  claudeTag?: string | null;
  /** Owner session id for attached terminals, historically a parent chat id and now also a tracked CLI session id. */
  chatSessionId?: string | null;
  /**
   * Orchestration-mode fields. Populated only when the underlying chat session
   * is part of an orchestration run; the sidebar renders role pills from these.
   * All optional for migration tolerance.
   */
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationTag?: string;
  /**
   * Spawn lineage for chat- and tracked CLI-backed sessions, projected from the
   * chat record or CLI resume metadata (independent of any orchestration run).
   * `orchestrationParentSessionId` marks work spawned by another chat; `spawnKind`
   * is the spawner-declared relationship (subagent/peer) the sidebar renders as
   * a pill and uses to count a spawner's live children. Both optional
   * for migration tolerance.
   */
  orchestrationParentSessionId?: string;
  spawnKind?: AgentChatSpawnKind;
};

export type SessionAttentionSource = "agent_explicit" | "provider_structured" | "user";
export type SessionSettleSource = "agent_explicit" | "user" | "pr_merge" | "operator";

export type TerminalSessionDetail = TerminalSessionSummary & {
  // Reserved for future expansion (goal/tool templates, derived deltas, etc.)
};

export type ClaudeSessionPointer = {
  sessionId: string;
  laneId: string;
  laneName: string;
  chatSessionId: string | null;
  title: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type WindowsShellKind = "powershell" | "cmd" | "git-bash";

export type PtyCreateArgs = {
  sessionId?: string;
  /** Allow callers to pre-assign a new session id instead of only resuming an existing tracked session. */
  allowNewSessionId?: boolean;
  /** Allow an explicit absolute cwd outside the selected lane worktree. */
  allowExternalCwd?: boolean;
  /** Session that owns this attached terminal, when launched from chat/CLI UI or App Control. */
  chatSessionId?: string | null;
  /** Parent chat lineage to export to a spawned agent CLI process. */
  spawnLineage?: { parentChatSessionId: string; spawnKind: AgentChatSpawnKind | null } | null;
  laneId: string;
  cwd?: string;
  cols: number;
  rows: number;
  title: string;
  tracked?: boolean;
  toolType?: TerminalToolType | null;
  startupCommand?: string;
  /**
   * Shell-specific variants of startupCommand. On Windows the PTY selects the
   * entry only after a native shell has spawned, so fallback shell selection
   * cannot accidentally receive another shell's syntax.
   */
  windowsStartupCommands?: Partial<Record<WindowsShellKind, string>>;
  startupDelayMs?: number;
  /** Optional input to send to the PTY after the process starts. */
  initialInput?: string;
  initialInputDelayMs?: number;
  initialInputReadyTimeoutMs?: number;
  /** When true, create rejects if initialInput cannot be delivered. */
  awaitInitialInput?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Fresh provider-launch intent that must be materialized by the runtime
   * which owns the lane. This keeps shell choice, skill roots, home paths, and
   * path-list delimiters native to a pinned remote host.
   */
  runtimeCliLaunch?: {
    provider: AgentChatCliLaunchProvider;
    permissionMode: AgentChatPermissionMode;
    orchestrationRole?: OrchestrationRole | null;
    sessionId?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
    initialPrompt?: string | null;
  };
  /** Optional provider continuation metadata to persist for externally imported sessions. */
  resumeMetadata?: TerminalResumeMetadata | null;
  /**
   * Linear issues to attach to this session before the process spawns, so the
   * CLI agent inherits `ADE_LINEAR_ISSUE_IDS` + `ADE_LINEAR_CONTEXT_FILE` and
   * can read/update its issue through `ade linear` (no Linear MCP/creds needed).
   */
  linearIssues?: LaneLinearIssue[];
};

export type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
  pid: number | null;
};

export type PtyDisposeResult = {
  disposed: boolean;
  reason: "disposed" | "orphaned" | "missing" | "not-running" | "session-mismatch" | "owned-by-peer" | "already-disposed";
};

export type PtySendToSessionArgs = {
  sessionId: string;
  text: string;
  cols?: number | null;
  rows?: number | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  permissionMode?: AgentChatPermissionMode | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy | null;
  codexSandbox?: AgentChatCodexSandbox | null;
  codexConfigSource?: AgentChatCodexConfigSource | null;
};

export type PtyResumeSessionArgs = Omit<PtySendToSessionArgs, "text">;

export type PtySendToSessionResult = PtyCreateResult & {
  session: TerminalSessionSummary | null;
  resumed: boolean;
  reusedExistingRuntime: boolean;
};

export type PtyResumeSessionResult = PtySendToSessionResult;

export type PtyDataEvent = {
  ptyId: string;
  sessionId: string;
  projectRoot?: string;
  data: string;
  /**
   * True when `data` is an authoritative terminal snapshot that must replace
   * the renderer's current xterm state instead of being appended.
   */
  replace?: boolean;
  /**
   * Transcript end offset (UTF-8 bytes) after this chunk was appended. null
   * when the transcript can no longer mirror the stream (untracked session,
   * transcript writes disabled, or the transcript byte cap was reached).
   */
  offset?: number | null;
};

export type PtyExitEvent = {
  ptyId: string;
  sessionId: string;
  projectRoot?: string;
  exitCode: number | null;
};

export type ChatTerminalSession = {
  terminalId: string;
  ptyId: string | null;
  chatSessionId: string | null;
  laneId: string;
  laneName: string;
  title: string;
  toolType: TerminalToolType | null;
  goal: string | null;
  status: TerminalSessionStatus;
  runtimeState: TerminalRuntimeState;
  active: boolean;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  resumeCommand: string | null;
  resumeMetadata?: TerminalResumeMetadata | null;
  lastOutputPreview: string | null;
  summary: string | null;
};

export type ChatTerminalListArgs = {
  chatSessionId?: string | null;
  laneId?: string | null;
  limit?: number | null;
};

export type ChatTerminalReadArgs = {
  terminalId?: string | null;
  ptyId?: string | null;
  chatSessionId?: string | null;
  maxBytes?: number | null;
  since?: number | null;
};

export type ChatTerminalReadResult = {
  terminalId: string;
  data: string;
  nextSince: number;
};

export type ChatTerminalWriteArgs = {
  terminalId?: string | null;
  ptyId?: string | null;
  chatSessionId?: string | null;
  data: string;
};

export type ChatTerminalResizeArgs = {
  terminalId?: string | null;
  ptyId?: string | null;
  chatSessionId?: string | null;
  cols: number;
  rows: number;
};

export type ChatTerminalSignalArgs = {
  terminalId?: string | null;
  ptyId?: string | null;
  chatSessionId?: string | null;
  signal: "SIGINT" | "SIGTERM" | "SIGKILL";
};

export type ChatTerminalActiveForChatArgs = {
  chatSessionId: string;
};

export type ChatTerminalReattachArgs = {
  chatSessionId: string;
  cols?: number | null;
  rows?: number | null;
};

export type ChatTerminalReattachResult = {
  terminalId: string;
  ptyId: string;
  pid: number | null;
  relaunched: boolean; // false when the existing PTY was already live
};

export type TerminalSnapshotCell = {
  text: string;
  fg: number | null;
  bg: number | null;
  fgMode: "default" | "palette" | "rgb";
  bgMode: "default" | "palette" | "rgb";
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
};

export type TerminalSnapshotRow = {
  cells: TerminalSnapshotCell[];
  text: string;
  wrapped: boolean;
};

export type TerminalSerializedSnapshot = {
  version: 1;
  terminalId: string;
  cols: number;
  rows: number;
  capturedAt: string;
  status: TerminalSessionStatus;
  runtimeState: TerminalRuntimeState;
  bufferType: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  serialized: string;
  visibleRows: TerminalSnapshotRow[];
};

export type ChatTerminalPreviewArgs = {
  terminalId?: string | null;
  chatSessionId?: string | null;
  maxBytes?: number | null;
};

export type ChatTerminalPreviewResult = {
  terminalId: string;
  session: ChatTerminalSession;
  source: "snapshot" | "transcript" | "empty";
  snapshot: TerminalSerializedSnapshot | null;
  transcript: string | null;
  capturedAt: string;
};

export type TerminalSessionChangedEvent = {
  sessionId: string;
  reason: "meta-updated" | "deleted" | "created";
};

export type ListSessionsArgs = {
  laneId?: string;
  status?: TerminalSessionStatus;
  limit?: number | null;
  toolTypes?: TerminalToolType[];
};

export type DeleteSessionArgs = {
  sessionId: string;
};

export type UpdateSessionMetaArgs = {
  sessionId: string;
  pinned?: boolean;
  manuallyNamed?: boolean;
  title?: string;
  goal?: string | null;
  toolType?: TerminalToolType | null;
  resumeCommand?: string | null;
  resumeMetadata?: TerminalResumeMetadata | null;
  /**
   * Migrate the session to a different lane. Used by identity sessions (CTO /
   * worker) that must remain pinned to the canonical primary lane even if
   * they were previously persisted against a foreign lane.
   */
  laneId?: string;
};

export type ReadTranscriptTailArgs = {
  sessionId: string;
  maxBytes?: number;
  raw?: boolean;
};

export type SessionDeltaSummary = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedFiles: string[];
  failureLines: string[];
  computedAt: string | null;
};

export type SessionSettlementBlockerCode =
  | "pending_input"
  | "turn_failed"
  | "scheduled_work"
  | "active_workload"
  | "unfinished_goal"
  | "unfinished_plan"
  | "incomplete_report";

export type SessionSettlementBlocker = {
  code: SessionSettlementBlockerCode;
  message: string;
};

export type AgentSessionSettlementResult =
  | {
      ok: true;
      sessionId: string;
    }
  | {
      ok: false;
      sessionId: string;
      blockers: SessionSettlementBlocker[];
    };

export type SessionLifecycleSettings = {
  autoSettleLaneSessionsOnPrMerge: boolean;
};
