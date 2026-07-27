import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChatCircle,
  CaretRight,
  CheckCircle,
  Eye,
  GitCommit,
  GitPullRequest,
  Package,
  Tag,
  GitMerge,
  Robot,
  WarningCircle,
  Clock,
  ArrowRight,
  XCircle,
  FileDashed,
  ArrowBendUpRight,
  Pencil,
  GitBranch,
  UserPlus,
  UserMinus,
  ArrowsClockwise,
  ArrowSquareOut,
  DotsThreeOutline,
} from "@phosphor-icons/react";

import type {
  PrAiSummary,
  PrCheck,
  PrTimelineEvent,
  PrDeploymentState,
  PrReview,
  PrReviewThread,
} from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import { PrMarkdown } from "./PrMarkdown";
import { PrReviewThreadCard } from "./PrReviewThreadCard";
import { PrBotReviewCard, detectBotProvider } from "./PrBotReviewCard";
import { PrUserAvatar } from "./PrUserAvatar";
import { PrAiSummaryCard } from "./PrAiSummaryCard";

/* ══════════════════ Types ══════════════════ */

export type PrTimelineFilters = {
  showResolved: boolean;
  showOutdated: boolean;
  onlyMine: boolean;
  onlyBots: boolean;
};

export const DEFAULT_PR_TIMELINE_FILTERS: PrTimelineFilters = {
  showResolved: true,
  showOutdated: true,
  onlyMine: false,
  onlyBots: false,
};

export type PrTimelineProps = {
  events: PrTimelineEvent[];
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  filters: PrTimelineFilters;
  onFiltersChange: (next: PrTimelineFilters) => void;
  summary?: PrAiSummary | null;
  onRegenerateSummary?: () => void;
  onDismissSummary?: () => void;
  /** Fired (debounced) with the id of the top-most visible event as the user scrolls. */
  onVisibleEventChange?: (eventId: string | null) => void;
  /** Rendered at the very bottom of the scrollable thread (e.g. the comment composer). */
  footer?: ReactNode;
};

export type PrTimelineRef = {
  scrollToEventId: (id: string) => void;
  focusEvent: (id: string) => void;
  nextUnresolved: () => void;
  prevUnresolved: () => void;
};

/* ══════════════════ Filtering ══════════════════ */

function eventAuthor(event: PrTimelineEvent): string | null {
  return event.author;
}

function isBotEvent(event: PrTimelineEvent): boolean {
  if (event.type === "review" && event.isBot) return true;
  if (event.type === "issue_comment" && event.isBot) return true;
  const author = eventAuthor(event);
  if (!author) return false;
  return detectBotProvider(author) !== null;
}

export function applyTimelineFilters(
  events: PrTimelineEvent[],
  filters: PrTimelineFilters,
  viewerLogin: string | null,
): PrTimelineEvent[] {
  return events.filter((event) => {
    if (event.type === "check_update") return false;
    if (event.type === "pr_opened") return true;
    if (event.type === "review_thread") {
      if (!filters.showResolved && event.isResolved) return false;
      if (!filters.showOutdated && event.isOutdated) return false;
    }
    if (filters.onlyMine) {
      if (!viewerLogin) return false;
      const author = eventAuthor(event);
      if (!author || author.toLowerCase() !== viewerLogin.toLowerCase()) return false;
    }
    if (filters.onlyBots && !isBotEvent(event)) {
      return false;
    }
    return true;
  });
}

function collectUnresolvedThreadIds(events: PrTimelineEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type === "review_thread" && !event.isResolved) {
      ids.push(event.id);
    }
  }
  return ids;
}

/* ══════════════════ Intersection gating ══════════════════ */

function useNearViewport(
  parentRef: React.MutableRefObject<HTMLDivElement | null>,
  rowRef: React.MutableRefObject<HTMLDivElement | null>,
): boolean {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const root = parentRef.current;
    if (!row) return;
    if (!root) {
      setVisible(true);
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const margin = 500;
    if (rowRect.bottom >= rootRect.top - margin && rowRect.top <= rootRect.bottom + margin) {
      setVisible(true);
    }
  }, [parentRef, rowRef]);

  useEffect(() => {
    const row = rowRef.current;
    const root = parentRef.current;
    if (!row) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { root: root ?? null, rootMargin: "500px 0px" },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [parentRef, rowRef]);
  return visible;
}

/* ══════════════════ Main component ══════════════════ */

type ReviewThreadEvent = Extract<PrTimelineEvent, { type: "review_thread" }>;
type CommitPushEvent = Extract<PrTimelineEvent, { type: "commit_push" }>;
type CheckUpdateEvent = Extract<PrTimelineEvent, { type: "check_update" }>;

export type TimelineRenderItem =
  | { kind: "event"; id: string; event: PrTimelineEvent }
  | {
      kind: "resolved-group";
      id: string;
      threads: Array<ReviewThreadEvent>;
    }
  | {
      kind: "commit-group";
      id: string;
      commits: Array<CommitPushEvent>;
    }
  | {
      kind: "checks-summary";
      id: string;
      checks: Array<CheckUpdateEvent>;
    };

/**
 * Builds the virtualized render-item list. Three foldings happen here, all
 * mirroring github.com's PR timeline:
 *   1. runs of 2+ consecutive resolved review threads → one `resolved-group`
 *   2. runs of 2+ consecutive non-force `commit_push` by the same author →
 *      one `commit-group` ("<author> added N commits")
 *   3. every `check_update` event → ONE trailing `checks-summary` bar (placed
 *      right before the merge event, or at the end if there's no merge), so we
 *      never drop check rows silently nor spam one row per check.
 */
export function buildRenderItems(events: PrTimelineEvent[]): TimelineRenderItem[] {
  const out: TimelineRenderItem[] = [];
  const checks: CheckUpdateEvent[] = [];

  let resolvedRun: Array<ReviewThreadEvent> = [];
  let commitRun: Array<CommitPushEvent> = [];

  const flushResolved = () => {
    if (resolvedRun.length === 0) return;
    if (resolvedRun.length >= 2) {
      out.push({ kind: "resolved-group", id: `resolved-group:${resolvedRun[0]!.id}`, threads: resolvedRun });
    } else {
      out.push({ kind: "event", id: resolvedRun[0]!.id, event: resolvedRun[0]! });
    }
    resolvedRun = [];
  };

  const flushCommits = () => {
    if (commitRun.length === 0) return;
    if (commitRun.length >= 2) {
      out.push({ kind: "commit-group", id: `commit-group:${commitRun[0]!.id}`, commits: commitRun });
    } else {
      out.push({ kind: "event", id: commitRun[0]!.id, event: commitRun[0]! });
    }
    commitRun = [];
  };

  const flushRuns = () => {
    flushResolved();
    flushCommits();
  };

  // Synthesize the single checks-summary item (deduped to the latest event per
  // check name so re-runs collapse). Emitted just before merge / at the end.
  const emitChecksSummary = () => {
    if (checks.length === 0) return;
    const byName = new Map<string, CheckUpdateEvent>();
    for (const c of checks) byName.set(c.checkName, c);
    const deduped = Array.from(byName.values());
    // Unique per emission — checks can be summarized both before a merge and at
    // the end, so a fixed id would collide in indexById if both ever fire.
    out.push({ kind: "checks-summary", id: `checks-summary:${out.length}`, checks: deduped });
  };

  for (const e of events) {
    // Collect check rows out-of-band; they become one summary bar.
    if (e.type === "check_update") {
      checks.push(e);
      continue;
    }

    // Accumulate a consecutive same-author non-force commit run. Authors can
    // arrive as login vs. display name with varied casing across sources, so
    // compare case-insensitively to avoid splitting one person's run.
    if (e.type === "commit_push" && !e.forcePushed) {
      flushResolved();
      const head = commitRun[0];
      const sameAuthor = head && (head.author ?? "").trim().toLowerCase() === (e.author ?? "").trim().toLowerCase();
      if (head && !sameAuthor) {
        flushCommits();
      }
      commitRun.push(e);
      continue;
    }

    // Accumulate a consecutive resolved-thread run.
    if (e.type === "review_thread" && e.isResolved) {
      flushCommits();
      resolvedRun.push(e);
      continue;
    }

    // The merge event closes the phase — emit checks just before it.
    if (e.type === "merge") {
      flushRuns();
      emitChecksSummary();
      checks.length = 0;
      out.push({ kind: "event", id: e.id, event: e });
      continue;
    }

    flushRuns();
    out.push({ kind: "event", id: e.id, event: e });
  }
  flushRuns();
  // Any checks not already flushed before a merge trail at the end.
  emitChecksSummary();
  return out;
}

