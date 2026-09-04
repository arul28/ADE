import {
  sessionNameIsLocked,
  sessionRenameBlockedMessage,
} from "../../../desktop/src/shared/cursorCloudNaming";

/**
 * ADE Code's copy of the session-name lock. Returns the blocked sentence
 * when Rename must not open, otherwise null so the form / hotkey / slash
 * command can proceed.
 *
 * Cursor Cloud agents and plugin runtimes that declared `ownsName` both lock
 * the title; the sentence names which.
 */
export function cursorCloudRenameBlockedReason(
  session: {
    cursorCloudAgentId?: string | null;
    runtimeRef?: { ownsName?: boolean } | null;
  } | null | undefined,
): string | null {
  if (!session || !sessionNameIsLocked(session)) return null;
  return sessionRenameBlockedMessage(session);
}
