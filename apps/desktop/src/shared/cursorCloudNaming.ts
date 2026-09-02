/**
 * Cursor Cloud naming rules that both processes have to state identically.
 *
 * Cursor owns the name of a cloud agent. The renderer refuses a rename in the
 * row menu, the palette, and the lifecycle action; main refuses the same write
 * in `updateSession`, `regenerateSessionMetadata`, and the user-facing
 * `sessions.updateMeta` / `work.updateSessionMeta` paths. One user-visible
 * sentence, so the layer that catches the refusal cannot change what it says.
 */
export const CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE =
  "Cursor Cloud agent names are managed by Cursor. Rename this agent on cursor.com.";

/**
 * True when Cursor owns this chat's name, so ADE must not rename it.
 *
 * A promoted chat carries the remote agent id. The id is trimmed before the
 * test: a whitespace-only id is not a cloud agent, and reading it three
 * different ways is how the row menu and the palette started disagreeing
 * about whether Rename is offered.
 */
export function cursorOwnsSessionName(
  cursorCloudAgentId?: string | null,
): boolean {
  return Boolean(cursorCloudAgentId?.trim());
}

type ChatSummaryWithCloudId = {
  cursorCloudAgentId?: string | null;
};

/**
 * Refuse a user-facing title / manuallyNamed write when Cursor owns the name.
 *
 * `sessionService.updateMeta` is also the internal writer Cursor's own name
 * lands through, so the guard lives on the user-facing commands (IPC, sync,
 * ADE `session.updateMeta`) instead of inside `updateMeta` itself. Pin and
 * other non-title patches stay allowed.
 */
export async function assertCursorCloudRenameAllowed(
  getSessionSummary:
    | ((sessionId: string) => Promise<ChatSummaryWithCloudId | null>)
    | null
    | undefined,
  args: { sessionId?: string; title?: unknown; manuallyNamed?: unknown },
): Promise<void> {
  if (args.title === undefined && args.manuallyNamed === undefined) return;
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
  if (!sessionId || !getSessionSummary) return;
  const chat = await getSessionSummary(sessionId);
  if (cursorOwnsSessionName(chat?.cursorCloudAgentId)) {
    throw new Error(CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE);
  }
}
