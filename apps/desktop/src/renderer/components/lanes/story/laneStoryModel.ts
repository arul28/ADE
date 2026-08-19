/**
 * Pure layout + derivation for the Lane story canvas.
 *
 * Everything here is a plain function over a `LaneEventsListResult`: the
 * renderer owns no layout math of its own, so the spacing, folding, gap and
 * heat rules stay testable in a node environment (no jsdom, no React).
 *
 * See docs/features/lanes/lane-story.md — "Renderer (unit C)".
 */

import type {
  LaneEvent,
  LaneEventActor,
  LaneEventKind,
  LaneEventsBranch,
  LaneEventsChat,
} from "../../../../shared/types/laneEvents";
import type { CommitPayload, PrPayload } from "../../../../shared/types/laneEvents";

/* ------------------------------------------------------------------ *
 * Geometry constants
 * ------------------------------------------------------------------ */

/** Horizontal distance between two adjacent story nodes. */
export const NODE_SPACING = 128;
/** Left padding before the first node (leaves room for the branch label). */
export const CANVAS_PADDING_X = 112;
/** Extra breathing room injected where a time gap marker is drawn. */
export const GAP_EXTRA_SPACING = 56;
/** Vertical distance between two branch spines. */
export const ROW_HEIGHT = 168;
/** Y of the first (primary) branch spine. */
export const FIRST_ROW_Y = 148;
/** Height reserved under the last spine for the session swimlanes. */
export const SWIMLANE_TOP_GAP = 56;
export const SWIMLANE_HEIGHT = 30;
export const SWIMLANE_GAP = 8;
/** A run of same-agent commits longer than this folds into one segment pill. */
export const FOLD_THRESHOLD = 8;
/** Δt at or above which the spine shows a "· 2d ·" break. */
export const GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/** Width of a story card at rest. */
export const CARD_WIDTH = 208;
/** Width of a story card once its detail rows are expanded. */
export const CARD_EXPANDED_WIDTH = 300;
/** Vertical distance between the spine and the nearest card edge. */
export const CARD_OFFSET = 34;
/** Fixed card height the connector stubs and above/below placement are drawn against. */
export const CARD_HEIGHT = 92;

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export const STORY_FILTERS = ["commits", "prs", "ci", "reviews", "lanes", "sessions"] as const;
export type StoryFilter = (typeof STORY_FILTERS)[number];

export const STORY_FILTER_LABELS: Record<StoryFilter, string> = {
  commits: "Commits",
  prs: "PRs",
  ci: "CI",
  reviews: "Reviews",
  lanes: "Lanes",
  sessions: "Sessions",
};

const KIND_FILTER: Record<LaneEventKind, StoryFilter> = {
  commit: "commits",
  rebase: "commits",
  pr_opened: "prs",
  pr_merged: "prs",
  pr_closed: "prs",
  pr_checks: "ci",
  pr_review: "reviews",
  lane_created: "lanes",
  lane_spawned: "lanes",
  branch_switched: "lanes",
  chat_started: "sessions",
  chat_ended: "sessions",
};

/**
 * The PR-shaped event kinds. Explicit rather than a `kind.startsWith("pr_")`
 * test so a new kind is a compile error at every call site instead of silently
 * joining (or missing) the PR set.
 */
export const PR_EVENT_KINDS: ReadonlySet<LaneEventKind> = new Set<LaneEventKind>([
  "pr_opened",
  "pr_checks",
  "pr_review",
  "pr_merged",
  "pr_closed",
]);

export function eventFilterCategory(kind: LaneEventKind): StoryFilter {
  return KIND_FILTER[kind];
}

export function filterStoryEvents(events: readonly LaneEvent[], active: ReadonlySet<StoryFilter>): LaneEvent[] {
  return events.filter((event) => active.has(eventFilterCategory(event.kind)));
}

/* ------------------------------------------------------------------ *
 * Actors
 * ------------------------------------------------------------------ */

/** Brand colors for the providers ADE draws by name; everything else is the lane accent. */
export const PROVIDER_COLORS: Record<string, string> = {
  claude: "#D97757",
  cursor: "#9CC7FF",
  codex: "#10A37F",
  anthropic: "#D97757",
  droid: "#C4B5FD",
  factory: "#C4B5FD",
  opencode: "#7DD3FC",
};

