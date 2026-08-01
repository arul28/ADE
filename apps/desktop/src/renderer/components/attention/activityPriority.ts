import {
  ATTENTION_PHASE_PRIORITY,
  activityItemTier,
  sortAttentionItems,
  type AttentionItem,
} from "../../../shared/types/attention";

export type ActivitySectionId = "needs-you" | "working" | "done";

export type ActivitySectionDescriptor = {
  id: ActivitySectionId;
  label: string;
  order: number;
};

export const ACTIVITY_SECTION_DESCRIPTORS = [
  { id: "needs-you", label: "Needs you", order: 0 },
  { id: "working", label: "Working", order: 1 },
  { id: "done", label: "Done", order: 2 },
] as const satisfies readonly ActivitySectionDescriptor[];

export type ActivitySection = ActivitySectionDescriptor & {
  items: AttentionItem[];
};

type ActivityItemsInput =
  | readonly AttentionItem[]
  | Readonly<Record<string, AttentionItem>>;

function activityInputItems(input: ActivityItemsInput): readonly AttentionItem[] {
  return Array.isArray(input)
    ? input
    : Object.values(input as Readonly<Record<string, AttentionItem>>);
}

function activityItemIsExpired(item: AttentionItem, now: number): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function activitySectionId(item: AttentionItem): ActivitySectionId {
  // Disk-only roster rows are quiet history even when their preserved phase
  // (for example stale) would otherwise fall inside the working band.
  if (activityItemTier(item) === "idle") return "done";

  const priority = ATTENTION_PHASE_PRIORITY[item.phase];
  if (priority <= ATTENTION_PHASE_PRIORITY.blocked) return "needs-you";
  if (priority <= ATTENTION_PHASE_PRIORITY.stale) return "working";
  return "done";
}

/**
 * Priority-flat Activity projection. Every call returns the same three ordered
 * descriptors, including empty sections, so popover, pane, and notch views can
 * share headings without re-declaring their order.
 */
export function activitySections(
  input: ActivityItemsInput,
  now = Date.now(),
): ActivitySection[] {
  const grouped: Record<ActivitySectionId, AttentionItem[]> = {
    "needs-you": [],
    working: [],
    done: [],
  };

  for (const item of activityInputItems(input)) {
    if (item.dismissedAt || activityItemIsExpired(item, now)) continue;
    grouped[activitySectionId(item)].push(item);
  }

  return ACTIVITY_SECTION_DESCRIPTORS.map((descriptor) => {
    const sorted = sortAttentionItems(grouped[descriptor.id]);
    if (descriptor.id !== "done") return { ...descriptor, items: sorted };

    // Idle roster history is the ambient tail even when its preserved phase
    // has a numerically higher priority than a fresh completed outcome.
    const live = sorted.filter((item) => activityItemTier(item) !== "idle");
    const idle = sorted.filter((item) => activityItemTier(item) === "idle");
    return { ...descriptor, items: [...live, ...idle] };
  });
}

/** The Activity badge is intentionally only the first, needs-you section. */
export function activityBadgeCount(input: ActivityItemsInput, now = Date.now()): number {
  return activitySections(input, now)[0]?.items.length ?? 0;
}

export function activityHeadline(input: ActivityItemsInput, now = Date.now()): string {
  const sections = activitySections(input, now);
  const needsYou = sections[0]?.items.length ?? 0;
  if (needsYou > 0) return `${needsYou} need${needsYou === 1 ? "s" : ""} you`;
  const working = sections[1]?.items.length ?? 0;
  if (working > 0) return `${working} working`;
  const done = sections[2]?.items.length ?? 0;
  if (done > 0) return `${done} done`;
  return "All clear";
}
