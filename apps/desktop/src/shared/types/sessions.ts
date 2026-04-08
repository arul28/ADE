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

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed";

export type TerminalToolType =
  | "shell"
  | "run-shell"
  | "claude"
  | "codex"
  | "claude-orchestrated"
  | "codex-orchestrated"
  | "opencode-orchestrated"
  | "codex-chat"
  | "claude-chat"
  | "opencode-chat"
  | "cursor"
  | "aider"
  | "continue"
  | "other";

export type TerminalRuntimeState = "running" | "waiting-input" | "idle" | "exited" | "killed";

export type TerminalResumeProvider = "claude" | "codex";

export type TerminalResumeTargetKind = "session" | "thread";

export type TerminalResumeLaunchConfig = {
  permissionMode?: AgentChatPermissionMode | null;
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
  tracked: boolean;
  pinned: boolean;
  manuallyNamed?: boolean;
  goal: string | null;
  toolType: TerminalToolType | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
  runtimeState: TerminalRuntimeState;
  resumeCommand: string | null;
  resumeMetadata?: TerminalResumeMetadata | null;
};

export type TerminalSessionDetail = TerminalSessionSummary & {
  // Reserved for future expansion (goal/tool templates, derived deltas, etc.)
};

export type PtyCreateArgs = {
  laneId: string;
  cwd?: string;
  cols: number;
  rows: number;
  title: string;
  tracked?: boolean;
  toolType?: TerminalToolType | null;
  startupCommand?: string;
};

export type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
};

export type PtyDataEvent = {
  ptyId: string;
  sessionId: string;
  data: string;
};

export type PtyExitEvent = {
  ptyId: string;
  sessionId: string;
  exitCode: number | null;
};

export type ListSessionsArgs = {
  laneId?: string;
  status?: TerminalSessionStatus;
  limit?: number;
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
