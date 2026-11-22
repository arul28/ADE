import type { CloudSessionRow } from "../../../../account-directory/src/cloud/contract";
import type { TerminalSessionSummary } from "../../shared/types";

/**
 * Saved CLI and shell copies of an ADE Cloud computer that is not on, as Work
 * rows (`cloudSavedCopy`, no PTY). Pure, so the saved chats sync can list
 * them without the viewer (`components/terminals/SavedTerminalCopy.tsx`).
 */

/** Session ids of saved copies: never the id of a live terminal. */
export const SAVED_TERMINAL_PREFIX = "cloud-saved-terminal:";

/** The Work row for a saved CLI or shell copy. */
export function savedTerminalSession(row: CloudSessionRow): TerminalSessionSummary {
  const activity = row.lastActivityAt ?? new Date(row.updatedAt).toISOString();
  return {
    id: `${SAVED_TERMINAL_PREFIX}${row.machineKey}:${row.sessionId}`,
    laneId: row.laneId ?? "unknown",
    laneName: row.laneName ?? "Saved terminals",
    ptyId: null,
    tracked: row.kind === "cli",
    pinned: false,
    goal: null,
    toolType: (row.kind === "shell" ? "shell" : row.toolType ?? "shell") as TerminalSessionSummary["toolType"],
    title: row.title ?? (row.kind === "shell" ? "Shell" : "CLI"),
    status: "completed",
    startedAt: activity,
    endedAt: activity,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: activity,
    summary: null,
    resumeCommand: null,
    runtimeState: "idle",
    cloudSavedCopy: true,
    ...(row.parentChatId ? { orchestrationParentSessionId: row.parentChatId } : {}),
  };
}

/** The computer and session of a saved terminal row, or null for any other row. */
export function savedTerminalAddress(sessionId: string): { machineKey: string; sessionId: string } | null {
  if (!sessionId.startsWith(SAVED_TERMINAL_PREFIX)) return null;
  const rest = sessionId.slice(SAVED_TERMINAL_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split + 1 >= rest.length) return null;
  return { machineKey: rest.slice(0, split), sessionId: rest.slice(split + 1) };
}

export function isSavedTerminalSession(session: Pick<TerminalSessionSummary, "id" | "cloudSavedCopy">): boolean {
  return session.cloudSavedCopy === true && savedTerminalAddress(session.id) != null;
}
