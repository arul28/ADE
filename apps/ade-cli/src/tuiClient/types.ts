import type { AppNavigationRequest, AppNavigationResult } from "../../../desktop/src/shared/types/core";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCursorConfigValue,
  AgentChatDroidPermissionMode,
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatContextUsage,
  AgentChatInteractionMode,
  AgentChatModelInfo,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  CodexThreadGoal,
  PendingInputRequest,
} from "../../../desktop/src/shared/types/chat";
import type {
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "../../../desktop/src/shared/types/externalSessions";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { UsageProviderSource, UsageProviderState } from "../../../desktop/src/shared/types/usage";
import type { BufferedEvent } from "../eventBuffer";
import type { HelpGroup } from "./helpIndex";

export type RuntimeMode = "attached" | "embedded";

export type ProjectLaunchContext = {
  launchCwd: string;
  projectRoot: string;
  workspaceRoot: string;
  laneHint: string | null;
  sessionHint: string | null;
  remote: boolean;
  remoteLabel: string | null;
};

export type ChatHistorySnapshot = AgentChatEventHistorySnapshot;

export type RunAdeActionResult<T = unknown> = {
  domain: string;
  action: string;
  result: T;
  statusHints?: Record<string, unknown>;
};

export type RuntimeEventGapMetadata = {
  gap: true;
  oldestCursor: number | null;
  nextCursor: number | null;
  subscriptionId?: string | null;
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
  /**
   * Fired when the underlying transport drops unexpectedly (attached socket
   * only; embedded runtimes never drop). Optional so partial test doubles and
   * legacy callers stay compatible. Returns an unsubscribe fn.
   */
  onConnectionClose?(handler: () => void): () => void;
  subscribeRuntimeEvents(
    args: {
      category?: BufferedEvent["category"] | null;
      cursor?: number;
      limit?: number;
      replay?: boolean;
      onGap?: (gap: RuntimeEventGapMetadata) => void;
    },
    callback: (event: BufferedEvent) => void,
  ): Promise<() => void>;
  close(): Promise<void>;
};

export type AdeCodeProvider = Extract<AgentChatProvider, "codex" | "claude" | "opencode" | "cursor" | "droid"> | "ollama" | "lmstudio";

/**
 * How a new chat draft is launched. `chat` creates an SDK chat via
 * `chat.createSession`; `cli` starts a tracked provider CLI terminal via the
 * `start_cli_session` action. Mirrors the desktop/iOS Chat/CLI switcher and
 * defaults to `chat`.
 */
export type AdeCodeInterfaceMode = "chat" | "cli";

export type AdeCodeModelState = {
  provider: AdeCodeProvider;
  /** Draft-only: whether the next chat launches as an SDK chat or a tracked CLI terminal. */
  interfaceMode: AdeCodeInterfaceMode;
  model: string;
  modelId: string | null;
  displayName: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  permissionMode: AgentChatPermissionMode;
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  cursorModeId: string | null;
  cursorAvailableModeIds: string[];
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
  | "interface"
  | "import-session"
  | "model"
  | "reasoning"
  | "permission"
  | "codex-fast"
  | "output-style"
  | "refresh-status"
  | "apply";

export type SetupPaneRow = {
  kind: SetupPaneRowKind;
  label: string;
  value: string;
  detail?: string;
  disabled?: boolean;
  cyclable?: boolean;
};

export type { SubagentSnapshot, ChatInfoPlan, ChatInfoPlanStep } from "../../../desktop/src/shared/chatSubagents";
export type { ChatScheduledWorkSnapshot } from "../../../desktop/src/shared/chatScheduledWork";
import type { SubagentSnapshot, ChatInfoPlan } from "../../../desktop/src/shared/chatSubagents";
import type { ChatScheduledWorkSnapshot } from "../../../desktop/src/shared/chatScheduledWork";
import type { SubagentCapability } from "../../../desktop/src/shared/subagentCapabilities";
import type { MissionSnapshot } from "../../../desktop/src/renderer/components/chat/chatMission";

export type { MissionSnapshot } from "../../../desktop/src/renderer/components/chat/chatMission";

export type ChatInfoTodoItem = {
  id: string;
  description: string;
  status: string;
};

/** Lane PR rollup shown in the chat-info pane (same shape the drawer uses). */
export type ChatInfoPrSummary = {
  number: number;
  state: "open" | "merged" | "closed";
  checksPassed: number;
  checksTotal: number;
};

export type ChatInfoSnapshot = {
  provider: AdeCodeProvider;
  modelLabel: string;
  laneLabel: string | null;
  claudeTag?: string | null;
  contextPercent: number | null;
  tokenSummary: string | null;
  goal: CodexThreadGoal | null;
  plan: ChatInfoPlan;
  /** Provider-supplied explanation for the latest plan (desktop CodexPlanCard parity). */
  planExplanation: string | null;
  /** Live streaming text on the latest plan event, when the plan is still forming. */
  planStreamingText: string | null;
  /** Latest todo_update snapshot (desktop ChatTasksPanel parity). */
  todos: ChatInfoTodoItem[];
  /** Schedule kinds only (wakeup/cron/loop/remote_trigger). */
  scheduledWork: ChatScheduledWorkSnapshot[];
  /** Earliest armed, unpaused wake reported by the active chat session. */
  nextWakeAt?: string | null;
  /** Background command tasks (kind background_task). */
  backgroundWork: ChatScheduledWorkSnapshot[];
  /** Open/merged/closed PR on the chat's lane (desktop ChatPrPane parity). */
  pr: ChatInfoPrSummary | null;
  snapshots: SubagentSnapshot[];
  inspectedSubagentId?: string | null;
  streaming: boolean;
  /** Per-runtime subagent capability — drives takeover-vs-inline + which stat fields show. */
  capability: SubagentCapability;
  /** Droid AGI mission snapshot (null for non-AGI sessions). */
  mission: MissionSnapshot | null;
  /**
   * True when the active session is a CLOSED/CRASHED but resumable Claude
   * terminal session (isTerminalSessionResumable in app.tsx). Renders the
   * orange resume row at the top of the chat-info pane.
   */
  resumableTerminal: boolean;
};

export type ModelPickerRightPaneSelection =
  | { kind: "favorites" }
  | { kind: "recents" }
  | { kind: "provider"; provider: AdeCodeProvider };

export type ModelPickerRightPaneContent = {
  kind: "model-picker";
  /** Active surface (chat) we're committing the picked model into. */
  surface: "chat" | "new-chat";
  query: string;
  searchMode: boolean;
  selection: ModelPickerRightPaneSelection;
  providerTabKey?: string | null;
  focusedIndex: number;
  /**
   * Two-column focus within the selection area: `true` = the left category
   * rail (favorites/recents/providers), `false` = the model list. ←/→ move
   * focus between the two; ↑/↓ navigate within the focused column. Ignored
   * while `footerFocus` is set (focus is then in the settings rows).
   */
  railFocused?: boolean;
  footerFocus?: SetupPaneRowKind | null;
  settingsRows?: SetupPaneRow[];
  laneId?: string | null;
  laneLabel?: string | null;
};

// Serializable state carried on the feedback form's RightPaneContent. Mirrors
// the framework-free FeedbackFormState in feedbackForm.ts (type + multiline body
// + toggleable auto-context footer) so the right-pane render, the keyboard input
// guard, and the submit path all read/write the same object. `feedback:
// "submitted"` is the transient flag that switches the pane to the success check.
export interface FeedbackContextMeta {
  type?: "bug" | "idea" | "praise";
  body?: string;
  showContext?: boolean;
  provider?: string | null;
  model?: string | null;
  lane?: string | null;
  lastError?: string | null;
  feedback?: "submitted";
}

export type RightPaneContent =
  | { kind: "empty" }
  | ModelPickerRightPaneContent
  | {
      kind: "help";
      title: string;
      // Live filter text the user has typed into the help search field.
      filterQuery?: string;
      // Focused row in the flattened (filtered) command list, 0-based.
      selectedIndex?: number;
      // Grouped + filtered + ranked rows produced by helpIndex.ts and passed
      // down from app.tsx. Undefined ⇒ the pane builds nothing (empty state).
      groupedRows?: HelpGroup[];
    }
  | { kind: "status"; rows: Array<[string, string]> }
  | {
      kind: "list";
      title: string;
      rows: string[];
      emptyText?: string;
      action?: {
        kind: "switch-lane" | "switch-chat" | "chat-list" | "copy-secret";
        ids: string[];
      };
    }
  | { kind: "details"; title: string; body: string }
  | { kind: "context-usage"; title: string; usage: AgentChatContextUsage | null; error?: string | null }
  | { kind: "diff"; title: string; files: Array<{ path: string; additions?: number; deletions?: number; body?: string }> }
  | { kind: "chat-info"; info: ChatInfoSnapshot }
  | {
      kind: "external-session-browser";
      laneId: string;
      laneLabel: string;
      providerFilter: ExternalSessionProvider | "all";
      query: string;
      sessions: ExternalSessionSummary[];
      loading: boolean;
      error?: string | null;
      importError?: string | null;
      importingKey?: string | null;
      selectedIndex: number;
      actionIndex: number;
      loadedAt?: number | null;
    }
  | {
      // /usage pane: provider quota windows plus this session's tokens and cost.
      kind: "usage";
      title?: string;
      loading?: boolean;
      error?: string | null;
      providerStatuses?: Array<{
        id: string;
        label: string;
        state: UsageProviderState;
        source?: UsageProviderSource;
        updatedAt?: string | null;
        message?: string | null;
      }>;
      quotaWindows?: Array<{ id: string; label: string; percent: number; resetAt?: number | null }>;
      session?: { input: number | null; output: number | null; cost: number | null } | null;
    }
  | {
      kind: "form";
      title: string;
      command: "new-lane" | "rename" | "lane-rename" | "pr-open" | "feedback" | "lane-delete" | "new-lane-from-unstaged" | "chat-delete";
      description?: string;
      laneId?: string;
      sessionId?: string;
      chatDelete?: {
        sessionId: string;
        title: string;
      };
      laneDelete?: {
        laneId: string;
        laneName: string;
        branchRef: string | null;
        dirty: boolean;
      };
      // Present only for the feedback form (command === "feedback"): the
      // multiline form's serializable state (see FeedbackContextMeta).
      feedback?: FeedbackContextMeta;
      // Present only for the new-lane form (command === "new-lane"): branch
      // names fetched once when the form opens, feeding the branch typeahead.
      branches?: Array<{ name: string; remote: boolean }>;
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
      setup?: LaneSetupStatus | null;
      pr: {
        number: number;
        state: "open" | "closed" | "merged";
        url: string;
        checksPassed: number;
        checksTotal: number;
        checksPending: number;
        checksFailed: number;
      } | null;
      chats: {
        active: number;
        closed: number;
        killed: number;
      };
      showFiles: boolean;
      selectedActionIndex: number;
      worktreeAvailable?: boolean;
    };

export type LaneSetupStatus = {
  status: "running" | "failed" | "completed";
  label: string;
  detail?: string;
  templateId?: string | null;
  retryable?: boolean;
};

export type LocalNotice = {
  id: string;
  timestamp: string;
  tone: "info" | "error" | "success";
  text: string;
  // Scope the notice belongs to, captured at creation. Most feedback ("Model set
  // to…", "Attached clipboard image.") describes an action in a specific chat, so
  // it is only rendered in that scope. Holds a chat session id, a per-draft key
  // ("draft:N") when fired in a new-chat draft so feedback can't bleed across
  // drafts, or null = global feedback that falls back to the active chat.
  sessionId?: string | null;
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
