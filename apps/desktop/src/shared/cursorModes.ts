/**
 * Canonical Cursor mode IDs and labels.
 *
 * Both AgentChatPane (fallback snapshot) and AgentChatComposer (mode labels)
 * must reference the same set. Import from here instead of hardcoding.
 */

/** The set of Cursor mode IDs exposed to the user in the mode picker. */
export const CURSOR_AVAILABLE_MODE_IDS = ["agent", "ask", "plan"] as const;

export type CursorModeId = (typeof CURSOR_AVAILABLE_MODE_IDS)[number];

/** Human-readable labels for Cursor mode IDs (includes aliases like "default"). */
export const CURSOR_MODE_LABELS: Record<string, string> = {
  agent: "Agent",
  default: "Agent",
  ask: "Ask",
  plan: "Plan",
  debug: "Debug",
};
