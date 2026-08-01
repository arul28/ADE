import type { GitHubPrListItem } from "../../../../shared/types/prs";

/**
 * Day/week grouping for the terminal PR buckets.
 *
 * Merged and closed history is a log, not a queue: it only grows, and the useful
 * question is "what shipped, and when", not "what needs attention". Period headers give
 * that shape. Open PRs are deliberately left ungrouped — a work queue reads better flat.
 */

export type PrListGroupHeader = {
  kind: "header";
  /** Stable key for React and for virtualizer measurement. */
  id: string;
  label: string;
  count: number;
  additions: number;
  deletions: number;
  /** What these rows did — "merged" or "closed". Both buckets are grouped. */
  outcome: "merged" | "closed";
};

export type PrListRow = PrListGroupHeader | { kind: "item"; item: GitHubPrListItem };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The timestamp a terminal row is filed under: when it shipped, else last touched. */
export function prListGroupTimestamp(item: GitHubPrListItem): number {
  const raw = item.mergedAt || item.updatedAt || item.createdAt;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** Monday-anchored week start, matching how most people talk about "this week". */
function startOfWeek(date: Date): Date {
  const next = startOfDay(date);
  // getDay(): 0 = Sunday. Shift so Monday is the first day.
  const offset = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - offset);
  return next;
}

function formatDayMonth(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Label for the period `timestamp` falls in, relative to `now`.
 *
 * Recent periods get names people actually use; older ones get an explicit range or
 * month, because "5 weeks ago" is harder to place than "Jul 21 – 27".
 */
export function prListGroupLabel(timestamp: number, now: number): { id: string; label: string } {
  if (!timestamp) return { id: "unknown", label: "Undated" };
  const date = new Date(timestamp);
  const today = startOfDay(new Date(now));
  const day = startOfDay(date);
  const dayDelta = Math.round((today.getTime() - day.getTime()) / DAY_MS);

  if (dayDelta <= 0) return { id: "today", label: "Today" };
  if (dayDelta === 1) return { id: "yesterday", label: "Yesterday" };

  const thisWeek = startOfWeek(new Date(now));
  const itemWeek = startOfWeek(date);
  if (itemWeek.getTime() === thisWeek.getTime()) return { id: "this-week", label: "This week" };

  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);
  if (itemWeek.getTime() === lastWeek.getTime()) return { id: "last-week", label: "Last week" };

  // Within the same calendar year, an explicit week range stays scannable.
  if (itemWeek.getFullYear() === thisWeek.getFullYear()) {
    const weekEnd = new Date(itemWeek);
    weekEnd.setDate(weekEnd.getDate() + 6);
    return {
      id: `week-${itemWeek.toISOString().slice(0, 10)}`,
      label: `${formatDayMonth(itemWeek)} – ${formatDayMonth(weekEnd)}`,
    };
  }

  return {
    id: `month-${date.getFullYear()}-${date.getMonth() + 1}`,
    label: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

/**
 * Interleave period headers into an already-sorted item list.
 *
 * `items` must be newest-first; grouping preserves that order exactly, so the caller's
 * sort remains the single source of truth for row order.
 */
export function buildPrListRows(
  items: GitHubPrListItem[],
  options: { grouped: boolean; now?: number },
): PrListRow[] {
  if (!options.grouped) return items.map((item) => ({ kind: "item" as const, item }));

  const now = options.now ?? Date.now();
  const rows: PrListRow[] = [];
  let current: PrListGroupHeader | null = null;

  for (const item of items) {
    const { id, label } = prListGroupLabel(prListGroupTimestamp(item), now);
    if (!current || current.id !== id) {
      current = {
        kind: "header",
        id,
        label,
        count: 0,
        additions: 0,
        deletions: 0,
        outcome: item.state === "closed" ? "closed" : "merged",
      };
      rows.push(current);
    }
    current.count += 1;
    current.additions += nonNegative(item.additions);
    current.deletions += nonNegative(item.deletions);
    rows.push({ kind: "item", item });
  }

  return rows;
}

/** Indices of header rows, for pinning the active one to the top of the viewport. */
export function prListHeaderIndices(rows: PrListRow[]): number[] {
  const indices: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "header") indices.push(index);
  });
  return indices;
}

/** Compact totals for a period header, e.g. `+1.2k −380`. */
export function formatPrListGroupDiff(additions: number, deletions: number): string | null {
  if (additions <= 0 && deletions <= 0) return null;
  return `+${abbreviateCount(additions)} −${abbreviateCount(deletions)}`;
}

/** Diff stats are absent on older rows and never meaningfully negative. */
function nonNegative(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function abbreviateCount(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}
