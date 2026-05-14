import type { AppNavigationRequest, AppNavigationResult } from "../../../desktop/src/shared/types/core";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCursorConfigValue,
  AgentChatDroidPermissionMode,
  AgentChatEventEnvelope,
  AgentChatInteractionMode,
  AgentChatModelInfo,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  PendingInputRequest,
} from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { BufferedEvent } from "../eventBuffer";

export type RuntimeMode = "attached" | "embedded";

export type ProjectLaunchContext = {
  launchCwd: string;
  projectRoot: string;
  workspaceRoot: string;
  laneHint: string | null;
};

export type ChatHistorySnapshot = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  truncated: boolean;
};

export type RunAdeActionResult<T = unknown> = {
  domain: string;
  action: string;
  result: T;
  statusHints?: Record<string, unknown>;
};

export type AdeCodeConnection = {
  mode: RuntimeMode;
  projectRoot: string;
  workspaceRoot: string;
  socketPath: string | null;
  fallbackReason?: string | null;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  tool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  action<T = unknown>(domain: string, action: string, args?: Record<string, unknown>): Promise<T>;
  actionList<T = unknown>(domain: string, action: string, argsList: unknown[]): Promise<T>;
  onChatEvent(callback: (event: AgentChatEventEnvelope) => void): () => void;
  subscribeRuntimeEvents(
    args: { category?: BufferedEvent["category"] | null; cursor?: number; limit?: number; replay?: boolean },
    callback: (event: BufferedEvent) => void,
  ): Promise<() => void>;
  close(): Promise<void>;
};

export type AdeCodeProvider = Extract<AgentChatProvider, "codex" | "claude" | "opencode" | "cursor" | "droid">;

export type AdeCodeModelState = {
  provider: AdeCodeProvider;
  model: string;
  modelId: string | null;
  displayName: string;
  reasoningEffort: string | null;
  codexFastMode: boolean;
  permissionMode: AgentChatPermissionMode;
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  cursorModeId: string | null;
  cursorConfigValues: Record<string, AgentChatCursorConfigValue>;
};

export type ProviderReadinessRow = {
  provider: AdeCodeProvider;
  label: string;
  status: "ready" | "unavailable" | "unknown";
  detail: string;
  modelCount: number;
};

export type SetupPaneRowKind =
  | "provider"
  | "model"
  | "reasoning"
  | "permission"
  | "codex-fast"
  | "output-style"
  | "refresh-status"
  | "open-settings"
  | "apply";

export type SetupPaneRow = {
  kind: SetupPaneRowKind;
  label: string;
  value: string;
  detail?: string;
  disabled?: boolean;
  cyclable?: boolean;
};

export type SubagentPaneTab = "subagents" | "teammates";

export type SubagentSnapshot = {
  id: string;
  name: string;
  kind: "subagent" | "teammate";
  status: "running" | "completed" | "failed" | "stopped";
  summary: string;
  parentToolUseId?: string | null;
  turnId?: string | null;
  background?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  tokens?: number;
  durationMs?: number;
  lastToolName?: string;
};

export type RightPaneContent =
  | { kind: "empty" }
  | { kind: "help"; title: string }
  | { kind: "status"; rows: Array<[string, string]> }
  | {
      kind: "list";
      title: string;
      rows: string[];
      emptyText?: string;
      action?: {
        kind: "switch-lane" | "switch-chat";
        ids: string[];
      };
    }
  | { kind: "details"; title: string; body: string }
  | { kind: "diff"; title: string; files: Array<{ path: string; additions?: number; deletions?: number; body?: string }> }
  | { kind: "subagents"; tab: SubagentPaneTab; snapshots: SubagentSnapshot[]; provider: AdeCodeProvider }
  | {
      kind: "new-chat-setup";
      laneId: string;
      laneLabel: string;
      rows: SetupPaneRow[];
    }
  | {
      kind: "form";
      title: string;
      command: "new-lane" | "rename" | "pr-open" | "feedback";
      fields: Array<{
        name: string;
        label: string;
        required?: boolean;
        placeholder?: string;
        initialValue?: string;
      }>;
    }
  | {
      kind: "lane-details";
      lane: LaneSummary;
      git: {
        staged: number;
        unstaged: number;
        total: number;
        ahead: number;
        behind: number;
        remote: string | null;
        additions: number;
        deletions: number;
      };
      files: { path: string; status: "M" | "A" | "D" | "?"; staged: boolean }[];
      pr: { number: number; state: "open" | "closed" | "merged"; url: string; checksPassed: number; checksTotal: number } | null;
      run?: {
        status: "running" | "idle";
        provider: AdeCodeProvider;
        elapsedMs: number | null;
        tokenSummary: string | null;
        toolSummary: string | null;
      } | null;
      showFiles: boolean;
      selectedActionIndex: number;
      worktreeAvailable?: boolean;
    };

export type LocalNotice = {
  id: string;
  timestamp: string;
  tone: "info" | "error" | "success";
  text: string;
};

export type MentionSuggestion = {
  kind: "lane" | "chat" | "pr" | "file" | "commit";
  label: string;
  insertText: string;
  detail?: string;
  filePath?: string;
  attachment?: boolean;
};

export type PendingApproval = {
  itemId: string;
  description: string;
  highStakes: boolean;
  mode: "approval" | "question";
  request?: PendingInputRequest;
};

export type ShellData = {
  project: ProjectLaunchContext;
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  activeLaneId: string | null;
  activeSessionId: string | null;
  activeSession: AgentChatSessionSummary | null;
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  slashCommands: AgentChatSlashCommand[];
  models: AgentChatModelInfo[];
  modelState: AdeCodeModelState;
  rightPane: RightPaneContent;
  contextPercent: number | null;
  streaming: boolean;
  liveAgentCount: number;
  highlightedDrawerLaneId: string | null;
  drawerMode: "chats" | "lanes";
};

export type CreatedChat = AgentChatSession;
export type NavigateRequest = AppNavigationRequest;
export type NavigateResult = AppNavigationResult;
