/**
 * Environment variables that describe the Claude Code session a process was
 * started from, not a setting of the process itself.
 *
 * ADE is a host, never a child of the Claude session that happened to start
 * it (a dev app or brain launched from an agent shell). Left in place, the
 * markers reach every terminal ADE opens: a `claude` there believes it is a
 * child session and turns transcript saving off ("inherited
 * CLAUDE_CODE_CHILD_SESSION marker"), so a resumed session silently stops
 * recording. User settings such as `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` are
 * left alone.
 */
export const PARENT_CLAUDE_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
] as const;

/** Removes the parent-session markers in place; returns the keys it removed. */
export function stripParentClaudeSessionEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of PARENT_CLAUDE_SESSION_ENV_KEYS) {
    if (key in env) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}
