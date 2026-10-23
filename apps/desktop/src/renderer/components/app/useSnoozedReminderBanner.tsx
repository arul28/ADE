import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAppBanner, APP_BANNER_PRIORITY } from "../ui/notice/appBannerStore";

/**
 * A project reminder that asks at most once per snooze window. It checks
 * `firstCheckDelayMs` after the project opens and every `recheckIntervalMs`
 * after that, shows a docked banner when `qualifies` says the summary is worth
 * a reminder, and every answer (review, later, ×) snoozes it for that project.
 * Snoozes live in localStorage under `storageKey`, keyed by project root.
 */

function readSnoozes(storageKey: string): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as unknown;
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

function snoozedUntil(storageKey: string, projectRoot: string): number {
  return readSnoozes(storageKey)[projectRoot] ?? 0;
}

function snooze(storageKey: string, projectRoot: string, snoozeMs: number): void {
  try {
    const map = readSnoozes(storageKey);
    map[projectRoot] = Date.now() + snoozeMs;
    window.localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // best effort — storage may be unavailable
  }
}

export type SnoozedReminderConfig<T> = {
  projectRoot: string | null;
  /** Off while the welcome screen shows or no project is open. */
  enabled: boolean;
  /** Banner id; one per reminder kind. */
  id: string;
  storageKey: string;
  snoozeMs: number;
  firstCheckDelayMs: number;
  recheckIntervalMs: number;
  /** Null when this build or host cannot answer; the reminder then stays quiet. */
  read: (() => Promise<T>) | null;
  qualifies: (summary: T) => boolean;
  icon: ReactNode;
  title: (summary: T) => string;
  reviewLabel: string;
  laterLabel: string;
  onReview: () => void;
};

export function useSnoozedReminderBanner<T>(config: SnoozedReminderConfig<T>): void {
  const { projectRoot, enabled, storageKey, snoozeMs, firstCheckDelayMs, recheckIntervalMs, read, qualifies } = config;
  const [summary, setSummary] = useState<T | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!enabled || !projectRoot || !read) return;
    let cancelled = false;
    const check = () => {
      if (Date.now() < snoozedUntil(storageKey, projectRoot)) return;
      read()
        .then((next) => {
          // The user may have answered the banner while this check was out.
          if (cancelled || Date.now() < snoozedUntil(storageKey, projectRoot)) return;
          setSummary(qualifies(next) ? next : null);
        })
        .catch(() => {});
    };
    const first = window.setTimeout(check, firstCheckDelayMs);
    const interval = window.setInterval(check, recheckIntervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
    // `read` and `qualifies` are module-level or stable per caller; the timers
    // restart only when the project, its enablement or the cadence changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectRoot, storageKey, firstCheckDelayMs, recheckIntervalMs]);

  const later = useCallback(() => {
    if (projectRoot) snooze(storageKey, projectRoot, snoozeMs);
    setSummary(null);
  }, [projectRoot, snoozeMs, storageKey]);

  const { onReview } = config;
  const review = useCallback(() => {
    later();
    onReview();
  }, [later, onReview]);

  useAppBanner(
    summary
      ? {
          id: config.id,
          tone: "neutral",
          icon: config.icon,
          title: config.title(summary),
          actions: [
            { label: config.reviewLabel, variant: "primary", onClick: review },
            { label: config.laterLabel, variant: "secondary", onClick: later },
          ],
          dismiss: { onDismiss: later },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.default },
  );
}
