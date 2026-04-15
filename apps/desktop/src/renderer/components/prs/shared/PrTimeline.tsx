import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChatCircle,
  CheckCircle,
  GitCommit,
  Package,
  Tag,
  GitMerge,
  ArrowDown,
  Robot,
  WarningCircle,
  Clock,
} from "@phosphor-icons/react";

import type {
  PrAiSummary,
  PrTimelineEvent,
  PrDeploymentState,
  PrReview,
  PrReviewThread,
} from "../../../../shared/types/prs";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import { PrMarkdown } from "./PrMarkdown";
import { PrReviewThreadCard } from "./PrReviewThreadCard";
import { PrBotReviewCard, detectBotProvider } from "./PrBotReviewCard";
import { PrAiSummaryCard } from "./PrAiSummaryCard";

/* ══════════════════ Types ══════════════════ */

export type PrTimelineFilters = {
  showResolved: boolean;
  showOutdated: boolean;
  onlyMine: boolean;
  onlyBots: boolean;
};

export const DEFAULT_PR_TIMELINE_FILTERS: PrTimelineFilters = {
  showResolved: false,
  showOutdated: false,
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

export const PrTimeline = forwardRef<PrTimelineRef, PrTimelineProps>(function PrTimeline(
  {
    events,
    prId,
    laneId,
    repoOwner,
    repoName,
    viewerLogin,
    filters,
    onFiltersChange,
    summary,
    onRegenerateSummary,
    onDismissSummary,
    onVisibleEventChange,
  },
  ref,
) {
  const filtered = useMemo(
    () => applyTimelineFilters(events, filters, viewerLogin),
    [events, filters, viewerLogin],
  );

  const unresolvedIds = useMemo(() => collectUnresolvedThreadIds(filtered), [filtered]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 4,
  });

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((event, idx) => map.set(event.id, idx));
    return map;
  }, [filtered]);

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
      const event = filtered[topItem.index];
      const id = event?.id ?? null;
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
  }, [filtered, onVisibleEventChange, virtualizer]);

  return (
    <div
      data-testid="pr-timeline"
      className="flex h-full w-full min-h-0 flex-col"
      style={{ background: COLORS.pageBg }}
    >
      <FilterToolbar filters={filters} onChange={onFiltersChange} />

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
          {onRegenerateSummary ? <span className="hidden" /> : null}
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
            No events match the current filters.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const event = filtered[virtualRow.index]!;
              return (
                <TimelineRow
                  key={event.id}
                  event={event}
                  index={virtualRow.index}
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

        {unresolvedIds.length > 0 ? (
          <button
            type="button"
            onClick={() => cycleUnresolved(1)}
            className="flex h-8 items-center gap-1.5 px-3 text-[11px] font-medium"
            style={{
              position: "sticky",
              bottom: 12,
              marginLeft: "auto",
              marginRight: 0,
              background: COLORS.accentSubtle,
              border: `1px solid ${COLORS.accentBorder}`,
              borderRadius: 8,
              color: COLORS.accent,
              boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
            }}
            data-testid="pr-timeline-unresolved-fab"
            aria-label={`Jump to unresolved threads (${unresolvedIds.length})`}
          >
            <ArrowDown size={11} weight="bold" />
            {unresolvedIds.length} unresolved
          </button>
        ) : null}
      </div>
    </div>
  );
});

export default PrTimeline;

/* ══════════════════ Filter toolbar ══════════════════ */

const FILTER_BUTTONS: Array<{
  key: "all" | "unresolved" | "mine" | "bots" | "outdated";
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "unresolved", label: "Unresolved" },
  { key: "mine", label: "Mine" },
  { key: "bots", label: "Bots only" },
  { key: "outdated", label: "Show outdated" },
];

function isAllSelected(filters: PrTimelineFilters): boolean {
  return (
    filters.showResolved &&
    filters.showOutdated &&
    !filters.onlyMine &&
    !filters.onlyBots
  );
}

