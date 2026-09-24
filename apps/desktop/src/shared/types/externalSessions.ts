export type ExternalSessionProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi"
  // ACP providers: discovered from their own on-disk stores.
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot";

/** Every provider the importer knows, in display order. */
export const EXTERNAL_SESSION_PROVIDERS: readonly ExternalSessionProvider[] = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
  "qwen",
  "kimi",
  "grok",
  "copilot",
];

export const EXTERNAL_SESSION_PROVIDER_LABELS: Record<ExternalSessionProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "Copilot",
};

export function isExternalSessionProvider(value: unknown): value is ExternalSessionProvider {
  return typeof value === "string"
    && (EXTERNAL_SESSION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Where a session lives, resolved against the project's lanes.
 *
 * - `lane`: the session folder is a live lane's worktree or a folder inside it.
 * - `removed-lane`: the folder sits under `.ade/worktrees/` but no live lane owns it.
 * - `outside`: any other folder in the project (never a lane).
 */
export interface ExternalSessionHome {
  kind: "lane" | "removed-lane" | "outside";
  laneId: string | null;
  laneName: string | null;
  branchRef: string | null;
  color: string | null;
  laneType: string | null;
  /** True when the session folder is exactly the lane worktree root, not a subfolder. */
  atLaneRoot: boolean;
}

export interface ExternalSessionCapabilities {
  resumeInPlace: boolean;
  resumeInDifferentCwd: boolean;
  fork: boolean;
  forkIntoDifferentCwd: boolean;
  importToChat: boolean;
}

/** One human/assistant turn sampled from a provider transcript for preview purposes. */
export interface ExternalSessionMessage {
  role: "user" | "assistant";
  text: string;
  at: number | null;
}

export interface ExternalSessionSummary {
  provider: ExternalSessionProvider;
  id: string;
  cwd: string | null;
  title: string | null;
  preview: string | null;
  /**
   * Recent user/assistant exchanges, oldest to newest, so a row can show where the thread
   * left off and a detail view can render a readable slice of it. `preview` already
   * carries the opening prompt, so there is no separate first-prompt field.
   *
   * Additive and optional on purpose: the iOS mirror decodes every field with
   * `decodeIfPresent`, and a decode failure drops the whole row silently. Never re-type an
   * existing field here — only add new nullable ones.
   */
  messages?: ExternalSessionMessage[] | null;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number | null;
  /** Provider launch state recovered from the native session transcript. */
  launch?: TerminalResumeLaunchConfig | null;
  alreadyImported: boolean;
  importedSessionRef?: { kind: "chat" | "cli"; sessionId: string } | null;
  possiblyActive: boolean;
  /**
   * True when ADE imported this provider session before and the ADE row is gone.
   * Browse still lists it as importable; this is a hint, not a hide.
   */
  importedBefore?: boolean;
  cwdMatchesRequestedLane: boolean | null;
  capabilities: ExternalSessionCapabilities;
  /** The lane this session belongs to. Optional: older hosts do not send it. */
  home?: ExternalSessionHome | null;
  /** Size of the provider's session store entry on disk, when one stat call finds it. */
  sizeBytes?: number | null;
}

export interface ExternalSessionListArgs {
  providers?: ExternalSessionProvider[];
  laneId?: string | null;
  cwd?: string | null;
  scope?: "project" | "all";
  limit?: number;
  /** Resolve one provider-native session without scanning or returning the recent list. */
  sessionId?: string | null;
}

export interface ExternalSessionImportArgs {
  provider: ExternalSessionProvider;
  sessionId: string;
  laneId: string;
  target: "cli" | "chat";
  mode: "resume" | "fork";
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  permissionMode?: string;
}

export type ExternalSessionImportResult =
  | { kind: "cli"; sessionId: string; ptyId: string; laneId: string; session?: TerminalSessionSummary }
  | { kind: "chat"; chatSessionId: string; laneId: string; chatSummary: AgentChatSessionSummary };
import type { AgentChatSessionSummary } from "./chat";
import type { TerminalResumeLaunchConfig, TerminalSessionSummary } from "./sessions";
