import { providerDisplayName } from "./contract";
import { relativeTimeCompact, relativeWhen } from "../../../lib/format";
import type { ExternalSessionMessage, ExternalSessionSummary } from "./contract";

export function formatUpdatedAt(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return relativeWhen(new Date(ms).toISOString());
}

/** Short relative time for list rows: "13m", "2d". */
export function formatUpdatedAtCompact(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return relativeTimeCompact(new Date(ms).toISOString());
}

/** "1 prompt", "1,100 prompts"; empty when the count is unknown. */
export function formatPromptCount(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return "";
  return `${count.toLocaleString()} prompt${count === 1 ? "" : "s"}`;
}

/** Whole units above 10 ("40 MB"), one decimal below ("2.4 MB"). */
export function formatSessionSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Date grouping label for the import list. */
export function sessionDateGroup(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms)) return "Older";
  const today = startOfLocalDay(now);
  const then = startOfLocalDay(ms);
  if (then === today) return "Today";
  if (then === today - DAY_MS) return "Yesterday";
  if (now - ms < 7 * DAY_MS) {
    return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  }
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Collapses a prompt to one line so it can stand in as a heading. */
function asHeadingText(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

/**
 * Rows lead with a real provider-persisted title when there is one. Most Claude
 * CLI transcripts have none, which is why every such row used to degrade to
 * "ADE · 9m ago" — the folder name and a timestamp, telling you nothing about
 * the thread. The opening prompt (`preview`) is a far better name for the work,
 * so it comes next, and path+time stays as the last resort.
 */
export function sessionHeading(summary: ExternalSessionSummary): string {
  const title = summary.title?.trim();
  if (title) return title;
  const opening = asHeadingText(summary.preview);
  if (opening) return opening;
  // No title and no opening prompt: the first user message the host sampled,
  // then a plain label. The row already shows the lane and the time, so the
  // old "<folder> · 41d ago" fallback repeated both and named nothing.
  const firstUser = summary.messages?.find((message) => message.role === "user")?.text;
  const sampled = asHeadingText(firstUser ?? null);
  if (sampled) return sampled;
  return `Untitled ${providerDisplayName(summary.provider)} chat`;
}

/**
 * The two anchors a row shows: what the thread started as, and where it left
 * off. Either may be absent — an older host predates both fields, and a thread
 * whose only human text was a slash command has no recoverable prompt.
 *
 * `started` is suppressed when the heading is already showing it, so a row never
 * prints the same sentence twice.
 */
export function sessionAnchors(summary: ExternalSessionSummary): {
  started: string | null;
  latest: ExternalSessionMessage | null;
} {
  const heading = sessionHeading(summary);
  const started = asHeadingText(summary.preview);
  const messages = summary.messages ?? [];
  const latest = messages.length > 0 ? messages[messages.length - 1]! : null;
  const latestText = latest ? asHeadingText(latest.text) : null;
  const startedText = started && started !== heading ? started : null;
  return {
    started: startedText,
    // `latest` is checked against both anchors. Against the heading because an
    // untitled single-message thread has heading === preview === that message,
    // and against `started` because a *titled* one has started === latest. Either
    // collision prints the same sentence twice, which reads as a rendering bug.
    latest: latest && latestText !== heading && latestText !== startedText ? latest : null,
  };
}