function FilterToolbar({
  filters,
  onChange,
}: {
  filters: PrTimelineFilters;
  onChange: (next: PrTimelineFilters) => void;
}) {
  const isActive = useCallback(
    (key: (typeof FILTER_BUTTONS)[number]["key"]): boolean => {
      if (key === "all") return isAllSelected(filters);
      if (key === "unresolved") return !filters.showResolved;
      if (key === "mine") return filters.onlyMine;
      if (key === "bots") return filters.onlyBots;
      return filters.showOutdated;
    },
    [filters],
  );

  const toggle = useCallback(
    (key: (typeof FILTER_BUTTONS)[number]["key"]) => {
      if (key === "all") {
        onChange({
          showResolved: true,
          showOutdated: true,
          onlyMine: false,
          onlyBots: false,
        });
        return;
      }
      if (key === "unresolved") {
        onChange({ ...filters, showResolved: !filters.showResolved });
        return;
      }
      if (key === "mine") {
        onChange({ ...filters, onlyMine: !filters.onlyMine });
        return;
      }
      if (key === "bots") {
        onChange({ ...filters, onlyBots: !filters.onlyBots });
        return;
      }
      onChange({ ...filters, showOutdated: !filters.showOutdated });
    },
    [filters, onChange],
  );

  return (
    <div
      className="flex shrink-0 items-center gap-1 px-3"
      style={{ borderBottom: `1px solid ${COLORS.border}`, height: 38 }}
      data-testid="pr-timeline-filter-toolbar"
    >
      {FILTER_BUTTONS.map((btn) => {
        const active = isActive(btn.key);
        const style: CSSProperties = active
          ? {
              background: COLORS.accentSubtle,
              border: `1px solid ${COLORS.accentBorder}`,
              color: COLORS.accent,
            }
          : {
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted,
            };
        return (
          <button
            key={btn.key}
            type="button"
            onClick={() => toggle(btn.key)}
            className="h-6 px-2 text-[11px] font-medium transition-colors"
            style={style}
            aria-pressed={active}
            data-filter-key={btn.key}
          >
            {btn.label}
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════ Timeline row ══════════════════ */

type TimelineRowProps = {
  event: PrTimelineEvent;
  index: number;
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

function TimelineRow(props: TimelineRowProps) {
  const {
    event,
    index,
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
    case "description":
      return (
        <Card icon={<ChatCircle size={12} weight="fill" />} author={event.author} ts={event.timestamp}>
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
      return (
        <InlineRow icon={<GitCommit size={12} weight="bold" />}>
          <span style={{ color: COLORS.textSecondary }}>
            <strong style={{ color: COLORS.textPrimary }}>{event.author ?? "someone"}</strong>{" "}
            pushed{" "}
            <span
              style={{
                color: COLORS.textMuted,
                fontFamily: MONO_FONT,
              }}
            >
              {event.shortSha}
            </span>
            {" · "}
            <span style={{ color: COLORS.textPrimary }}>{event.subject}</span>
            {event.forcePushed ? (
              <span
                style={{ color: COLORS.warning, marginLeft: 6, fontFamily: MONO_FONT }}
              >
                force-pushed
              </span>
            ) : null}
          </span>
          <Timestamp ts={event.timestamp} />
        </InlineRow>
      );
    case "review":
      if (event.isBot) {
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
          state={event.state}
          body={event.body}
          timestamp={event.timestamp}
          repoOwner={repoOwner}
          repoName={repoName}
          near={near}
        />
      );
    case "review_thread":
      return near ? (
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
      ) : (
        <BodySkeleton height={140} />
      );
    case "issue_comment":
      return (
        <Card
          icon={event.isBot ? <Robot size={12} weight="bold" /> : <ChatCircle size={12} weight="regular" />}
          author={event.author}
          ts={event.timestamp}
        >
          {near && event.body ? (
            <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
              {event.body}
            </PrMarkdown>
          ) : (
            <BodySkeleton />
          )}
        </Card>
      );
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
      return (
        <InlineRow icon={<GitMerge size={12} weight="fill" />}>
          <span style={{ color: COLORS.textPrimary }}>
            Merged
            {event.mergeCommitSha ? (
              <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, marginLeft: 6 }}>
                {event.mergeCommitSha.slice(0, 7)}
              </span>
            ) : null}
            {event.method ? (
              <span style={{ color: COLORS.textMuted, marginLeft: 6 }}>· {event.method}</span>
            ) : null}
          </span>
          <Timestamp ts={event.timestamp} />
        </InlineRow>
      );
    default:
      return null;
  }
}

/* ══════════════════ Small building blocks ══════════════════ */

function Card({
  icon,
  author,
  ts,
  children,
}: {
  icon: ReactNode;
  author: string | null;
  ts: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2.5"
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
        <span style={{ color: COLORS.textMuted }}>{icon}</span>
        <span style={{ color: COLORS.textPrimary }}>{author ?? "unknown"}</span>
        <Timestamp ts={ts} />
      </div>
      <div>{children}</div>
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

function PrReviewCard({
  author,
  state,
  body,
  timestamp,
  repoOwner,
  repoName,
  near,
}: {
  author: string | null;
  state: string;
  body: string | null;
  timestamp: string;
  repoOwner: string;
  repoName: string;
  near: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2.5"
      style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
      data-testid="pr-timeline-review-card"
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <CheckCircle size={12} weight="bold" style={{ color: reviewStateColor(state) }} />
        <span style={{ color: COLORS.textPrimary }}>{author ?? "reviewer"}</span>
        <span style={{ color: reviewStateColor(state) }}>· {reviewStateLabel(state)}</span>
        <Timestamp ts={timestamp} />
      </div>
      {body ? (
        near ? (
          <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
            {body}
          </PrMarkdown>
        ) : (
          <BodySkeleton />
        )
      ) : null}
    </div>
  );
}

function CheckIconForConclusion({
  conclusion,
  status,
}: {
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  status: "queued" | "in_progress" | "completed";
}) {
  if (status !== "completed") {
    return <Clock size={12} weight="bold" style={{ color: COLORS.warning }} />;
  }
  if (conclusion === "success") {
    return <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} />;
  }
  if (conclusion === "failure" || conclusion === "cancelled") {
    return <WarningCircle size={12} weight="fill" style={{ color: COLORS.danger }} />;
  }
  return <Clock size={12} weight="bold" style={{ color: COLORS.textMuted }} />;
}

function checkConclusionColor(
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null,
  status: "queued" | "in_progress" | "completed",
): string {
  if (status !== "completed") return COLORS.warning;
  if (conclusion === "success") return COLORS.success;
  if (conclusion === "failure" || conclusion === "cancelled") return COLORS.danger;
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
  return {
    id: event.threadId,
    isResolved: event.isResolved,
    isOutdated: event.isOutdated,
    path: event.path,
    line: event.line,
    originalLine: null,
    startLine: event.startLine,
    originalStartLine: null,
    diffSide: null,
    url: null,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    comments: event.firstCommentBody
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
