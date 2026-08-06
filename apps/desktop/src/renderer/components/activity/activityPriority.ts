import {
  activityItemTier,
  attentionItemNeedsInbox,
  sortAttentionItems,
  type AttentionItem,
  type AttentionTone,
} from "../../../shared/types/attention";
import {
  ACTIVITY_STATE_GLYPHS,
  ACTIVITY_STATE_GROUPS,
  activityStateGroup,
  type ActivityStateGroup,
} from "./activityPresentation";

/**
 * A section IS a state group. They were separate vocabularies once — three
 * sections over five states — and the drift showed up as a "Working 0" heading
 * above rows that were plainly working. One table now decides both.
 */
export type ActivitySectionId = ActivityStateGroup;

export type ActivitySectionDescriptor = {
  id: ActivitySectionId;
  label: string;
  order: number;
};

export const ACTIVITY_SECTION_DESCRIPTORS = ACTIVITY_STATE_GROUPS.map(
  (id, order) => ({ id, label: ACTIVITY_STATE_GLYPHS[id].label, order }),
) as readonly ActivitySectionDescriptor[];

/**
 * The sections the header popover is allowed to show: everything live or
 * actionable, and nothing settled. Done is the most final and by far the most
 * common state, and a dropdown that opens onto a wall of finished work buries
 * the two rows that wanted a human. It stays one click away in the full pane,
 * and the footer keeps counting it, so hiding it here costs no information.
 */
export const ACTIVITY_POPOVER_SECTION_IDS: readonly ActivitySectionId[] =
  ACTIVITY_STATE_GROUPS.filter((id) => id !== "done");

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

/** Non-dismissed, non-expired — the rows a surface may render at all. */
function activityLiveItems(
  input: ActivityItemsInput,
  now: number,
): readonly AttentionItem[] {
  return activityInputItems(input).filter(
    (item) => !item.dismissedAt && !activityItemIsExpired(item, now),
  );
}

/**
 * Activity is an AGENT feed. Pull requests, checks and review outcomes keep
 * flowing — they still push, badge, and toast — but they stopped being rows in
 * the session list, because one lane with an open PR rendered twice: once as
 * the agent working on it and once as the PR itself. They live in the
 * Notifications column instead.
 */
export function activityFeedItems(
  input: ActivityItemsInput,
  now = Date.now(),
): AttentionItem[] {
  return activityLiveItems(input, now).filter((item) => item.kind === "agent");
}

/**
 * The notification side: everything that is not an agent and would have pushed
 * a notification. Inbox eligibility is the filter rather than "every PR",
 * because an open pull request nobody is waiting on is not a notification.
 */
export function activityNotificationItems(
  input: ActivityItemsInput,
  now = Date.now(),
): AttentionItem[] {
  return sortAttentionItems(
    activityLiveItems(input, now).filter(
      (item) => item.kind !== "agent" && attentionItemNeedsInbox(item),
    ),
  );
}

/**
 * Priority-flat Activity projection over AGENT items. Every call returns the
 * same ordered descriptors, including empty sections, so popover, pane, and
 * notch views can share headings without re-declaring their order.
 */
