/**
 * Cursor Cloud naming rules that both processes have to state identically.
 *
 * Cursor owns the name of a cloud agent. The renderer refuses a rename in the
 * row menu, the palette, and the lifecycle action; main refuses the same write
 * in `updateSession`, `regenerateSessionMetadata`, and the user-facing
 * `sessions.updateMeta` / `work.updateSessionMeta` paths. One user-visible
 * sentence, so the layer that catches the refusal cannot change what it says.
 *
 * Plugin runtimes may declare the same lock with `chatRuntimes[].ownsName`.
 * That path uses a different sentence because the owner is not Cursor.
 */
export const CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE =
  "Cursor Cloud agent names are managed by Cursor. Rename this agent on cursor.com.";

export const PLUGIN_RUNTIME_RENAME_BLOCKED_MESSAGE =
  "This chat's name is managed by the plugin that owns it.";

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

export type SessionNameLockFields = {
  cursorCloudAgentId?: string | null;
  runtimeRef?: { ownsName?: boolean } | null;
};

/**
 * True when ADE must not rename this chat: Cursor owns the name, or the
 * plugin runtime declared `ownsName`.
 */
export function sessionNameIsLocked(session: SessionNameLockFields): boolean {
  return cursorOwnsSessionName(session.cursorCloudAgentId)
    || session.runtimeRef?.ownsName === true;
}

/** The sentence to show when {@link sessionNameIsLocked} is true. */
export function sessionRenameBlockedMessage(session: SessionNameLockFields): string {
  if (cursorOwnsSessionName(session.cursorCloudAgentId)) {
    return CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE;
  }
  return PLUGIN_RUNTIME_RENAME_BLOCKED_MESSAGE;
}

type ChatSummaryWithNameLock = SessionNameLockFields;

/**
 * Refuse a user-facing title / manuallyNamed write when Cursor or a plugin
 * runtime owns the name.
 *
 * `sessionService.updateMeta` is also the internal writer Cursor's own name
 * lands through, so the guard lives on the user-facing commands (IPC, sync,
 * ADE `session.updateMeta`) instead of inside `updateMeta` itself. Pin and
 * other non-title patches stay allowed.
 */
export async function assertCursorCloudRenameAllowed(
  getSessionSummary:
    | ((sessionId: string) => Promise<ChatSummaryWithNameLock | null>)
    | null
    | undefined,
  args: { sessionId?: string; title?: unknown; manuallyNamed?: unknown },
): Promise<void> {
  if (args.title === undefined && args.manuallyNamed === undefined) return;
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
  if (!sessionId || !getSessionSummary) return;
  const chat = await getSessionSummary(sessionId);
  if (!chat || !sessionNameIsLocked(chat)) return;
  throw new Error(sessionRenameBlockedMessage(chat));
}
