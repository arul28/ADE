/**
 * ADE-facing Cursor chat selections and labels.
 *
 * Both AgentChatPane (fallback snapshot) and AgentChatComposer (mode labels)
 * must reference the same set. Import from here instead of hardcoding.
 */

/** The set of Cursor selections exposed to the user in the mode picker. */
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

/** Format provider-returned Cursor mode ids consistently across every surface. */
export function formatCursorModeLabel(modeId: string): string {
  const normalized = modeId.trim().toLowerCase();
  if (!normalized.length) return CURSOR_MODE_LABELS.agent;
  if (CURSOR_MODE_LABELS[normalized]) return CURSOR_MODE_LABELS[normalized];
  return normalized
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * The ADE-facing Cursor selection a legacy `permissionMode` asks for, or `null` when it
 * asks for nothing Cursor names.
 *
 * `full-auto` and `plan` are ADE selections; the provider SDK still receives
 * its supported execution mode separately. Leaving `cursorModeId` empty made a
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