export const PrTimeline = forwardRef<PrTimelineRef, PrTimelineProps>(function PrTimeline(
  {
    events,
    prId,
    laneId,
    repoOwner,
    repoName,
    viewerLogin,
    filters,
    onFiltersChange: _onFiltersChange,
    summary,
    onRegenerateSummary: _onRegenerateSummary,
    onDismissSummary,
    onVisibleEventChange,
    footer,
  },
  ref,
) {
  const filtered = useMemo(
    () => applyTimelineFilters(events, filters, viewerLogin),
    [events, filters, viewerLogin],
  );

  const renderItems = useMemo(() => buildRenderItems(filtered), [filtered]);

  const unresolvedIds = useMemo(() => collectUnresolvedThreadIds(filtered), [filtered]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback((index: number) => renderItems[index]?.id ?? index, [renderItems]);
  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => parentRef.current,
    getItemKey,
    estimateSize: () => 120,
    overscan: 4,
  });

  // Map every event id (and folded resolved-thread ids + group ids) to its index
  // in `renderItems` — the virtualizer counts renderItems, so a `filtered` index
  // would scroll/jump to the wrong row once any 2+ resolved run folds.
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    renderItems.forEach((item, idx) => {
      if (item.kind === "event") {
        map.set(item.event.id, idx);
      } else if (item.kind === "resolved-group") {
        map.set(item.id, idx);
        for (const t of item.threads) map.set(t.id, idx);
      } else if (item.kind === "commit-group") {
        map.set(item.id, idx);
        for (const c of item.commits) map.set(c.id, idx);
      } else {
        map.set(item.id, idx);
        for (const c of item.checks) map.set(c.id, idx);
      }
    });
    return map;
  }, [renderItems]);

  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);

  const scrollToIndex = useCallback(
    (index: number) => {
      if (index < 0) return;
      virtualizer.scrollToIndex(index, { align: "center" });
    },
    [virtualizer],
  );

  const scrollToEventId = useCallback(
    (id: string) => {
      const idx = indexById.get(id);
      if (idx === undefined) return;
      scrollToIndex(idx);
    },
    [indexById, scrollToIndex],
  );

  const focusEvent = useCallback(
    (id: string) => {
      setFocusedEventId(id);
      scrollToEventId(id);
    },
    [scrollToEventId],
  );

  const cycleUnresolved = useCallback(
    (direction: 1 | -1) => {
      if (unresolvedIds.length === 0) return;
      const currentIdx = focusedEventId ? unresolvedIds.indexOf(focusedEventId) : -1;
      const nextIdx =
        currentIdx === -1
          ? direction === 1
            ? 0
            : unresolvedIds.length - 1
          : (currentIdx + direction + unresolvedIds.length) % unresolvedIds.length;
      const nextId = unresolvedIds[nextIdx]!;
      setFocusedEventId(nextId);
      scrollToEventId(nextId);
    },
    [unresolvedIds, focusedEventId, scrollToEventId],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToEventId,
      focusEvent,
      nextUnresolved: () => cycleUnresolved(1),
      prevUnresolved: () => cycleUnresolved(-1),
    }),
    [scrollToEventId, focusEvent, cycleUnresolved],
  );

  // Keyboard: n / p for cycling unresolved
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n") {
        event.preventDefault();
        cycleUnresolved(1);
      } else if (event.key === "p") {
        event.preventDefault();
        cycleUnresolved(-1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cycleUnresolved]);

  // Scroll → visible-event callback (debounced). Used for URL round-trip.
  const lastReportedVisibleIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleEventChange) return;
    const root = parentRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const scrollTop = root.scrollTop;
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) {
        if (lastReportedVisibleIdRef.current !== null) {
          lastReportedVisibleIdRef.current = null;
          onVisibleEventChange(null);
        }
        return;
      }
      const topItem =
        items.find((item) => item.start + item.size > scrollTop) ?? items[0]!;
      const ri = renderItems[topItem.index];
      const id = ri && ri.kind === "event" ? ri.event.id : null;
      if (id !== lastReportedVisibleIdRef.current) {
        lastReportedVisibleIdRef.current = id;
        onVisibleEventChange(id);
      }
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, 250);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      root.removeEventListener("scroll", onScroll);
    };
  }, [renderItems, onVisibleEventChange, virtualizer]);

  return (
    <div
      data-testid="pr-timeline"
      className="flex h-full w-full min-h-0 flex-col"
      style={{ background: COLORS.prSurface }}
    >
      {summary ? (
        <div
          className="shrink-0 px-3 pt-3"
          data-testid="pr-timeline-summary"
        >
          <PrAiSummaryCard
            prId={prId}
            summary={summary}
            onDismiss={onDismissSummary ? () => onDismissSummary() : undefined}
          />
        </div>
      ) : null}

      <div
        ref={parentRef}
        data-testid="pr-timeline-viewport"
        className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {filtered.length === 0 ? (
          <div
            className="py-8 text-center text-[12px]"
            style={{ color: COLORS.textDim }}
          >
            {events.length > 0 ? "No events match the current filters." : "No events yet."}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = renderItems[virtualRow.index]!;
              const total = renderItems.length;
              if (item.kind === "resolved-group") {
                return (
                  <ResolvedGroupRow
                    key={item.id}
                    item={item}
                    index={virtualRow.index}
                    total={total}
                    start={virtualRow.start}
                    measure={virtualizer.measureElement}
                    prId={prId}
                    laneId={laneId}
                    repoOwner={repoOwner}
                    repoName={repoName}
                    viewerLogin={viewerLogin}
                    focusedEventId={focusedEventId}
                  />
                );
              }
              if (item.kind === "commit-group") {
                return (
                  <CommitGroupRow
                    key={item.id}
                    item={item}
                    index={virtualRow.index}
                    total={total}
                    start={virtualRow.start}
                    measure={virtualizer.measureElement}
                    focusedEventId={focusedEventId}
                    repoOwner={repoOwner}
                    repoName={repoName}
                  />
                );
              }
              if (item.kind === "checks-summary") {
                return (
                  <ChecksSummaryRow
                    key={item.id}
                    item={item}
                    index={virtualRow.index}
                    total={total}
                    start={virtualRow.start}
                    measure={virtualizer.measureElement}
                  />
                );
              }
              return (
                <TimelineRow
                  key={item.id}
                  event={item.event}
                  index={virtualRow.index}
                  total={total}
                  start={virtualRow.start}
                  measure={virtualizer.measureElement}
                  parentRef={parentRef}
                  focusedEventId={focusedEventId}
                  prId={prId}
                  laneId={laneId}
                  repoOwner={repoOwner}
                  repoName={repoName}
                  viewerLogin={viewerLogin}
                  onFocus={setFocusedEventId}
                />
              );
            })}
          </div>
        )}
        {footer}
      </div>
    </div>
  );
});