export const HUMAN_COLOR = "var(--color-fg)";
/** Commit-flavoured swatch (the Claude brand mark, which leads the commit spine). */
export const COMMIT_COLOR = PROVIDER_COLORS.claude;
/** Session/chat-flavoured swatch. */
export const SESSION_COLOR = PROVIDER_COLORS.cursor;
export const PR_COLOR = "var(--color-success)";
export const REVIEW_COLOR = "var(--color-info)";
export const LANE_COLOR = "var(--color-accent)";

export function storyProviderColor(provider: string | null | undefined): string | null {
  const key = String(provider ?? "").trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_COLORS[key] ?? null;
}

/** The color a node/card is painted in — provider brand for agents, semantic for the rest. */
export function actorColor(actor: LaneEventActor, kind: LaneEventKind): string {
  if (kind === "pr_review") return REVIEW_COLOR;
  if (kind === "pr_checks") return PR_COLOR;
  if (kind === "pr_opened" || kind === "pr_merged") return PR_COLOR;
  if (kind === "pr_closed") return "var(--color-muted-fg)";
  if (kind === "lane_created" || kind === "lane_spawned" || kind === "branch_switched" || kind === "rebase") {
    return storyProviderColor(actor.provider) ?? LANE_COLOR;
  }
  return storyProviderColor(actor.provider) ?? (actor.kind === "human" ? HUMAN_COLOR : "var(--color-muted-fg)");
}

/** Stable identity for "the same agent committed again" — used by run folding. */
export function actorKey(actor: LaneEventActor): string {
  return (
    actor.chatSessionId
    ?? (actor.provider ? `provider:${actor.provider}` : null)
    ?? (actor.login ? `login:${actor.login}` : null)
    ?? `kind:${actor.kind}`
  );
}

export function actorLabel(actor: LaneEventActor): string {
  if (actor.kind === "agent") {
    const provider = actor.provider ? capitalize(actor.provider) : "Agent";
    return actor.model ? `${provider} · ${actor.model}` : provider;
  }
  if (actor.kind === "bot") return actor.login ?? "Bot";
  if (actor.kind === "human") return actor.login ?? "You";
  if (actor.kind === "system") return "ADE";
  return "Unknown";
}

function capitalize(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/* ------------------------------------------------------------------ *
 * Titles / stats — shared by the cards and the expanded detail
 * ------------------------------------------------------------------ */

export function eventTitle(event: LaneEvent): string {
  switch (event.kind) {
    case "commit": return (event.payload as CommitPayload).shortSha || "commit";
    case "pr_opened": return `PR #${(event.payload as PrPayload).githubPrNumber} opened`;
    case "pr_merged": return `PR #${(event.payload as PrPayload).githubPrNumber} merged`;
    case "pr_closed": return `PR #${(event.payload as PrPayload).githubPrNumber} closed`;
    case "pr_checks": return `Checks ${(event.payload as PrPayload).checksStatus ?? "updated"}`;
    case "pr_review": return `Review ${(event.payload as PrPayload).reviewStatus ?? "updated"}`;
    case "lane_created": return "Lane created";
    case "lane_spawned": return "Lane spawned";
    case "branch_switched": return "Branch switched";
    case "rebase": return "Rebased";
    case "chat_started": return "Chat started";
    case "chat_ended": return "Chat ended";
    default: return event.kind;
  }
}

export function eventMessage(event: LaneEvent): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "commit": return String(payload.subject ?? "");
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
    case "pr_checks":
    case "pr_review": return String(payload.title ?? "");
    case "lane_created": return `${String(payload.baseRef ?? "")} → ${String(payload.branchRef ?? "")}`;
    case "lane_spawned": return String(payload.laneName ?? "");
    case "branch_switched": return `${String(payload.fromBranchRef ?? "?")} → ${String(payload.toBranchRef ?? "?")}`;
    case "rebase": return `onto ${String(payload.onto ?? "")}`;
    case "chat_started":
    case "chat_ended": return String(payload.title ?? "");
    default: return "";
  }
}

