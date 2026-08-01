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

/**
 * The one hue per section, and the reason the badge can only ever be amber:
 * amber means "your move" and nothing else, blue means work is happening,
 * emerald means it finished cleanly. Same table as
 * `shared/sessionStatusPresentation.ts` — see the one-hue-one-meaning rule there.
 */
export const ACTIVITY_SECTION_TONE = {
  "needs-you": "amber",
  working: "blue",
  done: "emerald",
} as const satisfies Record<ActivitySectionId, "amber" | "blue" | "emerald">;

export type ActivitySummary = {
  /** All three sections, always, in priority order. */
  sections: ActivitySection[];
  needsYouCount: number;
  workingCount: number;
  doneCount: number;
  /** Every non-expired, non-dismissed item — what "Open all" leads to. */
  trackedCount: number;
  /** Filed items whose machine is offline, i.e. last-known state only. */
  staleMachineCount: number;
  machinesOnline: number;
  machinesTotal: number;
  tone: "amber" | "blue" | "emerald" | "neutral";
  headline: string;
};

/**
 * Everything the Activity header claims, derived once so the trigger, its
 * accessible label, the sections, and the footer can never disagree.
 */
export function summarizeActivity(
  input: ActivityItemsInput,
  now = Date.now(),
): ActivitySummary {
  const sections = activitySections(input, now);
  const machinesOnline = new Set<string>();
  const machinesTotal = new Set<string>();
  let trackedCount = 0;

  for (const item of activityInputItems(input)) {
    if (activityItemIsExpired(item, now)) continue;
    machinesTotal.add(item.machine.machineKey);
    if (item.machine.online) machinesOnline.add(item.machine.machineKey);
    if (!item.dismissedAt) trackedCount += 1;
  }

  const needsYouCount = sections[0]?.items.length ?? 0;
  const workingCount = sections[1]?.items.length ?? 0;
  const doneCount = sections[2]?.items.length ?? 0;
  // "Working" rows on an offline machine are the normal shape of a machine that
  // went away mid-turn, so they count too: the whole point of the note is that
  // the state on screen is remembered rather than observed.
  const staleMachineCount = sections.reduce(
    (total, section) =>
      total + section.items.filter((item) => !item.machine.online).length,
    0,
  );

  const tone = needsYouCount > 0
    ? "amber"
    : workingCount > 0
      ? "blue"
      : doneCount > 0
        ? "emerald"
        : "neutral";

  return {
    sections,
    needsYouCount,
    workingCount,
    doneCount,
    trackedCount,
    staleMachineCount,
    machinesOnline: machinesOnline.size,
    machinesTotal: machinesTotal.size,
    tone,
    headline: activityHeadline(input, now),
  };
}

/** Tooltip and accessible name for the Activity header trigger. */
export function activityTriggerLabel(summary: ActivitySummary): string {
  const parts: string[] = [];
  if (summary.needsYouCount > 0) {
    parts.push(`${summary.needsYouCount} need${summary.needsYouCount === 1 ? "s" : ""} you`);
  }
  if (summary.workingCount > 0) parts.push(`${summary.workingCount} working`);
  if (summary.doneCount > 0) parts.push(`${summary.doneCount} done`);
  if (parts.length === 0) return "Activity · all agents idle";
  return `Activity · ${parts.join(" · ")}`;
}