export default PrTimeline;

/* ══════════════════ Timeline row ══════════════════ */

type TimelineRowProps = {
  event: PrTimelineEvent;
  index: number;
  total: number;
  start: number;
  measure: (node: HTMLElement | null) => void;
  parentRef: React.MutableRefObject<HTMLDivElement | null>;
  focusedEventId: string | null;
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  onFocus: (id: string) => void;
};

type EventVisual = {
  icon: ReactNode;
  color: string;
  /** When set, the rail node renders the real GitHub avatar (with a small
   * corner state badge) instead of the icon circle — this is how bot logos
   * (greptile / vercel / coderabbit) and human faces show on the rail. */
  avatar?: { login: string; avatarUrl: string | null };
};

// Color mirroring a referenced PR/issue's state (used by cross_reference).
function crossRefColor(state: "open" | "closed" | "merged" | "draft"): string {
  if (state === "merged") return COLORS.accent;
  if (state === "closed") return COLORS.danger;
  if (state === "open") return COLORS.success;
  return COLORS.textMuted;
}

// Per-event-type rail node: a color-coded icon (or a real avatar for
// identity-bearing events), matching github.com's timeline gutter so each step
// reads at a glance (review = face + check badge, commit = dot, merge = purple,
// checks = pass/fail, lifecycle = closed/reopened, etc.).
function eventVisual(event: PrTimelineEvent): EventVisual {
  switch (event.type) {
    case "pr_opened":
      return { icon: <GitPullRequest size={13} weight="bold" />, color: COLORS.success };
    case "merge":
      return { icon: <GitMerge size={13} weight="fill" />, color: COLORS.accent };
    case "commit_push":
      if (event.forcePushed) {
        return { icon: <ArrowsClockwise size={12} weight="bold" />, color: COLORS.textMuted };
      }
      // A single authored commit is identity-bearing → show the author face.
      return {
        icon: <GitCommit size={13} weight="bold" />,
        color: COLORS.textMuted,
        ...(event.author ? { avatar: { login: event.author, avatarUrl: event.avatarUrl } } : {}),
      };
    case "review": {
      const color =
        event.state === "approved"
          ? COLORS.success
          : event.state === "changes_requested"
            ? COLORS.danger
            : COLORS.textMuted;
      const icon =
        event.state === "approved" ? (
          <CheckCircle size={13} weight="fill" />
        ) : event.state === "changes_requested" ? (
          <WarningCircle size={13} weight="fill" />
        ) : event.isBot ? (
          <Robot size={13} weight="bold" />
        ) : (
          <Eye size={13} weight="bold" />
        );
      return {
        icon,
        color,
        ...(event.author ? { avatar: { login: event.author, avatarUrl: event.avatarUrl } } : {}),
      };
    }
    case "review_thread":
      // Render the reviewer's real avatar/logo (e.g. greptile) as the node, with
      // an eye corner-badge — GitHub frames a thread as "<reviewer> reviewed".
      return {
        icon: <Eye size={13} weight="bold" />,
        color: COLORS.textMuted,
        ...(event.author ? { avatar: { login: event.author, avatarUrl: event.avatarUrl } } : {}),
      };
    case "issue_comment":
    case "description":
      return {
        icon: <ChatCircle size={13} weight="bold" />,
        color: COLORS.textMuted,
        ...(event.author ? { avatar: { login: event.author, avatarUrl: event.avatarUrl } } : {}),
      };
    case "check_update": {
      const ok = event.status === "completed" && event.conclusion === "success";
      const bad = event.conclusion === "failure"
        || event.conclusion === "cancelled"
        || event.conclusion === "timed_out"
        || event.conclusion === "action_required";
      return {
        icon: ok ? <CheckCircle size={13} weight="fill" /> : bad ? <WarningCircle size={13} weight="fill" /> : <Clock size={13} weight="bold" />,
        color: ok ? COLORS.success : bad ? COLORS.danger : COLORS.warning,
      };
    }
    case "deployment":
      return { icon: <Package size={13} weight="bold" />, color: deploymentColor(event.state) };
    case "label_change":
      return { icon: <Tag size={13} weight="bold" />, color: COLORS.accent };
    case "lifecycle": {
      if (event.state === "closed") return { icon: <XCircle size={13} weight="fill" />, color: COLORS.danger };
      if (event.state === "converted_to_draft") return { icon: <FileDashed size={13} weight="bold" />, color: COLORS.textMuted };
      // reopened / ready_for_review
      return { icon: <GitPullRequest size={13} weight="bold" />, color: COLORS.success };
    }
    case "cross_reference":
      return { icon: <ArrowBendUpRight size={13} weight="bold" />, color: crossRefColor(event.referencedState) };
    case "renamed":
      return { icon: <Pencil size={13} weight="bold" />, color: COLORS.textMuted };
    case "branch_ref":
      return { icon: <GitBranch size={13} weight="bold" />, color: COLORS.textMuted };
    case "assignment":
      return {
        icon: event.action === "added" ? <UserPlus size={13} weight="bold" /> : <UserMinus size={13} weight="bold" />,
        color: COLORS.textMuted,
        ...(event.author ? { avatar: { login: event.author, avatarUrl: event.avatarUrl } } : {}),
      };
    case "review_request":
      return { icon: <Eye size={13} weight="bold" />, color: COLORS.textMuted };
    case "review_dismissed":
      return { icon: <XCircle size={13} weight="bold" />, color: COLORS.textMuted };
    default:
      return { icon: <Clock size={13} weight="bold" />, color: COLORS.textMuted };
  }
}

