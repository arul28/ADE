import {
  isTrackedAgentCliToolType,
  type TerminalRuntimeState,
  type TerminalSessionStatus,
  type TerminalToolType,
  type TrackedAgentCliToolType,
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
  "muse",
  "qwen",
  "kimi",
  "grok",
  "copilot",
  "antigravity",
  "claude-orchestrated",
  "codex-orchestrated",
  "opencode-orchestrated",
];

/**
 * Whether ADE can reopen this agent CLI after a restart, and so tell it to
 * continue. Every tracked CLI but Devin: ADE never learns a Devin terminal's
 * session id (no resume target, no resume metadata), and `devin --continue`
 * would pick the newest Devin session in the folder, which can belong to
 * another terminal or a Devin chat. A Devin terminal stays closed after a
 * restart, and the stop logs why (`pty.cli_reopen_not_supported`).
 */
export function trackedCliReopensAfterRestart(toolType: TerminalToolType | null | undefined): boolean {
  return isTrackedAgentCliToolType(toolType) && toolType !== "devin";
}

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