export function activitySections(
  input: ActivityItemsInput,
  now = Date.now(),
): ActivitySection[] {
  const grouped = Object.fromEntries(
    ACTIVITY_STATE_GROUPS.map((id) => [id, [] as AttentionItem[]]),
  ) as Record<ActivitySectionId, AttentionItem[]>;

  for (const item of activityFeedItems(input, now)) {
    grouped[activityStateGroup(item)].push(item);
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

/**
 * Every row a mirror surface should carry, in the order Activity files them:
 * the agent sections flattened, then the notification tail. The notch projects
 * from this so its Agents and Events views read from one ordering rather than
 * re-deriving priority in Swift.
 */
export function activityFeedOrder(
  input: ActivityItemsInput,
  now = Date.now(),
): AttentionItem[] {
  return [
    ...activitySections(input, now).flatMap((section) => section.items),
    ...activityNotificationItems(input, now),
  ];
}

/** The Activity badge is intentionally only the needs-you section. */
export function activityBadgeCount(input: ActivityItemsInput, now = Date.now()): number {
  return activitySectionCounts(activitySections(input, now))["needs-you"];
}

export type ActivitySectionCounts = Record<ActivitySectionId, number>;

/**
 * One count per state group, built once from the sections. Everything that used
 * to walk the section list looking for a single id reads this instead: five
 * linear `find`s over the same array, three hand-written priority ladders, and
 * a five-deep ternary for the tone were all the same table written four ways,
 * and they had already drifted (the headline folded `planning` into "working"
 * while the trigger label reported it separately).
 */
export function activitySectionCounts(sections: ActivitySection[]): ActivitySectionCounts {
  const counts = Object.fromEntries(
    ACTIVITY_STATE_GROUPS.map((id) => [id, 0]),
  ) as ActivitySectionCounts;
  for (const section of sections) counts[section.id] = section.items.length;
  return counts;
}

/**
 * The highest-priority group that has anything in it — `ACTIVITY_STATE_GROUPS`
 * is already the priority order, so "which state does this surface lead with"
 * is a `find`, not a ladder.
 */
export function activityLeadingGroup(
  counts: ActivitySectionCounts,
): ActivitySectionId | null {
  return ACTIVITY_STATE_GROUPS.find((id) => counts[id] > 0) ?? null;
}

/**
 * How one group is said out loud. The headline, the trigger tooltip and the
 * pane all use this, so `planning` cannot be its own state in one sentence and
 * be folded into "working" in the next — the fold was the drift, and the glyph
 * language names planning (violet notepad) as its own group, so it is named.
 */
function activityCountPhrase(group: ActivitySectionId, count: number): string {
  switch (group) {
    case "needs-you":
      return `${count} need${count === 1 ? "s" : ""} you`;
    case "failed":
      return `${count} failed`;
    case "planning":
      return `${count} planning`;
    case "working":
      return `${count} working`;
    case "done":
      return `${count} done`;
  }
}

function activityHeadlineFromCounts(counts: ActivitySectionCounts): string {
  const leading = activityLeadingGroup(counts);
  return leading ? activityCountPhrase(leading, counts[leading]) : "All clear";
}

export function activityHeadline(input: ActivityItemsInput, now = Date.now()): string {
  return activityHeadlineFromCounts(activitySectionCounts(activitySections(input, now)));
}

/**
 * The one hue per section, and the reason the badge can only ever be amber:
 * amber means "your move" and nothing else, blue means work is happening,
 * emerald means it finished cleanly. Derived from `ACTIVITY_STATE_GLYPHS` so a
 * hue can only be chosen once — the same table `shared/sessionStatusPresentation.ts`
 * governs, via the one-hue-one-meaning rule documented there.
 */
export const ACTIVITY_SECTION_TONE = Object.fromEntries(
  ACTIVITY_STATE_GROUPS.map((id) => [id, ACTIVITY_STATE_GLYPHS[id].tone]),
) as Record<ActivitySectionId, AttentionTone>;

export type ActivityOfflineMachine = {
  machineKey: string;
  name: string;
  lastSeenAt: string | null;
  itemCount: number;
};

/**
 * Which machines the last-known-state note is actually about. Presence is
 * folded onto every item by the store, so the roster is derived from the rows
 * on screen rather than plumbed separately — a machine with nothing filed is
 * not something the note needs to explain.
 */
export function activityOfflineMachines(
  input: ActivityItemsInput,
  now = Date.now(),
): ActivityOfflineMachine[] {
  const byKey = new Map<string, ActivityOfflineMachine>();
  for (const item of activityLiveItems(input, now)) {
    if (item.machine.online) continue;
    const existing = byKey.get(item.machine.machineKey);
    if (existing) {
      existing.itemCount += 1;
      continue;
    }
    byKey.set(item.machine.machineKey, {
      machineKey: item.machine.machineKey,
      name: item.machine.name,
      lastSeenAt: item.machine.lastSeenAt,
      itemCount: 1,
    });
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export type ActivitySummary = {
  /** Every section, always, in priority order. Agent items only. */
  sections: ActivitySection[];
  /**
   * One count per state group. The five flat fields below are the same numbers
   * spelled out for existing readers; anything that wants to iterate the groups
   * reads this table rather than reassembling one from the flat fields.
   */
  counts: ActivitySectionCounts;
  needsYouCount: number;
  failedCount: number;
  planningCount: number;
  workingCount: number;
  doneCount: number;
  /** Live AGENT rows — the "N sessions" figure, and only sessions. */
  trackedCount: number;
  /** Live notification rows — PR, CI and review outcomes. Counted separately. */
  notificationCount: number;
  /** Filed items whose machine is offline, i.e. last-known state only. */
  staleMachineCount: number;
  offlineMachines: ActivityOfflineMachine[];
  machinesOnline: number;
  machinesTotal: number;
  tone: AttentionTone;
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

  // Only live rows count towards the machine roster: a machine whose every row
  // the user has dismissed is not a machine Activity is still reporting, and
  // counting it made "3 machines" outlive the work that named them.
  for (const item of activityLiveItems(input, now)) {
    machinesTotal.add(item.machine.machineKey);
    if (item.machine.online) machinesOnline.add(item.machine.machineKey);
    if (item.kind === "agent") trackedCount += 1;
  }

  const counts = activitySectionCounts(sections);
  // "Working" rows on an offline machine are the normal shape of a machine that
  // went away mid-turn, so they count too: the whole point of the note is that
  // the state on screen is remembered rather than observed.
  const offlineMachines = activityOfflineMachines(input, now);
  const staleMachineCount = offlineMachines.reduce(
    (total, machine) => total + machine.itemCount,
    0,
  );

  // One hue per group, read off the same table the glyphs come from — a summary
  // can no longer paint a colour the section headings do not use.
  const leading = activityLeadingGroup(counts);
  const tone: AttentionTone = leading ? ACTIVITY_STATE_GLYPHS[leading].tone : "neutral";

  return {
    sections,
    counts,
    needsYouCount: counts["needs-you"],
    failedCount: counts.failed,
    planningCount: counts.planning,
    workingCount: counts.working,
    doneCount: counts.done,
    trackedCount,
    notificationCount: activityNotificationItems(input, now).length,
    staleMachineCount,
    offlineMachines,
    machinesOnline: machinesOnline.size,
    machinesTotal: machinesTotal.size,
    tone,
    headline: activityHeadlineFromCounts(counts),
  };
}

/** Tooltip and accessible name for the Activity header trigger. */
export function activityTriggerLabel(summary: ActivitySummary): string {
  const { counts } = summary;
  const parts = ACTIVITY_STATE_GROUPS
    .filter((group) => counts[group] > 0)
    .map((group) => activityCountPhrase(group, counts[group]));
  if (parts.length === 0) return "Activity · all agents idle";
  return `Activity · ${parts.join(" · ")}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The footer both Activity surfaces show, composed once.
 *
 * It was written twice with different orderings — the pane led with the machine
 * roster, the popover led with the session count and dropped the word "online"
 * from the all-online case — so the same account read two ways depending on
 * which surface you opened. The order is work first, fleet last: what is
 * happening matters more than where, and the machine clause is the one a
 * single-Mac user can ignore. A zero count says nothing rather than "0
 * sessions", except for the machine roster, which has to explain its own
 * silence.
 */
export function activityFooterLine(summary: ActivitySummary): string {
  const machineLine = summary.machinesTotal === 0
    ? "No machines reporting yet"
    : summary.machinesOnline === summary.machinesTotal
      ? `${pluralize(summary.machinesTotal, "machine")} online`
      : `${summary.machinesOnline} of ${pluralize(summary.machinesTotal, "machine")} online`;
  // Sessions and notifications are counted apart because they are different
  // things: "12 sessions" used to include every pull request on the account,
  // which is why the figure never matched the number of chats anyone had.
  return [
    summary.trackedCount > 0 ? pluralize(summary.trackedCount, "session") : null,
    summary.notificationCount > 0
      ? pluralize(summary.notificationCount, "notification")
      : null,
    machineLine,
  ].filter(Boolean).join(" · ");
}