// Shared rail-node visual gutter. Takes the resolved {icon,color,avatar} so the
// folded group rows (resolved / commit / checks) can mount a synthetic node and
// keep the connecting line unbroken across every render-item type.
//
// The gutter is a 2px spine, NOT a 24px avatar column: every card header already
// renders the author avatar (`Card` / `PrReviewCard`), so a second copy on the
// rail was pure duplication and cost the thread ~34px of horizontal room.
// Events with no identity (checks, deployments, labels, lifecycle…) still get a
// node — their small type icon, centered on the spine.
function TimelineRailGutter({
  visual,
  isFirst,
  isLast,
  children,
}: {
  visual: EventVisual;
  isFirst: boolean;
  isLast: boolean;
  children: ReactNode;
}) {
  const { icon, color, avatar } = visual;
  return (
    <div className="flex gap-2.5" data-testid="pr-timeline-rail-gutter">
      <div className="relative w-0.5 shrink-0">
        {/* Continuous spine (bridges the 12px row gap top & bottom). */}
        <div
          aria-hidden
          data-testid="pr-timeline-rail-spine"
          className="absolute inset-x-0 rounded-full"
          style={{
            background: COLORS.borderMuted,
            top: isFirst ? 12 : -12,
            bottom: isLast ? "calc(100% - 24px)" : -12,
          }}
        />
        {avatar ? null : (
          <span
            aria-hidden
            data-testid="pr-timeline-rail-icon"
            className="absolute z-10 inline-flex h-4 w-4 items-center justify-center rounded-full"
            style={{
              top: 6,
              left: 1,
              transform: "translateX(-50%)",
              background: COLORS.prSurface,
              color,
            }}
          >
            <span style={{ display: "inline-flex", lineHeight: 0, transform: "scale(0.78)" }}>{icon}</span>
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Wraps each event row in the rail. `isFirst`/`isLast` trim the line at the ends.
function TimelineRail({
  event,
  isFirst,
  isLast,
  children,
}: {
  event: PrTimelineEvent;
  isFirst: boolean;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <TimelineRailGutter visual={eventVisual(event)} isFirst={isFirst} isLast={isLast}>
      {children}
    </TimelineRailGutter>
  );
}

function TimelineRow(props: TimelineRowProps) {
  const {
    event,
    index,
    total,
    start,
    measure,
    parentRef,
    focusedEventId,
    repoOwner,
    repoName,
    viewerLogin,
    onFocus,
  } = props;

  const rowRef = useRef<HTMLDivElement | null>(null);
  const isNear = useNearViewport(parentRef, rowRef);
  const isFocused = focusedEventId === event.id;

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      measure(node);
    },
    [measure],
  );

  useLayoutEffect(() => {
    if (!isNear) return;
    const node = rowRef.current;
    if (!node) return;
    measure(node);
    const raf = window.requestAnimationFrame(() => measure(node));
    return () => window.cancelAnimationFrame(raf);
  }, [event.id, isNear, measure]);

  return (
    <div
      ref={setRef}
      data-index={index}
      data-event-id={event.id}
      data-event-type={event.type}
      id={`pr-timeline-${event.id}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
        paddingBottom: 12,
      }}
    >
      <TimelineRail event={event} isFirst={index === 0} isLast={index === total - 1}>
        <TimelineRowContent
          event={event}
          near={isNear}
          focused={isFocused}
          prId={props.prId}
          laneId={props.laneId}
          repoOwner={repoOwner}
          repoName={repoName}
          viewerLogin={viewerLogin}
          onFocus={onFocus}
        />
      </TimelineRail>
    </div>
  );
}

function ResolvedGroupRow(props: {
  item: Extract<TimelineRenderItem, { kind: "resolved-group" }>;
  index: number;
  total: number;
  start: number;
  measure: (node: HTMLElement | null) => void;
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  focusedEventId: string | null;
}) {
  const { item, index, total, start, measure } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      measure(node);
    },
    [measure],
  );
  return (
    <div
      ref={setRef}
      data-index={index}
      data-resolved-group="true"
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)`, paddingBottom: 12 }}
    >
      <TimelineRailGutter
        visual={{ icon: <CheckCircle size={13} weight="fill" />, color: COLORS.checkPass }}
        isFirst={index === 0}
        isLast={index === total - 1}
      >
        <ResolvedThreadGroup
          threads={item.threads}
          prId={props.prId}
          laneId={props.laneId}
          repoOwner={props.repoOwner}
          repoName={props.repoName}
          viewerLogin={props.viewerLogin}
          focusedEventId={props.focusedEventId}
        />
      </TimelineRailGutter>
    </div>
  );
}

function CommitGroupRow(props: {
  item: Extract<TimelineRenderItem, { kind: "commit-group" }>;
  index: number;
  total: number;
  start: number;
  measure: (node: HTMLElement | null) => void;
  focusedEventId: string | null;
  repoOwner: string;
  repoName: string;
}) {
  const { item, index, total, start, measure, focusedEventId, repoOwner, repoName } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      measure(node);
    },
    [measure],
  );
  const commits = item.commits;
  const containsFocused = focusedEventId != null && commits.some((c) => c.id === focusedEventId);
  const author = commits[0]!.author;
  const avatarUrl = commits[0]!.avatarUrl;
  return (
    <div
      ref={setRef}
      data-index={index}
      data-commit-group="true"
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)`, paddingBottom: 12 }}
    >
      <TimelineRailGutter
        visual={{
          icon: <GitCommit size={13} weight="bold" />,
          color: COLORS.textMuted,
          ...(author ? { avatar: { login: author, avatarUrl } } : {}),
        }}
        isFirst={index === 0}
        isLast={index === total - 1}
      >
        <CommitGroup commits={commits} defaultOpen={containsFocused} focusedEventId={focusedEventId} repoOwner={repoOwner} repoName={repoName} />
      </TimelineRailGutter>
    </div>
  );
}

function ChecksSummaryRow(props: {
  item: Extract<TimelineRenderItem, { kind: "checks-summary" }>;
  index: number;
  total: number;
  start: number;
  measure: (node: HTMLElement | null) => void;
}) {
  const { item, index, total, start, measure } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      measure(node);
    },
    [measure],
  );
  const checks = item.checks;
  const failed = checks.filter((check) => isFailedCheckConclusion(check.conclusion)).length;
  const passed = checks.filter((c) => c.status === "completed" && c.conclusion === "success").length;
  const anyFail = failed > 0;
  return (
    <div
      ref={setRef}
      data-index={index}
      data-checks-summary="true"
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)`, paddingBottom: 12 }}
    >
      <TimelineRailGutter
        visual={{
          icon: anyFail ? <XCircle size={13} weight="fill" /> : <CheckCircle size={13} weight="fill" />,
          color: anyFail ? COLORS.danger : COLORS.success,
        }}
        isFirst={index === 0}
        isLast={index === total - 1}
      >
        <ChecksSummary checks={checks} passed={passed} failed={failed} />
      </TimelineRailGutter>
    </div>
  );
}

