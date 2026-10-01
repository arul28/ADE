import { formatBytes } from "./formatting";
import { ARCHIVE_ITEM_KINDS, type ArchiveItemKind, type ArchiveSummary } from "./types/archive";

/**
 * The words of the weekly "clean up your archive" reminder, shared by the
 * desktop banner and ADE Code's notice so both surfaces say the same thing.
 */

/** Ask at most this often per project, whatever the answer was. */
export const ARCHIVE_REMINDER_INTERVAL_MS = 7 * 24 * 3_600_000;

const KIND_WORDS: Record<ArchiveItemKind, [string, string]> = {
  lane: ["lane", "lanes"],
  chat: ["chat", "chats"],
  shell: ["shell", "shells"],
};

/** "3 lanes and 12 chats (2.1 GB) archived for over 14 days — clean up?" */
export function archiveReminderTitle(summary: ArchiveSummary): string {
  const parts = ARCHIVE_ITEM_KINDS
    .filter((kind) => summary.staleByKind[kind] > 0)
    .map((kind) => {
      const count = summary.staleByKind[kind];
      return `${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}`;
    });
  const what = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0] ?? "Nothing";
  const size = summary.staleBytes && summary.staleBytes > 0 ? ` (${formatBytes(summary.staleBytes)})` : "";
  return `${what}${size} archived for over ${summary.olderThanDays} days — clean up?`;
}
