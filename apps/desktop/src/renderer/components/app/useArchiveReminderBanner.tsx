import { useCallback, useEffect, useState } from "react";
import { Archive } from "@phosphor-icons/react";
import { useAppBanner, APP_BANNER_PRIORITY } from "../ui/notice/appBannerStore";
import { DEFAULT_ARCHIVE_STALE_DAYS, type ArchiveSummary } from "../../../shared/types/archive";
import { ARCHIVE_REMINDER_INTERVAL_MS, archiveReminderTitle } from "../../../shared/archive";

/**
 * The weekly "clean up your archive" reminder.
 *
 * Archived lanes and chats were forgotten: archive hides them and nothing ever
 * brings them back to mind, while their worktrees and transcripts keep the
 * disk. ADE deletes nothing on its own, so instead it asks — at most once a
 * week per project — when something has sat in the archive for two weeks.
 * Every answer (Review, Remind me next week, ×) pushes the next ask a week out.
 */

const SNOOZE_STORAGE_KEY = "ade.archiveReminder.v1";
const FIRST_CHECK_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 3_600_000;
export const ARCHIVE_SETTINGS_ROUTE = "/settings?tab=archive";

function readSnoozes(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SNOOZE_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function archiveReminderSnoozedUntil(projectRoot: string): number {
  return readSnoozes()[projectRoot] ?? 0;
}

function snoozeArchiveReminder(projectRoot: string, nowMs: number = Date.now()): void {
  try {
    const map = readSnoozes();
    map[projectRoot] = nowMs + ARCHIVE_REMINDER_INTERVAL_MS;
    window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best effort — storage may be unavailable
  }
}

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
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!enabled || !projectRoot) return;
    let cancelled = false;
    const check = () => {
      if (Date.now() < archiveReminderSnoozedUntil(projectRoot)) return;
      window.ade.archive.summary({ olderThanDays: DEFAULT_ARCHIVE_STALE_DAYS })
        .then((next) => {
          if (!cancelled) setSummary(next.staleTotal > 0 ? next : null);
        })
        .catch(() => {});
    };
    const first = window.setTimeout(check, FIRST_CHECK_DELAY_MS);
    const interval = window.setInterval(check, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [enabled, projectRoot]);

  const snooze = useCallback(() => {
    if (projectRoot) snoozeArchiveReminder(projectRoot);
    setSummary(null);
  }, [projectRoot]);

  const review = useCallback(() => {
    snooze();
    onReview();
  }, [onReview, snooze]);

  useAppBanner(
    summary
      ? {
          id: "archive-cleanup-reminder",
          tone: "neutral",
          icon: <Archive size={13} weight="bold" />,
          title: archiveReminderTitle(summary),
          actions: [
            { label: "Review archive", variant: "primary", onClick: review },
            { label: "Remind me next week", variant: "secondary", onClick: snooze },
          ],
          dismiss: { onDismiss: snooze },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.default },
  );
}