/** The mono stat shown in a card footer (diffstat, check state, …). */
export function eventStat(event: LaneEvent): string | null {
  if (event.kind === "commit") {
    const payload = event.payload as CommitPayload;
    const parts: string[] = [];
    if (payload.filesChanged != null) parts.push(`${payload.filesChanged}f`);
    if (payload.insertions != null) parts.push(`+${payload.insertions}`);
    if (payload.deletions != null) parts.push(`−${payload.deletions}`);
    return parts.length ? parts.join(" ") : null;
  }
  const pr = event.payload as PrPayload;
  if (event.kind === "pr_checks") return pr.checksStatus ?? null;
  if (event.kind === "pr_review") return pr.reviewStatus ?? null;
  if (event.kind === "pr_merged") return pr.mergedByLogin ? `by ${pr.mergedByLogin}` : null;
  return null;
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export type StoryCardSide = "above" | "below";

export type StoryNode =
  | {
    type: "event";
    id: string;
    x: number;
    rowIndex: number;
    branchRef: string;
    ts: string;
    side: StoryCardSide;
    color: string;
    event: LaneEvent;
  }
  | {
    type: "fold";
    id: string;
    x: number;
    rowIndex: number;
    branchRef: string;
    ts: string;
    side: StoryCardSide;
    color: string;
    /** The folded commits, oldest first. */
    events: LaneEvent[];
    actor: LaneEventActor;
  };

export type StoryRow = {
  index: number;
  branchRef: string;
  y: number;
  startX: number;
  endX: number;
  /** Row this branch forked out of, when it is not the first row. */
  forkFromRowIndex: number | null;
  forkX: number | null;
  terminal: "merged" | "closed" | null;
};

export type StoryGapMarker = { id: string; x: number; rowIndex: number; ms: number; label: string };

export type StorySwimlane = {
  chatSessionId: string;
  laneIndex: number;
  y: number;
  startX: number;
  endX: number;
  chat: LaneEventsChat;
  color: string;
};

export type StoryCausalityArc = { id: string; fromX: number; toX: number; rowIndex: number };

export type LaneStoryLayout = {
  nodes: StoryNode[];
  rows: StoryRow[];
  gaps: StoryGapMarker[];
  swimlanes: StorySwimlane[];
  arcs: StoryCausalityArc[];
  width: number;
  height: number;
  firstTs: string | null;
  lastTs: string | null;
};

const KIND_ORDER: LaneEventKind[] = [
  "lane_created",
  "chat_started",
  "branch_switched",
  "commit",
  "rebase",
  "pr_opened",
  "pr_checks",
  "pr_review",
  "pr_merged",
  "pr_closed",
  "lane_spawned",
  "chat_ended",
];

export function sortStoryEvents(events: readonly LaneEvent[]): LaneEvent[] {
  return [...events].sort((a, b) => {
    const at = Date.parse(a.ts);
    const bt = Date.parse(b.ts);
    if (at !== bt) return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
    const ao = KIND_ORDER.indexOf(a.kind);
    const bo = KIND_ORDER.indexOf(b.kind);
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

type FoldGroup = { events: LaneEvent[] };

/**
 * Collapse runs of >FOLD_THRESHOLD consecutive same-agent commits on the same
 * branch into one group. Anything else stays a group of one, so the caller can
 * walk a single flat list.
 */
export function foldCommitRuns(events: readonly LaneEvent[], threshold = FOLD_THRESHOLD): FoldGroup[] {
  const groups: FoldGroup[] = [];
  let run: LaneEvent[] = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length > threshold) groups.push({ events: run });
    else for (const event of run) groups.push({ events: [event] });
    run = [];
  };
  for (const event of events) {
    if (event.kind !== "commit") {
      flushRun();
      groups.push({ events: [event] });
      continue;
    }
    const head = run[0];
    const sameActor = head ? actorKey(head.actor) === actorKey(event.actor) : true;
    const sameBranch = head ? (head.branchRef ?? null) === (event.branchRef ?? null) : true;
    if (head && (!sameActor || !sameBranch)) flushRun();
    run.push(event);
  }
  flushRun();
  return groups;
}

export function formatGapLabel(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

export function buildLaneStoryLayout(args: {
  events: readonly LaneEvent[];
  branches?: readonly LaneEventsBranch[];
  chats?: readonly LaneEventsChat[];
  foldThreshold?: number;
  showSwimlanes?: boolean;
  /** Fold node ids (`fold:<first event id>`) the user has expanded in place. */
  unfoldedIds?: ReadonlySet<string>;
}): LaneStoryLayout {
  const sorted = sortStoryEvents(args.events);
  const branches = args.branches ?? [];
  const chats = args.chats ?? [];

  // Row assignment: branch order is first-appearance order, so the lane's own
  // branch is row 0 and any spawned/switched branch stacks below it.
  const rowIndexByBranch = new Map<string, number>();
  const primaryBranch = sorted.find((event) => event.branchRef)?.branchRef
    ?? branches[0]?.branchRef
    ?? "";
  const branchOf = (event: LaneEvent): string => event.branchRef ?? primaryBranch;
  for (const event of sorted) {
    const branch = branchOf(event);
    if (!rowIndexByBranch.has(branch)) rowIndexByBranch.set(branch, rowIndexByBranch.size);
  }
  if (rowIndexByBranch.size === 0) rowIndexByBranch.set(primaryBranch, 0);

  const unfolded = args.unfoldedIds ?? new Set<string>();
  const groups = foldCommitRuns(sorted, args.foldThreshold ?? FOLD_THRESHOLD)
    .flatMap((group) => (
      group.events.length > 1 && unfolded.has(`fold:${group.events[0]!.id}`)
        ? group.events.map((event) => ({ events: [event] }))
        : [group]
    ));

  const nodes: StoryNode[] = [];
  const gaps: StoryGapMarker[] = [];
  const sideCursor = new Map<number, number>();
  let x = CANVAS_PADDING_X;
  let previousTs: number | null = null;

  for (const group of groups) {
    const head = group.events[0]!;
    const branchRef = branchOf(head);
    const rowIndex = rowIndexByBranch.get(branchRef) ?? 0;
    const ts = Date.parse(head.ts);
    if (previousTs != null && !Number.isNaN(ts)) {
      const delta = ts - previousTs;
      if (delta >= GAP_THRESHOLD_MS) {
        gaps.push({
          id: `gap:${head.id}`,
          x: x + GAP_EXTRA_SPACING / 2 - NODE_SPACING / 2,
          rowIndex,
          ms: delta,
          label: formatGapLabel(delta),
        });
        x += GAP_EXTRA_SPACING;
      }
    }
    if (!Number.isNaN(ts)) previousTs = Date.parse(group.events[group.events.length - 1]!.ts) || ts;

    const nextSide = (sideCursor.get(rowIndex) ?? 0) % 2 === 0 ? "above" : "below";
    sideCursor.set(rowIndex, (sideCursor.get(rowIndex) ?? 0) + 1);

    if (group.events.length > 1) {
      nodes.push({
        type: "fold",
        id: `fold:${head.id}`,
        x,
        rowIndex,
        branchRef,
        ts: head.ts,
        side: nextSide,
        color: actorColor(head.actor, "commit"),
        events: group.events,
        actor: head.actor,
      });
    } else {
      nodes.push({
        type: "event",
        id: head.id,
        x,
        rowIndex,
        branchRef,
        ts: head.ts,
        side: nextSide,
        color: actorColor(head.actor, head.kind),
        event: head,
      });
    }
    x += NODE_SPACING;
  }

  const rows: StoryRow[] = [];
  for (const [branchRef, index] of rowIndexByBranch.entries()) {
    const onRow = nodes.filter((node) => node.rowIndex === index);
    const startX = onRow.length ? Math.min(...onRow.map((node) => node.x)) : CANVAS_PADDING_X;
    const endX = onRow.length ? Math.max(...onRow.map((node) => node.x)) : CANVAS_PADDING_X;
    const branchMeta = branches.find((branch) => branch.branchRef === branchRef) ?? null;
    let forkFromRowIndex: number | null = null;
    let forkX: number | null = null;
    if (index > 0) {
      forkFromRowIndex = 0;
      const forkSha = branchMeta?.forkPointSha ?? null;
      const forkNode = forkSha
        ? nodes.find((node) => node.type === "event"
          && node.event.kind === "commit"
          && (node.event.payload as CommitPayload).sha === forkSha)
        : null;
      forkX = forkNode ? forkNode.x : Math.max(CANVAS_PADDING_X, startX - NODE_SPACING);
    }
    rows.push({
      index,
      branchRef,
      y: FIRST_ROW_Y + index * ROW_HEIGHT,
      startX,
      endX,
      forkFromRowIndex,
      forkX,
      terminal: branchMeta?.terminal ?? null,
    });
  }
  rows.sort((a, b) => a.index - b.index);

  // Review → next commit causality: a review is only interesting when someone
  // acted on it, so the arc points at the first commit that follows.
  const arcs: StoryCausalityArc[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (node.type !== "event" || node.event.kind !== "pr_review") continue;
    const next = nodes.slice(i + 1).find((candidate) => (
      candidate.type === "fold" || candidate.event.kind === "commit"
    ));
    if (!next) continue;
    arcs.push({ id: `arc:${node.id}`, fromX: node.x, toX: next.x, rowIndex: node.rowIndex });
  }

  const width = Math.max(x + CANVAS_PADDING_X, CANVAS_PADDING_X * 2);
  const swimlaneTop = FIRST_ROW_Y + Math.max(0, rows.length - 1) * ROW_HEIGHT + SWIMLANE_TOP_GAP;
  const swimlanes: StorySwimlane[] = [];
  if (args.showSwimlanes !== false) {
    const toX = makeTimeToX(nodes, width);
    chats.forEach((chat, index) => {
      const startX = toX(chat.startedAt);
      const endX = Math.max(startX + 48, toX(chat.endedAt ?? chat.lastActivityAt ?? new Date().toISOString()));
      swimlanes.push({
        chatSessionId: chat.chatSessionId,
        laneIndex: index,
        y: swimlaneTop + index * (SWIMLANE_HEIGHT + SWIMLANE_GAP),
        startX,
        endX,
        chat,
        color: storyProviderColor(chat.provider) ?? LANE_COLOR,
      });
    });
  }

  const swimlaneBottom = swimlanes.length
    ? swimlaneTop + swimlanes.length * (SWIMLANE_HEIGHT + SWIMLANE_GAP)
    : swimlaneTop;
  const height = Math.max(swimlaneBottom + 48, FIRST_ROW_Y + rows.length * ROW_HEIGHT + 120);

  return {
    nodes,
    rows,
    gaps,
    swimlanes,
    arcs,
    width,
    height,
    firstTs: sorted[0]?.ts ?? null,
    lastTs: sorted[sorted.length - 1]?.ts ?? null,
  };
}

/**
 * Maps an instant onto the canvas by interpolating between the nodes on either
 * side of it. The canvas is event-ordered, not time-proportional, so a linear
 * time→x mapping would put every swimlane in the wrong place.
 */
export function makeTimeToX(nodes: readonly StoryNode[], width: number): (ts: string) => number {
  const points = nodes
    .map((node) => ({ t: Date.parse(node.ts), x: node.x }))
    .filter((point) => !Number.isNaN(point.t))
    .sort((a, b) => a.t - b.t);
  return (ts: string): number => {
    const t = Date.parse(ts);
    if (!points.length || Number.isNaN(t)) return CANVAS_PADDING_X;
    if (t <= points[0]!.t) return CANVAS_PADDING_X;
    const last = points[points.length - 1]!;
    if (t >= last.t) return Math.min(width - CANVAS_PADDING_X / 2, last.x + NODE_SPACING / 2);
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]!;
      const next = points[i]!;
      if (t <= next.t) {
        const span = next.t - prev.t;
        const ratio = span > 0 ? (t - prev.t) / span : 0;
        return prev.x + (next.x - prev.x) * ratio;
      }
    }
    return last.x;
  };
}

/* ------------------------------------------------------------------ *
 * Heat scrubber
 * ------------------------------------------------------------------ */

export type HeatBucket = {
  index: number;
  /** 0..1 activity density relative to the busiest bucket. */
  density: number;
  count: number;
  hasMerge: boolean;
  needsAttention: boolean;
};

export type HeatStrip = {
  buckets: HeatBucket[];
  startTs: string | null;
  endTs: string | null;
  /** Human duration of the whole story, e.g. "3d". */
  durationLabel: string | null;
};

const ATTENTION_CHECKS = new Set(["failing", "failure", "error"]);
const ATTENTION_REVIEWS = new Set(["changes_requested", "changes-requested"]);

export function buildHeatStrip(events: readonly LaneEvent[], bucketCount = 40): HeatStrip {
  const sorted = sortStoryEvents(events);
  if (!sorted.length) return { buckets: [], startTs: null, endTs: null, durationLabel: null };
  const start = Date.parse(sorted[0]!.ts);
  const end = Date.parse(sorted[sorted.length - 1]!.ts);
  const span = Math.max(1, end - start);
  const buckets: HeatBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    density: 0,
    count: 0,
    hasMerge: false,
    needsAttention: false,
  }));
  for (const event of sorted) {
    const t = Date.parse(event.ts);
    if (Number.isNaN(t)) continue;
    const ratio = (t - start) / span;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(ratio * bucketCount)));
    const bucket = buckets[index]!;
    bucket.count += 1;
    if (event.kind === "pr_merged") bucket.hasMerge = true;
    const payload = event.payload as PrPayload;
    if (event.kind === "pr_checks" && ATTENTION_CHECKS.has(String(payload.checksStatus ?? "").toLowerCase())) {
      bucket.needsAttention = true;
    }
    if (event.kind === "pr_review" && ATTENTION_REVIEWS.has(String(payload.reviewStatus ?? "").toLowerCase())) {
      bucket.needsAttention = true;
    }
  }
  const max = buckets.reduce((acc, bucket) => Math.max(acc, bucket.count), 0);
  for (const bucket of buckets) bucket.density = max > 0 ? bucket.count / max : 0;
  return {
    buckets,
    startTs: sorted[0]!.ts,
    endTs: sorted[sorted.length - 1]!.ts,
    durationLabel: formatGapLabel(span),
  };
}

