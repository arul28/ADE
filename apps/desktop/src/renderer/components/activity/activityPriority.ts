import {
  attentionItemNeedsInbox,
  sortAttentionItems,
  type AttentionItem,
  type AttentionTone,
} from "../../../shared/types/attention";
import { activityBoardColumn } from "../../../shared/attention/activityBoardColumn";
import {
  ACTIVITY_COLUMN_PRESENTATION,
  ACTIVITY_COLUMNS,
  activityItemFailed,
  type ActivityColumn,
} from "./activityPresentation";

/**
 * A section IS a Work-board column. Activity, the board, the phone and the Live
 * Activity count by the same four columns, so "2 need you" means the same rows
 * on every surface.
 */
export type ActivitySectionId = ActivityColumn;

export type ActivitySectionDescriptor = {
  id: ActivitySectionId;
  label: string;
  order: number;
};

export const ACTIVITY_SECTION_DESCRIPTORS = ACTIVITY_COLUMNS.map(
  (id, order) => ({ id, label: ACTIVITY_COLUMN_PRESENTATION[id].label, order }),
) as readonly ActivitySectionDescriptor[];

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
 * Agent items grouped by column. Every call returns all four sections in board
 * order, including empty ones, so the popover and the pane share headings
 * without re-declaring their order.
 */
export function activitySections(
  input: ActivityItemsInput,
  now = Date.now(),
): ActivitySection[] {
  const grouped = Object.fromEntries(
    ACTIVITY_COLUMNS.map((id) => [id, [] as AttentionItem[]]),
  ) as Record<ActivitySectionId, AttentionItem[]>;

  for (const item of activityFeedItems(input, now)) {
    const column = activityBoardColumn(item);
    if (column) grouped[column].push(item);
  }

  return ACTIVITY_SECTION_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    items: sortAttentionItems(grouped[descriptor.id]),
  }));
}

/** The Activity badge is the Needs you column, failures included, and nothing else. */
export function activityBadgeCount(input: ActivityItemsInput, now = Date.now()): number {
  return activitySectionCounts(activitySections(input, now)).needs_you;
}

export type ActivitySectionCounts = Record<ActivitySectionId, number>;

/** One count per column, built once from the sections. */
export function activitySectionCounts(sections: ActivitySection[]): ActivitySectionCounts {
  const counts = Object.fromEntries(
    ACTIVITY_COLUMNS.map((id) => [id, 0]),
  ) as ActivitySectionCounts;
  for (const section of sections) counts[section.id] = section.items.length;
  return counts;
}

/** The first column, in board order, that has anything in it. */
export function activityLeadingGroup(
  counts: ActivitySectionCounts,
): ActivitySectionId | null {
  return ACTIVITY_COLUMNS.find((id) => counts[id] > 0) ?? null;
}

/** How one column's count is said out loud: the headline, the tooltip and the chips. */
export function activityCountPhrase(group: ActivitySectionId, count: number): string {
  switch (group) {
    case "needs_you":
      return `${count} need${count === 1 ? "s" : ""} you`;
    case "working":
      return `${count} working`;
    case "waiting":
      return `${count} waiting`;
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
 * The one hue per column: amber is "your move" and nothing else, blue is work
 * happening, neutral is waiting on something outside the agent, emerald is
 * finished.
 */
export const ACTIVITY_SECTION_TONE = Object.fromEntries(
  ACTIVITY_COLUMNS.map((id) => [id, ACTIVITY_COLUMN_PRESENTATION[id].tone]),
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
  /** Every section, always, in board order. Agent items only. */
  sections: ActivitySection[];
  /** One count per column. */
  counts: ActivitySectionCounts;
  /** The Needs you column, failures included — the header badge. */
  needsYouCount: number;
  /** Failed agents inside Needs you, the ones drawn with the red mark. */
  failedCount: number;
  workingCount: number;
  waitingCount: number;
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

  // One hue per column, read off the same table the headings use.
  const leading = activityLeadingGroup(counts);
  const tone: AttentionTone = leading ? ACTIVITY_SECTION_TONE[leading] : "neutral";

  return {
    sections,
    counts,
    needsYouCount: counts.needs_you,
    failedCount: sections
      .find((section) => section.id === "needs_you")
      ?.items.filter(activityItemFailed).length ?? 0,
    workingCount: counts.working,
    waitingCount: counts.waiting,
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

/**
 * Every populated column said out loud, in board order. Callers choose the
 * separator and nothing else, so the header trigger and the chips cannot name
 * the same account with two different vocabularies.
 */
export function activityCountPhrases(counts: ActivitySectionCounts): string[] {
  return ACTIVITY_COLUMNS
    .filter((group) => counts[group] > 0)
    .map((group) => activityCountPhrase(group, counts[group]));
}

/** Tooltip and accessible name for the Activity header trigger. */
export function activityTriggerLabel(summary: ActivitySummary): string {
  const parts = activityCountPhrases(summary.counts);
  if (parts.length === 0) return "Activity · nothing running";
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
