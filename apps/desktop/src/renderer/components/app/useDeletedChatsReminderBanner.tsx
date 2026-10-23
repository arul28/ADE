import { useCallback, useEffect, useState } from "react";
import { ChatsCircle } from "@phosphor-icons/react";
import { useAppBanner, APP_BANNER_PRIORITY } from "../ui/notice/appBannerStore";
import type { DeletedLaneChatsSummary } from "../../../shared/types/storage";
import { formatBytes } from "../../lib/format";
import { settingsRouteFor } from "../settings/settingsManifest";

/**
 * The "chats from deleted lanes are still on disk" reminder.
 *
 * Deleting a lane removes its chats from ADE but leaves their transcripts in
 * the project's `.ade/transcripts/chat` folder, where nothing in ADE shows
 * them again. ADE never deletes them on its own, so once enough have piled
 * up it says so, at most once every two weeks per project. Every answer
 * (Review, Later, ×) pushes the next ask two weeks out.
 */

const SNOOZE_STORAGE_KEY = "ade.deletedChatsReminder.v1";
const SNOOZE_MS = 14 * 24 * 3_600_000;
const FIRST_CHECK_DELAY_MS = 45_000;
const RECHECK_INTERVAL_MS = 6 * 3_600_000;
const MIN_CHATS = 25;
const MIN_BYTES = 100 * 1024 * 1024;
export const STORAGE_SETTINGS_ROUTE = settingsRouteFor("storage.usage");

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

const snoozedUntil = (projectRoot: string): number => readSnoozes()[projectRoot] ?? 0;

function snooze(projectRoot: string): void {
  try {
    const map = readSnoozes();
    map[projectRoot] = Date.now() + SNOOZE_MS;
    window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best effort — storage may be unavailable
  }
}

/** Worth a reminder: enough chats, or enough space, that a person would want to know. */
export function deletedChatsWorthReminding(summary: DeletedLaneChatsSummary): boolean {
  return summary.chatCount >= MIN_CHATS || summary.bytes >= MIN_BYTES;
}

export function deletedChatsReminderTitle(summary: DeletedLaneChatsSummary): string {
  const chats = `${summary.chatCount.toLocaleString()} ${summary.chatCount === 1 ? "chat" : "chats"}`;
  return `${chats} from deleted lanes still take ${formatBytes(summary.bytes)}. ADE no longer tracks them; they are in ${summary.directory}.`;
}

export function useDeletedChatsReminderBanner({
  projectRoot,
  enabled,
  onReview,
}: {
  projectRoot: string | null;
  /** Off while the welcome screen shows or no project is open. */
  enabled: boolean;
  onReview: () => void;
}): void {
  const [summary, setSummary] = useState<DeletedLaneChatsSummary | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!enabled || !projectRoot) return;
    const read = window.ade?.storage?.deletedLaneChatsSummary;
    if (typeof read !== "function") return;
    let cancelled = false;
    const check = () => {
      if (Date.now() < snoozedUntil(projectRoot)) return;
      // Unpinned on purpose: the project tab's own machine owns these files.
      read()
        .then((next) => {
          if (cancelled || Date.now() < snoozedUntil(projectRoot)) return;
          setSummary(deletedChatsWorthReminding(next) ? next : null);
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

  const later = useCallback(() => {
    if (projectRoot) snooze(projectRoot);
    setSummary(null);
  }, [projectRoot]);

  const review = useCallback(() => {
    later();
    onReview();
  }, [later, onReview]);

  useAppBanner(
    summary
      ? {
          id: "deleted-chats-cleanup-reminder",
          tone: "neutral",
          icon: <ChatsCircle size={13} weight="bold" />,
          title: deletedChatsReminderTitle(summary),
          actions: [
            { label: "Review in Storage", variant: "primary", onClick: review },
            { label: "Remind me later", variant: "secondary", onClick: later },
          ],
          dismiss: { onDismiss: later },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.default },
  );
}
