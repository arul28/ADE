import { Archive } from "@phosphor-icons/react";
import { DEFAULT_ARCHIVE_STALE_DAYS, type ArchiveSummary } from "../../../shared/types/archive";
import { ARCHIVE_REMINDER_INTERVAL_MS, archiveReminderTitle } from "../../../shared/archive";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useSnoozedReminderBanner } from "./useSnoozedReminderBanner";

/**
 * The weekly "clean up your archive" reminder.
 *
 * Archived lanes and chats were forgotten: archive hides them and nothing ever
 * brings them back to mind, while their worktrees and transcripts keep the
 * disk. ADE deletes nothing on its own, so instead it asks — at most once a
 * week per project — when something has sat in the archive for two weeks.
 * Every answer (Review, Remind me next week, ×) pushes the next ask a week out.
 */

export const ARCHIVE_SETTINGS_ROUTE = settingsRouteFor("archive.items");

const readSummary = () => window.ade.archive.summary({ olderThanDays: DEFAULT_ARCHIVE_STALE_DAYS });
const hasStaleItems = (summary: ArchiveSummary) => summary.staleTotal > 0;

export function useArchiveReminderBanner({
  projectRoot,
  enabled,
  onReview,
}: {
  projectRoot: string | null;
  /** Off while the welcome screen shows or no project is open. */
  enabled: boolean;
  onReview: () => void;
}): void {
  useSnoozedReminderBanner({
    projectRoot,
    enabled,
    id: "archive-cleanup-reminder",
    storageKey: "ade.archiveReminder.v1",
    snoozeMs: ARCHIVE_REMINDER_INTERVAL_MS,
    firstCheckDelayMs: 15_000,
    recheckIntervalMs: 6 * 3_600_000,
    read: readSummary,
    qualifies: hasStaleItems,
    icon: <Archive size={13} weight="bold" />,
    title: archiveReminderTitle,
    reviewLabel: "Review archive",
    laterLabel: "Remind me next week",
    onReview,
  });
}
