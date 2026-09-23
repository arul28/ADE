import { classifyPrAuthor, type PrAuthorIdentity } from "./prBotIdentity";

/**
 * The PR conversation, shaped for triage instead of replay: what still needs
 * someone (pinned), then one section per push with bot activity folded into
 * one row per bot. Humans are never folded — they are rare and they matter.
 */

export type PrDigestPush = {
  /** Timeline event id the section scrolls to. */
  id: string;
  sha: string;
  shortSha: string;
  subject: string;
  at: string;
  commitCount: number;
  forcePushed: boolean;
};

export type PrDigestEntryKind = "thread" | "review" | "comment";

export type PrDigestEntry = {
  /** Timeline event id, for "jump to" and expand. */
  id: string;
  kind: PrDigestEntryKind;
  author: string;
  authorIsBot?: boolean;
  avatarUrl: string | null;
  at: string;
  body: string | null;
  url: string | null;
  /** Review threads only. */
  path?: string | null;
  line?: number | null;
  resolved?: boolean;
  outdated?: boolean;
};

export type PrDigestBotGroup = {
  key: string;
  identity: PrAuthorIdentity;
  avatarUrl: string | null;
  entries: PrDigestEntry[];
  threadCount: number;
  resolvedThreadCount: number;
  openThreadCount: number;
  commentCount: number;
  latestAt: string;
};

export type PrDigestSection = {
  /** Null for activity before the first known push. */
  push: PrDigestPush | null;
  bots: PrDigestBotGroup[];
  humans: PrDigestEntry[];
};

export type PrNeedsAttentionItem = {
  entry: PrDigestEntry;
  identity: PrAuthorIdentity;
};

export type PrConversationDigest = {
  needsAttention: PrNeedsAttentionItem[];
  sections: PrDigestSection[];
};

/** Epoch ms for an ISO time. A missing or bad value sorts first (0). */
export function ts(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Index of the last push that starts at or before `at`, or -1 when `at` is
 * before every push. `pushStarts` must be sorted ascending.
 */
export function sectionIndexFor(pushStarts: readonly number[], at: string): number {
  const time = ts(at);
  let index = -1;
  for (let i = 0; i < pushStarts.length; i += 1) {
    if (pushStarts[i]! <= time) index = i;
    else break;
  }
  return index;
}

/** One-line, markup-free preview for a digest row. */
export function digestPreview(body: string | null | undefined, max = 140): string {
  if (!body) return "";
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the first sentence when it is short enough to stand alone.
  const sentence = text.match(/^(.{12,}?[.!?])(\s|$)/)?.[1] ?? text;
  const pick = sentence.length <= max ? sentence : text;
  return pick.length > max ? `${pick.slice(0, max - 1).trimEnd()}…` : pick;
}

/** A review thread that is not resolved and not outdated still needs someone. */
export function isOpenThread(entry: Pick<PrDigestEntry, "kind" | "resolved" | "outdated">): boolean {
  return entry.kind === "thread" && !entry.resolved && !entry.outdated;
}

export function buildPrConversationDigest(args: {
  pushes: PrDigestPush[];
  entries: PrDigestEntry[];
}): PrConversationDigest {
  const pushes = [...args.pushes].sort((a, b) => ts(a.at) - ts(b.at));
  const entries = [...args.entries].sort((a, b) => ts(a.at) - ts(b.at));

  const sections: PrDigestSection[] = [];
  const preamble: PrDigestSection = { push: null, bots: [], humans: [] };
  const byPush = pushes.map<PrDigestSection>((push) => ({ push, bots: [], humans: [] }));

  const pushStarts = pushes.map((push) => ts(push.at));
  const sectionFor = (at: string): PrDigestSection => byPush[sectionIndexFor(pushStarts, at)] ?? preamble;

  const needsAttention: PrNeedsAttentionItem[] = [];

  for (const entry of entries) {
    const identity = classifyPrAuthor(entry.author, entry.authorIsBot);
    const section = sectionFor(entry.at);
    if (isOpenThread(entry)) needsAttention.push({ entry, identity });
    if (!identity.isBot) {
      section.humans.push(entry);
      continue;
    }
    const key = identity.kind ?? identity.normalizedLogin;
    let group = section.bots.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        identity,
        avatarUrl: entry.avatarUrl,
        entries: [],
        threadCount: 0,
        resolvedThreadCount: 0,
        openThreadCount: 0,
        commentCount: 0,
        latestAt: entry.at,
      };
      section.bots.push(group);
    }
    group.entries.push(entry);
    group.avatarUrl = group.avatarUrl ?? entry.avatarUrl;
    if (ts(entry.at) > ts(group.latestAt)) group.latestAt = entry.at;
    if (entry.kind === "thread") {
      group.threadCount += 1;
      if (isOpenThread(entry)) group.openThreadCount += 1;
      else group.resolvedThreadCount += 1;
    } else {
      group.commentCount += 1;
    }
  }

  if (preamble.bots.length > 0 || preamble.humans.length > 0) sections.push(preamble);
  sections.push(...byPush);

  // Human findings first, then bots; newest first inside each.
  needsAttention.sort((a, b) => {
    if (a.identity.isBot !== b.identity.isBot) return a.identity.isBot ? 1 : -1;
    return ts(b.entry.at) - ts(a.entry.at);
  });

  return { needsAttention, sections };
}

/** "3 threads · all resolved", "12 threads · 11 resolved", "Summary posted". */
export function describeBotGroup(group: PrDigestBotGroup): string {
  const parts: string[] = [];
  if (group.threadCount > 0) {
    const threads = `${group.threadCount} thread${group.threadCount === 1 ? "" : "s"}`;
    if (group.openThreadCount === 0) parts.push(`${threads} · all resolved`);
    else if (group.resolvedThreadCount === 0) parts.push(`${threads} · ${group.openThreadCount} open`);
    else parts.push(`${threads} · ${group.resolvedThreadCount} resolved`);
  }
  if (group.commentCount > 0) {
    if (group.threadCount === 0 && group.commentCount === 1) {
      parts.push(group.identity.role === "deploy" ? "Deploy update" : "Comment posted");
    } else {
      parts.push(`${group.commentCount} comment${group.commentCount === 1 ? "" : "s"}`);
    }
  }
  return parts.join(" · ");
}
