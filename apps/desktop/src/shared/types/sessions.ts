// ---------------------------------------------------------------------------
// Terminal session types
// ---------------------------------------------------------------------------

import type {
  AgentChatPermissionMode,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
} from "./chat";
import type { OrchestrationRole } from "./orchestration";

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed" | "detached";

export type TerminalToolType =
  | "shell"
  | "run-shell"
  | "claude"
  | "codex"
  | "cursor-cli"
  | "droid"
  | "opencode"
  | "claude-orchestrated"
  | "codex-orchestrated"
  | "opencode-orchestrated"
  | "codex-chat"
  | "claude-chat"
  | "opencode-chat"
  | "cursor"
  | "droid-chat"
  | "aider"
  | "continue"
  | "other";

export type TerminalRuntimeState = "running" | "waiting-input" | "idle" | "exited" | "killed";

export type TerminalResumeProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";

export type TerminalResumeTargetKind = "session" | "thread";

export type TerminalResumeLaunchConfig = {
  permissionMode?: AgentChatPermissionMode | null;
  model?: string | null;
  reasoningEffort?: string | null;
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
  summary: string | null;
  runtimeState: TerminalRuntimeState;
  pendingInputItemId?: string | null;
  resumeCommand: string | null;
  resumeMetadata?: TerminalResumeMetadata | null;
  chatIdleSinceAt?: string | null;
  /** Parent chat session id when this terminal was launched from a chat (e.g. App Control, in-chat terminal drawer). */
  chatSessionId?: string | null;
  /**
   * Orchestration-mode fields. Populated only when the underlying chat session
   * is part of an orchestration run; the sidebar renders role pills from these.
   * All optional for migration tolerance.
   */
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationTag?: string;
};

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

export type PtyCreateArgs = {
  sessionId?: string;
  /** Allow callers to pre-assign a new session id instead of only resuming an existing tracked session. */
  allowNewSessionId?: boolean;
  /** Allow an explicit absolute cwd outside the selected lane worktree. */
  allowExternalCwd?: boolean;
  /** Chat session that owns this in-chat terminal, when launched from chat UI or App Control. */
  chatSessionId?: string | null;
  laneId: string;
  cwd?: string;
  cols: number;
  rows: number;
  title: string;
  tracked?: boolean;
  toolType?: TerminalToolType | null;
  startupCommand?: string;
  startupDelayMs?: number;
  /** Optional input to send to the PTY after the process starts. */
  initialInput?: string;
  initialInputDelayMs?: number;
  /** When true, create rejects if initialInput cannot be delivered. */
  awaitInitialInput?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
  pid: number | null;
};

export type PtySendToSessionArgs = {
  sessionId: string;
  text: string;
  cols?: number | null;
  rows?: number | null;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode | null;
};

export type PtySendToSessionResult = PtyCreateResult & {
  session: TerminalSessionSummary | null;
  resumed: boolean;
  reusedExistingRuntime: boolean;
};

export type PtyDataEvent = {
  ptyId: string;
  sessionId: string;
  projectRoot?: string;
  data: string;
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
  limit?: number;
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