/* ------------------------------------------------------------------ *
 * Summary sentence
 * ------------------------------------------------------------------ */

const ORIGIN_PHRASES: Record<string, string> = {
  human: "created by you",
  chat: "spawned from a chat",
  "agent-cli": "created by an agent",
  linear: "created from a Linear issue",
  automation: "created by an automation",
  "pr-import": "imported from a pull request",
  conflict: "created to resolve a conflict",
  unknown: "created",
};

/**
 * A deterministic one-sentence read of the lane: where it came from, who wrote
 * the commits, what happened to its PRs, and what is happening right now.
 */
export function buildStorySummary(args: {
  events: readonly LaneEvent[];
  chats?: readonly LaneEventsChat[];
  baseRef?: string | null;
}): string {
  const events = sortStoryEvents(args.events);
  if (!events.length) return "No story yet.";
  const parts: string[] = [];

  const created = events.find((event) => event.kind === "lane_created");
  if (created) {
    const source = String((created.payload as { source?: string }).source ?? "unknown");
    const base = args.baseRef ?? String((created.payload as { baseRef?: string }).baseRef ?? "");
    parts.push(base ? `${capitalize(ORIGIN_PHRASES[source] ?? ORIGIN_PHRASES.unknown!)} off ${base}` : capitalize(ORIGIN_PHRASES[source] ?? ORIGIN_PHRASES.unknown!));
  }

  const commits = events.filter((event) => event.kind === "commit");
  if (commits.length) {
    const authors = new Set<string>();
    for (const commit of commits) authors.add(actorShortLabel(commit.actor));
    parts.push(`${commits.length} commit${commits.length === 1 ? "" : "s"} from ${joinList([...authors])}`);
  }

  const merged = events.filter((event) => event.kind === "pr_merged");
  const closed = events.filter((event) => event.kind === "pr_closed");
  const opened = events.filter((event) => event.kind === "pr_opened");
  if (merged.length) {
    parts.push(`${merged.length === 1 ? "1 PR" : `${merged.length} PRs`} merged`);
  } else if (closed.length) {
    parts.push(`${closed.length === 1 ? "1 PR" : `${closed.length} PRs`} closed`);
  } else if (opened.length) {
    parts.push(`${opened.length === 1 ? "1 PR" : `${opened.length} PRs`} open`);
  }

  const live = (args.chats ?? []).find((chat) => chat.status === "running")
    ?? (args.chats ?? []).find((chat) => chat.status === "awaiting-input");
  if (live) {
    const provider = live.provider ? capitalize(live.provider) : "An agent";
    parts.push(live.status === "awaiting-input" ? `${provider} is waiting on you` : `${provider} is working now`);
  }

  return `${parts.join(" · ")}.`;
}

