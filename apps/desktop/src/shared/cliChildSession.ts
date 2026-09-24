import type {
  TerminalRuntimeState,
  TerminalSessionStatus,
  TrackedAgentCliToolType,
} from "./types/sessions";

/**
 * Every tracked agent CLI tool type, for queries that must scope a session
 * list to agent CLIs. Kept in step with `isTrackedAgentCliToolType` (a test
 * asserts every entry passes it and the guard rejects nothing listed here).
 */
export const TRACKED_AGENT_CLI_TOOL_TYPES: readonly TrackedAgentCliToolType[] = [
  "claude",
  "codex",
  "cursor-cli",
  "droid",
  "opencode",
  "pi",
  "qwen",
  "kimi",
  "grok",
  "copilot",
  "claude-orchestrated",
  "codex-orchestrated",
  "opencode-orchestrated",
];

/**
 * What `ade chat status` / `ade chat read` add when the id names a tracked CLI
 * terminal rather than a chat: the terminal's own facts plus where to read
 * its full output. Optional on every consumer; older hosts omit it.
 */
export type CliSessionFacts = {
  toolType: string | null;
  provider: string | null;
  status: TerminalSessionStatus;
  exitCode: number | null;
  laneId: string;
  title: string | null;
  endedAt: string | null;
  parentSessionId: string | null;
  spawnKind: "subagent" | "peer" | null;
  /** The command that reads the full terminal output. */
  readHint: string;
};

/** One tracked CLI child in `chat.listCliChildSessions` (and so `ade chat list`). */
export type AgentChatCliChildSessionSummary = {
  sessionId: string;
  kind: "cli";
  provider: string;
  laneId: string;
  title: string | null;
  status: TerminalSessionStatus;
  runtimeState: TerminalRuntimeState | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  parentSessionId: string;
  spawnKind: "subagent" | "peer";
  readHint: string;
};
