/**
 * Canonical Cursor mode IDs and labels.
 *
 * Both AgentChatPane (fallback snapshot) and AgentChatComposer (mode labels)
 * must reference the same set. Import from here instead of hardcoding.
 */

/** The set of Cursor mode IDs exposed to the user in the mode picker. */
export const CURSOR_AVAILABLE_MODE_IDS = ["agent", "ask", "plan", "full-auto"] as const;

export type CursorModeId = (typeof CURSOR_AVAILABLE_MODE_IDS)[number];

/** Human-readable labels for Cursor mode IDs (includes aliases like "default"). */
export const CURSOR_MODE_LABELS: Record<string, string> = {
  agent: "Agent",
  default: "Agent",
  ask: "Ask",
  plan: "Plan",
  "full-auto": "Full auto",
  debug: "Debug",
};

/** The Cursor mode a session runs in when it names none. */
export const CURSOR_DEFAULT_MODE_ID = "agent" satisfies CursorModeId;

/**
 * The native Cursor mode a legacy `permissionMode` asks for, or `null` when it
 * asks for nothing Cursor names.
 *
 * Only the two modes Cursor itself has are mapped. `full-auto` and `plan` are
 * real Cursor modes and `resolveCursorSdkPolicy` already runs the session under
 * them, so the session must say so; leaving `cursorModeId` empty is what made a
 * `--permissions full-auto` child report `agent` in its mode snapshot.
 *
 * `default` and `edit` both run as Cursor `agent`, and `ask` is a deliberate
 * user choice with no legacy spelling. Returning `null` for them keeps absence
 * absent: a materialised `agent` here is read back as a real selection on the
 * next launch and pins the session to it. That is the durable-pin bug the
 * Droid and Claude native controls carry the same warning about.
 */
export function legacyPermissionModeToCursorModeId(
  mode: string | null | undefined,
): CursorModeId | null {
  if (mode === "full-auto") return "full-auto";
  if (mode === "plan") return "plan";
  return null;
}

/**
 * The Cursor mode a session presents, resolving the empty case to the default.
 * Use for display and preview; use `legacyPermissionModeToCursorModeId` when
 * deciding what to persist.
 */
export function effectiveCursorModeId(
  cursorModeId: string | null | undefined,
  permissionMode?: string | null,
): string {
  const explicit = typeof cursorModeId === "string" ? cursorModeId.trim() : "";
  if (explicit.length) return explicit;
  return legacyPermissionModeToCursorModeId(permissionMode) ?? CURSOR_DEFAULT_MODE_ID;
}
