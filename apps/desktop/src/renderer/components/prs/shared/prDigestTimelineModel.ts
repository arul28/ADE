import type { PrTimelineEvent } from "../../../../shared/types/prs";
import {
  buildPrConversationDigest,
  isOpenThread,
  sectionIndexFor,
  ts,
  type PrConversationDigest,
  type PrDigestBotGroup,
  type PrDigestEntry,
  type PrDigestPush,
  type PrNeedsAttentionItem,
} from "../../../../shared/prConversationDigest";

/**
 * The Overview thread as triage: the description, a pinned Needs-attention
 * block, then one section per push. Inside a section each bot is one folded
 * row; people and lifecycle events stay as full rows in time order.
 *
 * Built from the same `PrTimelineEvent[]` the old replay thread used, so every
 * card (reply, resolve, react, edit) is still the same component underneath.
 */

type CommitPushEvent = Extract<PrTimelineEvent, { type: "commit_push" }>;

export type DigestRenderItem =
  | { kind: "event"; id: string; event: PrTimelineEvent }
  | { kind: "attention"; id: string; items: PrNeedsAttentionItem[] }
  | { kind: "push"; id: string; push: PrDigestPush; commits: CommitPushEvent[] }
  | { kind: "bot-group"; id: string; group: PrDigestBotGroup; events: PrTimelineEvent[] };

export type DigestPushTick = {
  id: string;
  sha: string;
  shortSha: string;
  subject: string;
  at: string;
  commitCount: number;
  commentCount: number;
  openCount: number;
};

export type DigestTimelineModel = {
  items: DigestRenderItem[];
  ticks: DigestPushTick[];
  digest: PrConversationDigest;
};

function toEntry(event: PrTimelineEvent): PrDigestEntry | null {
  if (event.type === "review_thread") {
    const first = event.comments?.[0] ?? null;
    return {
      id: event.id,
      kind: "thread",
      author: event.author ?? first?.author ?? "reviewer",
      authorIsBot: first?.authorIsBot,
      avatarUrl: event.avatarUrl ?? first?.authorAvatarUrl ?? null,
      at: event.timestamp,
      body: event.firstCommentBody ?? first?.body ?? null,
      url: first?.url ?? null,
      path: event.path,
      line: event.line ?? event.originalLine,
      resolved: event.isResolved,
      outdated: event.isOutdated,
    };
  }
  if (event.type === "review") {
    return {
      id: event.id,
      kind: "review",
      author: event.author ?? "reviewer",
      authorIsBot: event.isBot,
      avatarUrl: event.avatarUrl,
      at: event.timestamp,
      body: event.body,
      url: null,
    };
  }
  if (event.type === "issue_comment") {
    return {
      id: event.id,
      kind: "comment",
      author: event.author ?? "someone",
      authorIsBot: event.isBot,
      avatarUrl: event.avatarUrl,
      at: event.timestamp,
      body: event.body,
      url: null,
    };
  }
  return null;
}

/**
 * Consecutive commits with no conversation between them are one push. A force
 * push always starts its own section — it rewrote what came before.
 */
function groupPushes(sorted: PrTimelineEvent[]): Array<{ push: PrDigestPush; commits: CommitPushEvent[] }> {
  const groups: Array<{ push: PrDigestPush; commits: CommitPushEvent[] }> = [];
  let run: CommitPushEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    groups.push({
      push: {
        id: first.id,
        sha: last.sha,
        shortSha: last.shortSha,
        subject: last.subject,
        at: first.timestamp,
        commitCount: run.reduce((sum, commit) => sum + Math.max(1, commit.commitCount), 0),
        forcePushed: run.some((commit) => commit.forcePushed),
      },
      commits: run,
    });
    run = [];
  };
  for (const event of sorted) {
    if (event.type === "commit_push") {
      if (event.forcePushed) flush();
      run.push(event);
      continue;
    }
    if (event.type === "review_thread" || event.type === "review" || event.type === "issue_comment") flush();
  }
  flush();
  return groups;
}

/** Events that are neither conversation nor pushes but still belong in the story. */
function isStoryEvent(event: PrTimelineEvent): boolean {
  switch (event.type) {
    case "merge":
    case "lifecycle":
    case "label_change":
    case "deployment":
    case "cross_reference":
    case "renamed":
    case "branch_ref":
    case "assignment":
    case "review_request":
    case "review_dismissed":
      return true;
    default:
      return false;
  }
}

export function buildDigestTimelineModel(events: PrTimelineEvent[]): DigestTimelineModel {
  const sorted = [...events].sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
  const eventsById = new Map(sorted.map((event) => [event.id, event] as const));
  const pushGroups = groupPushes(sorted);
  const entries = sorted.map(toEntry).filter((entry): entry is PrDigestEntry => entry !== null);
  const digest = buildPrConversationDigest({ pushes: pushGroups.map((group) => group.push), entries });

  const items: DigestRenderItem[] = [];
  const description = sorted.find((event) => event.type === "description");
  if (description) items.push({ kind: "event", id: description.id, event: description });
  if (digest.needsAttention.length > 0) {
    items.push({ kind: "attention", id: "digest:attention", items: digest.needsAttention });
  }

  const pushStarts = pushGroups.map((group) => ts(group.push.at));
  const storyBySection = new Map<number, PrTimelineEvent[]>();
  for (const event of sorted) {
    if (!isStoryEvent(event)) continue;
    const index = sectionIndexFor(pushStarts, event.timestamp);
    const list = storyBySection.get(index) ?? [];
    list.push(event);
    storyBySection.set(index, list);
  }

  const ticks: DigestPushTick[] = [];
  digest.sections.forEach((section) => {
    const pushIndex = section.push ? pushGroups.findIndex((group) => group.push.id === section.push!.id) : -1;
    const commentCount = section.bots.reduce((sum, group) => sum + group.entries.length, 0) + section.humans.length;
    if (section.push && pushIndex >= 0) {
      const group = pushGroups[pushIndex]!;
      items.push({ kind: "push", id: `push:${section.push.id}`, push: section.push, commits: group.commits });
      ticks.push({
        id: section.push.id,
        sha: section.push.sha,
        shortSha: section.push.shortSha,
        subject: section.push.subject,
        at: section.push.at,
        commitCount: section.push.commitCount,
        commentCount,
        openCount: section.bots.reduce((sum, group) => sum + group.openThreadCount, 0)
          + section.humans.filter(isOpenThread).length,
      });
    }
    for (const group of section.bots) {
      const groupEvents = group.entries
        .map((entry) => eventsById.get(entry.id))
        .filter((event): event is PrTimelineEvent => Boolean(event));
      items.push({ kind: "bot-group", id: `bot:${section.push?.id ?? "pre"}:${group.key}`, group, events: groupEvents });
    }
    const rows: PrTimelineEvent[] = [
      ...section.humans.map((entry) => eventsById.get(entry.id)).filter((event): event is PrTimelineEvent => Boolean(event)),
      ...(storyBySection.get(pushIndex) ?? []),
    ].sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
    for (const event of rows) items.push({ kind: "event", id: event.id, event });
  });
  // Story events before the first push with no conversation section of their own.
  if (!digest.sections.some((section) => section.push === null)) {
    const early = storyBySection.get(-1) ?? [];
    const insertAt = items.findIndex((item) => item.kind === "push");
    const rows = early.map<DigestRenderItem>((event) => ({ kind: "event", id: event.id, event }));
    if (insertAt < 0) items.push(...rows);
    else items.splice(insertAt, 0, ...rows);
  }
  return { items, ticks, digest };
}