function actorShortLabel(actor: LaneEventActor): string {
  if (actor.kind === "agent") return actor.provider ? capitalize(actor.provider) : "an agent";
  if (actor.kind === "human") return actor.login ?? "you";
  if (actor.kind === "bot") return actor.login ?? "a bot";
  return "unknown";
}

function joinList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "unknown";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Small formatters shared by List and Timeline
 * ------------------------------------------------------------------ */

export function formatClockTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatRelativeTime(ts: string, now = Date.now()): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  const delta = Math.max(0, now - t);
  if (delta < 60000) return "just now";
  return `${formatGapLabel(delta)} ago`;
}

/** `base ↑2 ↓0` style readouts for the timeline header. */
export function formatGitReadout(status: {
  ahead: number;
  behind: number;
  remoteBehind: number;
  dirty: boolean;
} | null | undefined, baseRef: string): { base: string; remote: string; clean: boolean } {
  if (!status) return { base: `${baseRef} ↑0 ↓0`, remote: "remote ↑0 ↓0", clean: true };
  const remote = status.remoteBehind < 0
    ? "no upstream"
    : `remote ↑${status.ahead} ↓${status.remoteBehind}`;
  return {
    base: `${baseRef} ↑${status.ahead} ↓${status.behind}`,
    remote,
    clean: !status.dirty,
  };
}
