import {
  sortAttentionItems,
  type AttentionItem,
} from "../../../shared/types";
import type { AttentionTone } from "./attentionPresentation";

/**
 * The global header carries one number, so that number has to mean exactly one
 * thing: work that is waiting on the person reading it. Live work is real but
 * it is not a request, so it rides alongside as an ambient pulse instead of
 * inflating the count. Everything the header claims is derived here, once, so
 * the trigger, its label, and the popover can never disagree.
 */
export type AttentionHeaderBucketId =
  | "needs_you"
  | "blocked"
  | "review"
  | "done"
  | "live";

export type AttentionHeaderBucket = {
  id: AttentionHeaderBucketId;
  /** Section heading in the popover. */
  label: string;
  /** Screen-reader/tooltip phrasing for one bucket, already pluralized. */
  summary: string;
  tone: AttentionTone;
  items: AttentionItem[];
};

export type AttentionHeaderSummary = {
  /** Non-empty buckets, most urgent first. */
  buckets: AttentionHeaderBucket[];
  /** needs_you + blocked/failing + done-but-unreviewed. Drives the badge. */
  waitingCount: number;
  liveCount: number;
  /** Every non-expired, non-dismissed item — what "Open all" leads to. */
  trackedCount: number;
  /** Waiting items whose machine is offline, i.e. last-known state only. */
  staleMachineCount: number;
  tone: AttentionTone;
  /** Short truthful phrase: "2 need you", "3 live", "All clear". */
  headline: string;
  machinesOnline: number;
  machinesTotal: number;
};

const BUCKET_ORDER: AttentionHeaderBucketId[] = [
  "needs_you",
  "blocked",
  "review",
  "done",
  "live",
];

const BUCKET_LABEL: Record<AttentionHeaderBucketId, string> = {
  needs_you: "Needs you",
  blocked: "Failing or blocked",
  review: "Waiting on review",
  done: "Done, unreviewed",
  live: "Live now",
};

/**
 * Amber appears exactly once in this table, on `needs_you`, and that is the
 * whole point: the header is the loudest surface ADE has, so the hue that means
 * "your move" must not be shared with anything else. `done` is emerald because
 * a finished run you have not looked at yet is an outcome, not a request —
 * previously it rode in the same violet bucket as an outstanding PR review,
 * which made "go look" and "go review" one indistinguishable colour.
 */
const BUCKET_TONE: Record<AttentionHeaderBucketId, AttentionTone> = {
  needs_you: "amber",
  blocked: "red",
  review: "violet",
  done: "emerald",
  live: "blue",
};

function bucketSummary(id: AttentionHeaderBucketId, count: number): string {
  if (id === "needs_you") return `${count} need${count === 1 ? "s" : ""} you`;
  if (id === "blocked") return `${count} failing or blocked`;
  if (id === "review") return `${count} to review`;
  if (id === "done") return `${count} done`;
  return `${count} live`;
}

function isExpired(item: AttentionItem, now: number): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Phases the header deliberately stays quiet about: `open`, `stale`, `closed`,
 * and outcomes the user already acknowledged. They are neither in motion nor
 * asking for anything, so they belong to the full Attention center.
 *
 * `stale` in particular is a silence, not a signal — it stays out of every
 * bucket so it can never inflate the badge. The same holds for a session the
 * user stopped: it never reaches the header at all, because a stopped run is an
 * outcome the user chose.
 *
 * The loud tier is exactly `needs_you`. Nothing else may enter it — a resting
 * or finished chat lands in `done`, never in the bucket that colours the header
 * amber.
 */
export function attentionHeaderBucketFor(
  item: AttentionItem,
): AttentionHeaderBucketId | null {
  if (item.dismissedAt) return null;
  switch (item.phase) {
    case "needs_you":
      return "needs_you";
    case "blocked":
    case "failed":
    case "checks_failing":
    case "changes_requested":
      return "blocked";
    case "review_requested":
    case "merge_ready":
      return "review";
    case "completed":
    case "merged":
      return item.seenAt ? null : "done";
    case "starting":
    case "running":
      return "live";
    default:
      return null;
  }
}

export function summarizeAttentionForHeader(
  itemsById: Record<string, AttentionItem>,
  now = Date.now(),
): AttentionHeaderSummary {
  const grouped = new Map<AttentionHeaderBucketId, AttentionItem[]>();
  const machinesOnline = new Set<string>();
  const machinesTotal = new Set<string>();
  let trackedCount = 0;
  let staleMachineCount = 0;

  for (const item of Object.values(itemsById)) {
    if (isExpired(item, now)) continue;
    machinesTotal.add(item.machine.machineKey);
    if (item.machine.online) machinesOnline.add(item.machine.machineKey);
    if (!item.dismissedAt) trackedCount += 1;
    const bucket = attentionHeaderBucketFor(item);
    if (!bucket) continue;
    const existing = grouped.get(bucket);
    if (existing) existing.push(item);
    else grouped.set(bucket, [item]);
    if (bucket !== "live" && !item.machine.online) staleMachineCount += 1;
  }

  const buckets: AttentionHeaderBucket[] = [];
  for (const id of BUCKET_ORDER) {
    const items = grouped.get(id);
    if (!items || items.length === 0) continue;
    buckets.push({
      id,
      label: BUCKET_LABEL[id],
      summary: bucketSummary(id, items.length),
      tone: BUCKET_TONE[id],
      items: sortAttentionItems(items),
    });
  }

  const liveCount = grouped.get("live")?.length ?? 0;
  const waitingCount = buckets
    .filter((bucket) => bucket.id !== "live")
    .reduce((total, bucket) => total + bucket.items.length, 0);
  const leading = buckets[0] ?? null;

  return {
    buckets,
    waitingCount,
    liveCount,
    trackedCount,
    staleMachineCount,
    tone: leading?.tone ?? "neutral",
    headline: leading ? leading.summary : "All clear",
    machinesOnline: machinesOnline.size,
    machinesTotal: machinesTotal.size,
  };
}

/** The tooltip and accessible name for the header trigger. */
export function attentionHeaderTriggerLabel(
  summary: AttentionHeaderSummary,
): string {
  if (summary.buckets.length === 0) return "Attention · nothing waiting";
  return `Attention · ${summary.buckets.map((bucket) => bucket.summary).join(" · ")}`;
}
