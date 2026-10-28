import { ChatsCircle } from "@phosphor-icons/react";
import type { DeletedLaneChatsSummary } from "../../../shared/types/storage";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { formatBytes } from "../../lib/format";
import { useSnoozedReminderBanner } from "./useSnoozedReminderBanner";

/**
 * The "chats from deleted lanes are still on disk" reminder.
 *
 * Deleting a lane removes its chats from ADE but leaves their transcripts in
 * the project's `.ade/transcripts/chat` folder, where nothing in ADE shows
 * them again. ADE never deletes them on its own, so once enough have piled
 * up it says so, at most once every two weeks per project.
 */

const MIN_CHATS = 25;
const MIN_BYTES = 100 * 1024 * 1024;

/** Worth a reminder: enough chats, or enough space, that a person would want to know. */
export function deletedChatsWorthReminding(summary: DeletedLaneChatsSummary): boolean {
  return summary.chatCount >= MIN_CHATS || summary.bytes >= MIN_BYTES;
}

export function deletedChatsReminderTitle(summary: DeletedLaneChatsSummary): string {
  const chats = `${summary.chatCount.toLocaleString()} ${summary.chatCount === 1 ? "chat" : "chats"}`;
  // One short line; where the files live is shown in Storage.
  return `${chats} from deleted lanes (${formatBytes(summary.bytes)}) are no longer tracked`;
}

// Unpinned on purpose: the project tab's own machine owns these files.
const readSummary = () => window.ade.storage.deletedLaneChatsSummary();

export function useDeletedChatsReminderBanner({
  projectRoot,
  enabled,
  onReview,
}: {
  projectRoot: string | null;
  enabled: boolean;
  onReview: () => void;
}): void {
  useSnoozedReminderBanner({
    projectRoot,
    enabled,
    id: "deleted-chats-cleanup-reminder",
    storageKey: "ade.deletedChatsReminder.v1",
    snoozeMs: 14 * 24 * 3_600_000,
    firstCheckDelayMs: 45_000,
    recheckIntervalMs: 6 * 3_600_000,
    read: isAdeAvailable(window.ade?.storage?.deletedLaneChatsSummary) ? readSummary : null,
    qualifies: deletedChatsWorthReminding,
    icon: <ChatsCircle size={13} weight="bold" />,
    title: deletedChatsReminderTitle,
    reviewLabel: "Review in Storage",
    laterLabel: "Remind me in 2 weeks",
    onReview,
  });
}
