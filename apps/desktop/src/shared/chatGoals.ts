/**
 * What a `/goal` message asks Claude for. ADE reads the command it sends
 * because Claude's CLI does not always report the goal back.
 */
export type ClaudeGoalCommand =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; condition: string };

export function parseClaudeGoalCommand(text: string): ClaudeGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "show" };
  if (/^(?:clear|stop|off|reset|none|cancel)$/i.test(argument)) return { kind: "clear" };
  return { kind: "set", condition: argument };
}

/** `system_notice.status` when a chat's goal ends: the phone alert keys on it. */
export const GOAL_REACHED_NOTICE_STATUS = "goal_reached";
export const GOAL_BLOCKED_NOTICE_STATUS = "goal_blocked";
