import {
  CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE,
  cursorOwnsSessionName,
} from "../../../desktop/src/shared/cursorCloudNaming";

/**
 * ADE Code's copy of the Cursor-owns-name rule. Returns the blocked sentence
 * when Rename must not open, otherwise null so the form / hotkey / slash
 * command can proceed.
 */
export function cursorCloudRenameBlockedReason(
  session: { cursorCloudAgentId?: string | null } | null | undefined,
): string | null {
  return cursorOwnsSessionName(session?.cursorCloudAgentId)
    ? CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE
    : null;
}