function ResolvedThreadGroup({
  threads,
  prId,
  laneId,
  repoOwner,
  repoName,
  viewerLogin,
  focusedEventId,
}: {
  threads: Array<Extract<PrTimelineEvent, { type: "review_thread" }>>;
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  focusedEventId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containsFocused = focusedEventId != null && threads.some((t) => t.id === focusedEventId);
  const expanded = open || containsFocused;
  return (
    <div
      data-testid="pr-timeline-resolved-group"
      style={{ background: COLORS.threadCard, borderRadius: 12, overflow: "hidden" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
      >
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{ color: COLORS.textMuted, transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        <CheckCircle size={14} weight="fill" style={{ color: COLORS.checkPass, flexShrink: 0 }} />
        <span className="flex-1 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
          {threads.length} resolved conversations
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {threads.map((t) => (
            <PrReviewThreadCard
              key={t.id}
              thread={buildPrReviewThreadFromEvent(t)}
              prId={prId}
              laneId={laneId}
              repoOwner={repoOwner}
              repoName={repoName}
              viewerLogin={viewerLogin}
              focused={t.id === focusedEventId}
              onFocus={() => {}}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ══════════════════ Row content by type ══════════════════ */

type TimelineRowContentProps = {
  event: PrTimelineEvent;
  near: boolean;
  focused: boolean;
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  onFocus: (id: string) => void;
};

function TimelineRowContent({
  event,
  near,
  focused,
  prId,
  laneId,
  repoOwner,
  repoName,
  viewerLogin,
  onFocus,
}: TimelineRowContentProps) {
  switch (event.type) {
    case "pr_opened":
      return <PrOpenedBanner event={event} />;
    case "description":
      return (
        <Card author={event.author} avatarUrl={event.avatarUrl} ts={event.timestamp}>
          {near && event.body ? (
            <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
              {event.body}
            </PrMarkdown>
          ) : (
            <BodySkeleton />
          )}
        </Card>
      );
    case "commit_push":
      return <CommitDivider event={event} focused={focused} repoOwner={repoOwner} repoName={repoName} />;
    case "review": {
      // A bot review with real body content keeps the rich collapsible card.
      // Bodyless reviews (bot or human) — the substance is in their inline file
      // threads — collapse to a single "X reviewed" summary row, matching
      // GitHub and avoiding a near-empty duplicate of the thread card.
      const reviewHasBody = Boolean(event.body && event.body.trim());
      if (event.isBot && reviewHasBody) {
        // Render collapsed by default — a late Greptile/Copilot/codex review with
        // a large body should not dump its full summary at the end of the thread.
        return near ? (
          <PrBotReviewCard
            review={buildPrReviewFromEvent(event)}
            repoOwner={repoOwner}
            repoName={repoName}
          />
        ) : (
          <BodySkeleton height={96} />
        );
      }
      return (
        <PrReviewCard
          author={event.author}
          avatarUrl={event.avatarUrl}
          state={event.state}
          body={event.body}
          timestamp={event.timestamp}
          repoOwner={repoOwner}
          repoName={repoName}
          near={near}
        />
      );
    }
    case "review_thread":
      return near ? (
        <div className="flex flex-col gap-1.5">
          {/* GitHub frames an inline thread as "<reviewer> reviewed → <file>". */}
          <div className="flex items-center gap-1.5 px-0.5 text-[12px]">
            <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>
              {event.author ?? "Reviewer"}
            </span>
            <span style={{ color: COLORS.textMuted }}>reviewed</span>
            <Timestamp ts={event.timestamp} />
          </div>
          <PrReviewThreadCard
            thread={buildPrReviewThreadFromEvent(event)}
            prId={prId}
            laneId={laneId}
            repoOwner={repoOwner}
            repoName={repoName}
            viewerLogin={viewerLogin}
            focused={focused}
            onFocus={() => onFocus(event.id)}
          />
        </div>
      ) : (
        <BodySkeleton height={140} />
      );
    case "issue_comment": {
      // A bot-authored issue comment (e.g. ADE's "## ADE review" summary) can be
      // huge; collapse long ones so they don't wall off the end of the thread.
      const collapseBotComment = Boolean(event.isBot && event.body && isLongBotCommentBody(event.body));
      return (
        <Card
          author={event.author}
          avatarUrl={event.avatarUrl}
          ts={event.timestamp}
        >
          {near && event.body ? (
            collapseBotComment ? (
              <CollapsibleCommentBody body={event.body} repoOwner={repoOwner} repoName={repoName} />
            ) : (
              <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
                {event.body}
              </PrMarkdown>
            )
          ) : (
            <BodySkeleton />
          )}
        </Card>
      );
    }
    case "check_update":
      return (
        <InlineRow icon={<CheckIconForConclusion conclusion={event.conclusion} status={event.status} />}>
          <span style={{ color: COLORS.textSecondary }}>
            Check{" "}
            <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
              {event.checkName}
            </span>
            {" · "}
            <span style={{ color: checkConclusionColor(event.conclusion, event.status) }}>
              {event.status === "completed" ? event.conclusion ?? "completed" : event.status}
            </span>
          </span>
          <Timestamp ts={event.timestamp} />
        </InlineRow>
      );
    case "deployment":
      return (
        <InlineRow icon={<Package size={12} weight="bold" />}>
          <span style={{ color: COLORS.textSecondary }}>
            Deployment to{" "}
            <span style={{ color: COLORS.textPrimary }}>{event.environment}</span>
            {" · "}
            <span style={{ color: deploymentColor(event.state) }}>{event.state}</span>
          </span>
          <Timestamp ts={event.timestamp} />
        </InlineRow>
      );
    case "label_change":
      return (
        <InlineRow icon={<Tag size={12} weight="bold" />}>
          <span style={{ color: COLORS.textSecondary }}>
            <strong style={{ color: COLORS.textPrimary }}>{event.author ?? "someone"}</strong>{" "}
            {event.action === "added" ? "added" : "removed"} label{" "}
            <span
              style={{
                background: event.color ? `#${event.color}24` : COLORS.recessedBg,
                border: `1px solid ${event.color ? `#${event.color}48` : COLORS.border}`,
                color: event.color ? `#${event.color}` : COLORS.textPrimary,
                padding: "0 6px",
                fontFamily: MONO_FONT,
              }}
            >
              {event.label}
            </span>
          </span>
          <Timestamp ts={event.timestamp} />
        </InlineRow>
      );
    case "merge":
      return <MergeRow event={event} />;
    case "lifecycle":
      return <LifecycleRow event={event} />;
    case "cross_reference":
      return <CrossReferenceRow event={event} />;
    case "renamed":
      return <RenamedRow event={event} />;
    case "branch_ref":
      return <BranchRefRow event={event} />;
    case "assignment":
      return <AssignmentRow event={event} />;
    case "review_request":
      return <ReviewRequestRow event={event} />;
    case "review_dismissed":
      return <ReviewDismissedRow event={event} />;
    default:
      return null;
  }
}

function PrOpenedBanner({
  event,
}: {
  event: Extract<PrTimelineEvent, { type: "pr_opened" }>;
}) {
  const openedColor = COLORS.success;
  return (
    <div
      data-testid="pr-timeline-opened-banner"
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 10,
        border: `1px solid color-mix(in srgb, ${openedColor} 32%, ${COLORS.border})`,
        background: `linear-gradient(135deg, color-mix(in srgb, ${openedColor} 16%, ${COLORS.pageBg}) 0%, color-mix(in srgb, ${COLORS.accent} 12%, ${COLORS.pageBg}) 52%, ${COLORS.cardBg} 100%)`,
        boxShadow: `0 1px 0 color-mix(in srgb, ${openedColor} 18%, transparent) inset`,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: 4,
          background: `linear-gradient(180deg, ${openedColor}, ${COLORS.accent})`,
        }}
      />
      <div style={{ padding: "14px 16px 14px 18px" }}>
        <div className="flex items-start gap-3">
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              background: `color-mix(in srgb, ${openedColor} 18%, transparent)`,
              border: `1px solid color-mix(in srgb, ${openedColor} 34%, transparent)`,
              color: openedColor,
            }}
          >
            <GitPullRequest size={18} weight="fill" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="flex flex-wrap items-center gap-2">
              <span style={inlineBadge(openedColor, { fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" })}>
                Pull request opened
              </span>
              {event.isDraft ? (
                <span style={inlineBadge(COLORS.warning, { fontSize: 10, fontWeight: 600 })}>
                  Draft
                </span>
              ) : null}
              <span
                className="ml-auto text-[10px]"
                style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
              >
                {relativeWhen(event.timestamp)}
              </span>
            </div>
            <div
              className="mt-2 text-[15px] font-semibold leading-[1.35]"
              style={{ color: COLORS.textPrimary }}
            >
              {event.title}
            </div>
            <div
              className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
              style={{ color: COLORS.textSecondary }}
            >
              <span style={{ fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                #{event.githubPrNumber}
              </span>
              {event.author ? (
                <span>
                  opened by{" "}
                  <strong style={{ color: COLORS.textPrimary }}>@{event.author}</strong>
                </span>
              ) : null}
              <span style={{ color: COLORS.textMuted }}>
                {event.repoOwner}/{event.repoName}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <BranchChip label={event.headBranch} accent />
              <ArrowRight size={12} weight="bold" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
              <BranchChip label={event.baseBranch} />
              {event.additions > 0 || event.deletions > 0 ? (
                <span className="ml-1 text-[11px]" style={{ fontFamily: MONO_FONT }}>
                  <span style={{ color: COLORS.success }}>+{event.additions}</span>
                  {" "}
                  <span style={{ color: COLORS.danger }}>-{event.deletions}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BranchChip({ label, accent = false }: { label: string; accent?: boolean }) {
  const color = accent ? COLORS.accent : COLORS.textSecondary;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontFamily: MONO_FONT,
        color,
        background: accent
          ? `color-mix(in srgb, ${COLORS.accent} 12%, transparent)`
          : COLORS.recessedBg,
        border: `1px solid ${accent ? COLORS.accentBorder : COLORS.border}`,
      }}
    >
      {label}
    </span>
  );
}

/* ══════════════════ Compact lifecycle / activity rows ══════════════════ */

// Shared bits for the borderless one-liner activity rows.
function ghProfileUrl(login: string): string {
  // Best-effort GitHub profile; bot logins (e.g. "greptile-apps[bot]") drop the
  // suffix. Opens externally so the user lands on github.com.
  return `https://github.com/${login.replace(/\[bot\]$/i, "")}`;
}

function openExternal(url: string) {
  void window.ade.app.openExternal(url);
}

/** A username that opens its GitHub profile externally, like github.com. */
function GhUserLink({
  login,
  bold = true,
  interactive = true,
}: {
  login: string | null;
  bold?: boolean;
  interactive?: boolean;
}) {
  const name = login ?? "someone";
  const style = {
    color: COLORS.textPrimary,
    fontWeight: bold ? 600 : 400,
  };
  if (!login) return <strong style={style}>{name}</strong>;
  if (!interactive) {
    return <span style={style}>{name}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openExternal(ghProfileUrl(login)); }}
      className="hover:underline"
      style={{
        ...style,
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        cursor: "pointer",
      }}
    >
      {name}
    </button>
  );
}

function Actor({ name, interactive = true }: { name: string | null; interactive?: boolean }) {
  return <GhUserLink login={name} interactive={interactive} />;
}

// Inline `#<n> <title>` chip tinted by the referenced PR/issue state — the
// little colored cross-link GitHub renders for "mentioned this".
function RefLinkChip({
  refNumber,
  refTitle,
  state,
}: {
  refNumber: number;
  refTitle: string;
  state: "open" | "closed" | "merged" | "draft";
}) {
  const color = crossRefColor(state);
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-[11px]"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, ${COLORS.border})`,
        borderRadius: 6,
        padding: "1px 7px",
        maxWidth: "100%",
      }}
    >
      <span style={{ color, fontFamily: MONO_FONT, flexShrink: 0 }}>#{refNumber}</span>
      <span className="truncate" style={{ color: COLORS.textSecondary }}>
        {refTitle}
      </span>
    </span>
  );
}

function MergeRow({ event }: { event: Extract<PrTimelineEvent, { type: "merge" }> }) {
  // Full-width hairline above the merge segments the timeline into a phase,
  // matching GitHub's emphasized merge line.
  return (
    <div data-testid="pr-timeline-merge-row" style={{ borderTop: `1px solid ${COLORS.borderMuted}` }}>
      <InlineRow icon={<GitMerge size={12} weight="fill" style={{ color: COLORS.accent }} />}>
        <span style={{ color: COLORS.textSecondary }}>
          <Actor name={event.author} /> merged
          {event.mergeCommitSha ? (
            <>
              {" commit "}
              <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                {event.mergeCommitSha.slice(0, 7)}
              </span>
            </>
          ) : (
            " this"
          )}
          {event.baseBranch ? (
            <>
              {" into "}
              <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{event.baseBranch}</span>
            </>
          ) : null}
          {event.method ? <span style={{ color: COLORS.textMuted }}> · {event.method}</span> : null}
        </span>
        <Timestamp ts={event.timestamp} />
      </InlineRow>
    </div>
  );
}

function LifecycleRow({ event }: { event: Extract<PrTimelineEvent, { type: "lifecycle" }> }) {
  const visual = eventVisual(event);
  const text =
    event.state === "closed"
      ? "closed this"
      : event.state === "reopened"
        ? "reopened this"
        : event.state === "ready_for_review"
          ? "marked this pull request as ready for review"
          : "marked this pull request as a draft";
  return (
    <InlineRow icon={<span style={{ color: visual.color }}>{visual.icon}</span>}>
      <span style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} /> {text}
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function CrossReferenceRow({ event }: { event: Extract<PrTimelineEvent, { type: "cross_reference" }> }) {
  return (
    <InlineRow icon={<ArrowBendUpRight size={12} weight="bold" style={{ color: crossRefColor(event.referencedState) }} />}>
      <span className="shrink-0" style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} /> mentioned this {event.isPullRequest ? "pull request" : "issue"}
      </span>
      <RefLinkChip refNumber={event.refNumber} refTitle={event.refTitle} state={event.referencedState} />
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function RenamedRow({ event }: { event: Extract<PrTimelineEvent, { type: "renamed" }> }) {
  return (
    <InlineRow icon={<Pencil size={12} weight="bold" />}>
      <span className="min-w-0" style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} /> changed the title{" "}
        <span style={{ color: COLORS.textDim, textDecoration: "line-through" }}>{event.from}</span>{" "}
        <span style={{ color: COLORS.textPrimary }}>{event.to}</span>
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function BranchRefRow({ event }: { event: Extract<PrTimelineEvent, { type: "branch_ref" }> }) {
  return (
    <InlineRow icon={<GitBranch size={12} weight="bold" />}>
      <span style={{ color: COLORS.textSecondary }}>
        {event.action === "base_changed" ? (
          <>
            <Actor name={event.author} /> changed the base branch
            {event.fromBranch ? (
              <>
                {" from "}
                <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{event.fromBranch}</span>
              </>
            ) : null}
            {" to "}
            <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{event.branch}</span>
          </>
        ) : (
          <>
            <Actor name={event.author} /> {event.action === "deleted" ? "deleted" : "restored"} the{" "}
            <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{event.branch}</span> branch
          </>
        )}
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function AssignmentRow({ event }: { event: Extract<PrTimelineEvent, { type: "assignment" }> }) {
  const self = event.author && event.author === event.assignee;
  return (
    <InlineRow
      icon={
        event.action === "added" ? (
          <UserPlus size={12} weight="bold" />
        ) : (
          <UserMinus size={12} weight="bold" />
        )
      }
    >
      <span className="flex min-w-0 items-center gap-1.5" style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} />
        {event.action === "added" ? (self ? " self-assigned" : " assigned") : " unassigned"}
        {!self ? (
          <span className="inline-flex items-center gap-1">
            <PrUserAvatar user={{ login: event.assignee, avatarUrl: event.assigneeAvatarUrl }} size={16} />
            <strong style={{ color: COLORS.textPrimary }}>{event.assignee}</strong>
          </span>
        ) : null}
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function ReviewRequestRow({ event }: { event: Extract<PrTimelineEvent, { type: "review_request" }> }) {
  return (
    <InlineRow icon={<PrUserAvatar user={{ login: event.author ?? "user", avatarUrl: event.avatarUrl }} size={16} />}>
      <span style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} />{" "}
        {event.action === "added" ? "requested a review from" : "removed the review request for"}{" "}
        {event.team
          ? <strong style={{ color: COLORS.textPrimary }}>{event.team} (team)</strong>
          : <GhUserLink login={event.reviewer} />}
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

function ReviewDismissedRow({ event }: { event: Extract<PrTimelineEvent, { type: "review_dismissed" }> }) {
  return (
    <InlineRow icon={<XCircle size={12} weight="bold" />}>
      <span style={{ color: COLORS.textSecondary }}>
        <Actor name={event.author} /> dismissed{" "}
        <strong style={{ color: COLORS.textPrimary }}>{event.reviewer ?? "a reviewer"}</strong>
        {"'s review"}
        {event.reason ? <span style={{ color: COLORS.textMuted }}> · {event.reason}</span> : null}
      </span>
      <Timestamp ts={event.timestamp} />
    </InlineRow>
  );
}

/* ══════════════════ Commit group + checks summary ══════════════════ */

function CommitGroup({
  commits,
  defaultOpen,
  focusedEventId,
  repoOwner,
  repoName,
}: {
  commits: Array<Extract<PrTimelineEvent, { type: "commit_push" }>>;
  defaultOpen: boolean;
  focusedEventId: string | null;
  repoOwner: string;
  repoName: string;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || defaultOpen;
  const author = commits[0]!.author;
  return (
    <div
      data-testid="pr-timeline-commit-group"
      style={{ background: COLORS.threadCard, borderRadius: 12, overflow: "hidden" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
      >
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{ color: COLORS.textMuted, transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        <GitCommit size={14} weight="bold" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
        <span className="flex-1 text-[12px]" style={{ color: COLORS.textSecondary }}>
          <Actor name={author} interactive={false} /> added {commits.length} commits
        </span>
        <Timestamp ts={commits[commits.length - 1]!.timestamp} />
      </button>
      {expanded ? (
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {commits.map((c) => (
            <div
              key={c.id}
              data-event-id={c.id}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
              style={{
                background: c.id === focusedEventId ? COLORS.accentSubtle : "transparent",
              }}
            >
              <GitCommit size={12} weight="bold" style={{ color: COLORS.textDim, flexShrink: 0 }} />
              <span className="truncate text-[12px]" style={{ color: COLORS.textSecondary }}>
                {c.subject || "Commit"}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <CommitStatusDot status={c.commitStatus} />
                <ShortShaChip sha={c.shortSha} url={commitUrl(repoOwner, repoName, c.sha)} />
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChecksSummary({
  checks,
  passed,
  failed,
}: {
  checks: Array<Extract<PrTimelineEvent, { type: "check_update" }>>;
  passed: number;
  failed: number;
}) {
  const [open, setOpen] = useState(false);
  const pending = checks.length - passed - failed;
  const label =
    failed > 0
      ? `${failed} ${failed === 1 ? "check" : "checks"} failed${passed ? ` · ${passed} passed` : ""}`
      : pending > 0 && passed === 0
        ? `${pending} ${pending === 1 ? "check" : "checks"} running`
        : `${passed} ${passed === 1 ? "check" : "checks"} passed`;
  return (
    <div
      data-testid="pr-timeline-checks-summary"
      style={{ background: COLORS.threadCard, borderRadius: 12, overflow: "hidden" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
      >
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{ color: COLORS.textMuted, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        {failed > 0 ? (
          <XCircle size={14} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />
        ) : pending > 0 && passed === 0 ? (
          <DotsThreeOutline size={14} weight="fill" style={{ color: COLORS.warning, flexShrink: 0 }} />
        ) : (
          <CheckCircle size={14} weight="fill" style={{ color: COLORS.checkPass, flexShrink: 0 }} />
        )}
        <span className="flex-1 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
          {label}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {checks.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
            >
              <CheckIconForConclusion conclusion={c.conclusion} status={c.status} />
              <span className="truncate text-[12px]" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                {c.checkName}
              </span>
              <span
                className="shrink-0 text-[11px]"
                style={{ color: checkConclusionColor(c.conclusion, c.status) }}
              >
                {c.status === "completed" ? c.conclusion ?? "completed" : c.status}
              </span>
              {c.detailsUrl ? (
                <a
                  href={c.detailsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px]"
                  style={{ color: COLORS.textMuted }}
                  onClick={(e) => e.stopPropagation()}
                >
                  Details <ArrowSquareOut size={11} weight="bold" />
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Small ✓/✗/● dot reflecting a commit's status rollup. Null-tolerant: renders
// nothing when the per-commit status hasn't been fetched yet.
function CommitStatusDot({ status }: { status: "success" | "failure" | "pending" | null | undefined }) {
  if (!status) return null;
  if (status === "success") {
    return <CheckCircle size={12} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} />;
  }
  if (status === "failure") {
    return <XCircle size={12} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />;
  }
  return <DotsThreeOutline size={12} weight="fill" style={{ color: COLORS.warning, flexShrink: 0 }} />;
}

function commitUrl(owner: string, repo: string, sha: string): string {
  return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

// Monospace short-SHA chip; the smallest visible unit of a commit identity.
// When a `url` is given it opens the commit on GitHub externally.
function ShortShaChip({ sha, url }: { sha: string; url?: string }) {
  const baseStyle = {
    color: COLORS.textDim,
    fontFamily: MONO_FONT,
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 5,
    padding: "1px 5px",
  } as const;
  if (!url) {
    return <span className="shrink-0 text-[10px]" style={baseStyle}>{sha}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openExternal(url); }}
      className="shrink-0 text-[10px] hover:underline"
      style={{ ...baseStyle, cursor: "pointer" }}
    >
      {sha}
    </button>
  );
}

function CommitDivider({
  event,
  focused,
  repoOwner,
  repoName,
}: {
  event: Extract<PrTimelineEvent, { type: "commit_push" }>;
  focused: boolean;
  repoOwner: string;
  repoName: string;
}) {
  // Force-pushes are noise — render them as a slim centered divider rather than a
  // full commit row. When before/after SHAs are present, surface them GitHub-style.
  if (event.forcePushed) {
    return (
      <div
        data-testid="pr-timeline-commit-divider"
        className="flex items-center gap-3 px-2 py-2"
        style={{
          background: focused ? COLORS.accentSubtle : "transparent",
          borderRadius: 8,
          transition: "background 120ms ease",
        }}
      >
        <div className="h-px flex-1" style={{ background: focused ? COLORS.accent : COLORS.borderMuted, opacity: focused ? 0.4 : 1 }} />
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]"
          style={{
            color: focused ? COLORS.accent : COLORS.textMuted,
            background: focused ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent",
            border: focused ? `1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)` : "1px solid transparent",
          }}
        >
          <ArrowsClockwise size={12} weight="bold" />
          {event.author ? <strong style={{ color: focused ? COLORS.accent : COLORS.textSecondary }}>{event.author}</strong> : null}
          force-pushed
          {event.beforeSha && event.afterSha ? (
            <span className="flex items-center gap-1">
              from <ShortShaChip sha={event.beforeSha.slice(0, 7)} url={commitUrl(repoOwner, repoName, event.beforeSha)} /> to{" "}
              <ShortShaChip sha={event.afterSha.slice(0, 7)} url={commitUrl(repoOwner, repoName, event.afterSha)} />
            </span>
          ) : null}
          <span style={{ color: COLORS.textDim }}>· {relativeWhen(event.timestamp)}</span>
        </span>
        <div className="h-px flex-1" style={{ background: focused ? COLORS.accent : COLORS.borderMuted, opacity: focused ? 0.4 : 1 }} />
      </div>
    );
  }
  return (
    <div
      data-testid="pr-timeline-commit-divider"
      className="flex flex-col gap-1 px-2 py-1.5"
      style={{
        background: focused ? COLORS.accentSubtle : "transparent",
        borderLeft: focused ? `2px solid ${COLORS.accent}` : "2px solid transparent",
        borderRadius: 6,
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="truncate text-[12px]" style={{ color: COLORS.textSecondary }}>
          <span style={{ color: COLORS.textMuted, fontWeight: 500 }}>commit:</span>{" "}
          {event.subject || "Commit"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <CommitStatusDot status={event.commitStatus} />
          <ShortShaChip sha={event.shortSha} url={commitUrl(repoOwner, repoName, event.sha)} />
          <Timestamp ts={event.timestamp} />
        </span>
      </div>
      {event.bodyText && event.bodyText.trim() ? (
        <span
          className="truncate text-[11px]"
          style={{ color: COLORS.textDim }}
        >
          {event.bodyText.trim().split("\n")[0]}
        </span>
      ) : null}
    </div>
  );
}

/* ══════════════════ Small building blocks ══════════════════ */

function Card({
  author,
  avatarUrl,
  ts,
  children,
}: {
  author: string | null;
  avatarUrl?: string | null;
  ts: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 px-4 py-3"
      style={{
        background: COLORS.threadCard,
        border: "none",
        borderRadius: 12,
      }}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <PrUserAvatar user={{ login: author ?? "unknown", avatarUrl: avatarUrl ?? null }} size={22} />
        <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{author ?? "unknown"}</span>
        <Timestamp ts={ts} />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function InlineRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-[11px]"
      style={{
        background: "transparent",
        color: COLORS.textSecondary,
      }}
    >
      <span style={{ color: COLORS.textMuted }}>{icon}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

function Timestamp({ ts }: { ts: string }) {
  return (
    <span
      className="ml-auto text-[10px]"
      style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
    >
      {relativeWhen(ts)}
    </span>
  );
}

function BodySkeleton({ height = 72 }: { height?: number }) {
  return (
    <div
      aria-hidden
      data-testid="pr-timeline-skeleton"
      style={{
        height,
        background: COLORS.recessedBg,
        border: `1px dashed ${COLORS.border}`,
      }}
    />
  );
}

const COLLAPSED_BOT_COMMENT_MAX_HEIGHT = 220;

// Roughly a dozen rendered lines. Also treats a very long single block as long so
// a wall of prose with few newlines still collapses.
function isLongBotCommentBody(body: string): boolean {
  return body.split(/\r?\n/).length > 12 || body.length > 900;
}

// Collapsed-by-default markdown body with an expand affordance, reusing the same
// collapse idiom as PrBotReviewCard (no new visual style) so a long bot comment
// shows a clamped preview instead of a wall of text.
function CollapsibleCommentBody({
  body,
  repoOwner,
  repoName,
}: {
  body: string;
  repoOwner: string;
  repoName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div
        style={{
          position: "relative",
          maxHeight: open ? undefined : COLLAPSED_BOT_COMMENT_MAX_HEIGHT,
          overflow: "hidden",
        }}
      >
        <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
          {body}
        </PrMarkdown>
        {open ? null : (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "auto 0 0 0",
              height: 48,
              background: `linear-gradient(to bottom, transparent, ${COLORS.threadCard})`,
            }}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start text-[11px] transition-colors"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
      >
        <CaretRight
          size={11}
          weight="bold"
          className="transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

/* ══════════════════ Human review card (small, inline) ══════════════════ */

function reviewStateColor(state: string): string {
  if (state === "approved") return COLORS.success;
  if (state === "changes_requested") return COLORS.danger;
  if (state === "dismissed") return COLORS.textDim;
  return COLORS.textMuted;
}

function reviewStateLabel(state: string): string {
  if (state === "approved") return "Approved";
  if (state === "changes_requested") return "Requested changes";
  if (state === "dismissed") return "Dismissed";
  if (state === "commented") return "Commented";
  return "Pending";
}

// Past-tense summary used for the compact (bodyless) review row, matching
// GitHub's "X approved these changes" / "X reviewed" timeline lines.
function reviewActionLabel(state: string): string {
  if (state === "approved") return "approved these changes";
  if (state === "changes_requested") return "requested changes";
  if (state === "dismissed") return "dismissed their review";
  return "reviewed";
}

function reviewStateIcon(state: string, size = 13): ReactNode {
  if (state === "approved") return <CheckCircle size={size} weight="fill" style={{ color: COLORS.success }} />;
  if (state === "changes_requested") return <WarningCircle size={size} weight="fill" style={{ color: COLORS.danger }} />;
  return <ChatCircle size={size} weight="bold" style={{ color: COLORS.textMuted }} />;
}

function PrReviewCard({
  author,
  avatarUrl,
  state,
  body,
  timestamp,
  repoOwner,
  repoName,
  near,
}: {
  author: string | null;
  avatarUrl?: string | null;
  state: string;
  body: string | null;
  timestamp: string;
  repoOwner: string;
  repoName: string;
  near: boolean;
}) {
  const hasBody = Boolean(body && body.trim());

  // No top-level body (the substance lives in inline review threads). Render a
  // compact one-line summary instead of an empty "Commented" card — the inline
  // comments show under their own file threads, exactly like GitHub.
  if (!hasBody) {
    return (
      <InlineRow icon={reviewStateIcon(state)}>
        <PrUserAvatar user={{ login: author ?? "reviewer", avatarUrl: avatarUrl ?? null }} size={18} />
        <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{author ?? "reviewer"}</span>
        <span style={{ color: COLORS.textSecondary }}>{reviewActionLabel(state)}</span>
        <Timestamp ts={timestamp} />
      </InlineRow>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3"
      style={{ background: COLORS.threadCard, border: "none", borderRadius: 12 }}
      data-testid="pr-timeline-review-card"
    >
      <div className="flex items-center gap-2 text-[12px]">
        <PrUserAvatar user={{ login: author ?? "reviewer", avatarUrl: avatarUrl ?? null }} size={22} />
        <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{author ?? "reviewer"}</span>
        {reviewStateIcon(state, 12)}
        <span style={{ color: reviewStateColor(state) }}>{reviewStateLabel(state)}</span>
        <Timestamp ts={timestamp} />
      </div>
      {body ? (
        near ? (
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
            {body as string}
          </PrMarkdown>
        ) : (
          <BodySkeleton />
        )
      ) : null}
    </div>
  );
}

function isFailedCheckConclusion(conclusion: PrCheck["conclusion"]): boolean {
  return conclusion === "failure"
    || conclusion === "cancelled"
    || conclusion === "timed_out"
    || conclusion === "action_required";
}

function CheckIconForConclusion({
  conclusion,
  status,
}: {
  conclusion: PrCheck["conclusion"];
  status: "queued" | "in_progress" | "completed";
}) {
  if (status !== "completed") {
    return <Clock size={12} weight="bold" style={{ color: COLORS.warning }} />;
  }
  if (conclusion === "success") {
    return <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} />;
  }
  if (isFailedCheckConclusion(conclusion)) {
    return <WarningCircle size={12} weight="fill" style={{ color: COLORS.danger }} />;
  }
  return <Clock size={12} weight="bold" style={{ color: COLORS.textMuted }} />;
}

function checkConclusionColor(
  conclusion: PrCheck["conclusion"],
  status: "queued" | "in_progress" | "completed",
): string {
  if (status !== "completed") return COLORS.warning;
  if (conclusion === "success") return COLORS.success;
  if (isFailedCheckConclusion(conclusion)) return COLORS.danger;
  return COLORS.textMuted;
}

function deploymentColor(state: PrDeploymentState): string {
  if (state === "success") return COLORS.success;
  if (state === "failure" || state === "error") return COLORS.danger;
  if (state === "in_progress" || state === "pending" || state === "queued") return COLORS.warning;
  return COLORS.textMuted;
}

function buildPrReviewFromEvent(event: Extract<PrTimelineEvent, { type: "review" }>): PrReview {
  return {
    reviewer: event.author ?? "bot",
    reviewerAvatarUrl: event.avatarUrl ?? null,
    state: event.state,
    body: event.body,
    submittedAt: event.timestamp,
  };
}

function buildPrReviewThreadFromEvent(
  event: Extract<PrTimelineEvent, { type: "review_thread" }>,
): PrReviewThread {
  const fullComments = event.comments ?? [];
  return {
    id: event.threadId,
    isResolved: event.isResolved,
    isOutdated: event.isOutdated,
    path: event.path,
    line: event.line,
    originalLine: event.originalLine ?? null,
    startLine: event.startLine,
    originalStartLine: event.originalStartLine ?? null,
    diffSide: event.diffSide ?? null,
    url: fullComments[fullComments.length - 1]?.url ?? null,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    // Full comments (greptile + the author's reply) with their diff hunks. Falls
    // back to a synthetic first comment only for older payloads that lack them.
    comments: fullComments.length > 0
      ? fullComments
      : event.firstCommentBody
        ? [
            {
              id: `${event.threadId}:first`,
              author: event.author ?? "unknown",
              authorAvatarUrl: event.avatarUrl ?? null,
              body: event.firstCommentBody,
              url: null,
              createdAt: event.timestamp,
              updatedAt: event.timestamp,
            },
          ]
        : [],
  };
}
