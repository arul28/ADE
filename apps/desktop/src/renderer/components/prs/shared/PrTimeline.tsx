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
  GitPullRequest,
  Package,
  Tag,
  GitMerge,
  XCircle,
  FileDashed,
  ArrowBendUpRight,
  Pencil,
  GitBranch,
  UserPlus,
  UserMinus,
} from "@phosphor-icons/react";

import type {
  PrTimelineEvent,
  PrDeploymentState,
  PrReview,
  PrReviewThread,
} from "../../../../shared/types/prs";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import { PrMarkdown } from "./PrMarkdown";
import { PrReviewThreadCard } from "./PrReviewThreadCard";
import { DescriptionContent, IssueCommentContent } from "./PrTimelineCommentCards";
import { PrBotReviewCard } from "./PrBotReviewCard";
import { PrUserAvatar } from "./PrUserAvatar";
import { BotGroupRow, DigestRowShell, NeedsAttentionBlock, PushDivider, reviewStateIcon } from "./PrTimelineDigestRows";
import type { PrNeedsAttentionItem } from "../../../../shared/prConversationDigest";
import type { DigestTimelineModel } from "./prDigestTimelineModel";

/* ══════════════════ Types ══════════════════ */

export type PrTimelineProps = {
  events: PrTimelineEvent[];
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  writeViewerLogin?: string | null;
  /** Fired (debounced) with the id of the top-most visible event as the user scrolls. */
  onVisibleEventChange?: (eventId: string | null) => void;
  /**
   * Triage layout (the Overview): pinned Needs-attention, one section per push,
   * one folded row per bot. The thread renders these items, not `events`.
   */
  digest: DigestTimelineModel;
  /** "Fix in chat" on a Needs-attention row. Omitted hides the button. */
  onFixInChat?: (item: PrNeedsAttentionItem) => void;
  /** Bottom padding so floating controls never cover the last row. */
  bottomInset?: number;
};

export type PrTimelineRef = {
  scrollToEventId: (id: string) => void;
  focusEvent: (id: string) => void;
  nextUnresolved: () => void;
  prevUnresolved: () => void;
};

/* ══════════════════ Unresolved threads ══════════════════ */

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

export const PrTimeline = forwardRef<PrTimelineRef, PrTimelineProps>(function PrTimeline(
  {
    events,
    prId,
    laneId,
    repoOwner,
    repoName,
    viewerLogin,
    writeViewerLogin,
    onVisibleEventChange,
    digest,
    onFixInChat,
    bottomInset = 0,
  },
  ref,
) {
  const mutationViewerLogin = writeViewerLogin !== undefined ? writeViewerLogin : viewerLogin;

  const renderItems = digest.items;

  const unresolvedIds = useMemo(() => collectUnresolvedThreadIds(events), [events]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback((index: number) => renderItems[index]?.id ?? index, [renderItems]);
  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => parentRef.current,
    getItemKey,
    estimateSize: () => 120,
    overscan: 4,
  });

  // Map every event id (and the ids folded into a push or bot row) to its index
  // in `renderItems`. The virtualizer counts renderItems, not events.
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    renderItems.forEach((item, idx) => {
      map.set(item.id, idx);
      if (item.kind === "event") {
        map.set(item.event.id, idx);
      } else if (item.kind === "push") {
        map.set(item.push.id, idx);
        for (const c of item.commits) map.set(c.id, idx);
      } else if (item.kind === "bot-group") {
        for (const e of item.events) map.set(e.id, idx);
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
      <div
        ref={parentRef}
        data-testid="pr-timeline-viewport"
        className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {renderItems.length === 0 ? (
          <div
            className="py-8 text-center text-[12px]"
            style={{ color: COLORS.textDim }}
          >
            No activity yet.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = renderItems[virtualRow.index]!;
              if (item.kind === "attention") {
                return (
                  <DigestRowShell key={item.id} index={virtualRow.index} start={virtualRow.start} measure={virtualizer.measureElement}>
                    <NeedsAttentionBlock item={item} onOpen={focusEvent} onFixInChat={onFixInChat} />
                  </DigestRowShell>
                );
              }
              if (item.kind === "push") {
                return (
                  <DigestRowShell key={item.id} index={virtualRow.index} start={virtualRow.start} measure={virtualizer.measureElement} dataAttr="push">
                    <PushDivider item={item} repoOwner={repoOwner} repoName={repoName} />
                  </DigestRowShell>
                );
              }
              if (item.kind === "bot-group") {
                return (
                  <DigestRowShell key={item.id} index={virtualRow.index} start={virtualRow.start} measure={virtualizer.measureElement} dataAttr="bot-group">
                    <BotGroupRow
                      item={item}
                      focusedEventId={focusedEventId}
                      onFocus={setFocusedEventId}
                      renderEntry={(event) => (
                        <TimelineRowContent
                          event={event}
                          near
                          focused={focusedEventId === event.id}
                          prId={prId}
                          laneId={laneId}
                          repoOwner={repoOwner}
                          repoName={repoName}
                          viewerLogin={mutationViewerLogin}
                          onFocus={setFocusedEventId}
                        />
                      )}
                    />
                  </DigestRowShell>
                );
              }
              return (
                <TimelineRow
                  key={item.id}
                  event={item.event}
                  index={virtualRow.index}
                  start={virtualRow.start}
                  measure={virtualizer.measureElement}
                  parentRef={parentRef}
                  focusedEventId={focusedEventId}
                  prId={prId}
                  laneId={laneId}
                  repoOwner={repoOwner}
                  repoName={repoName}
                  viewerLogin={mutationViewerLogin}
                  onFocus={setFocusedEventId}
                />
              );
            })}
          </div>
        )}
        {bottomInset > 0 ? <div aria-hidden style={{ height: bottomInset }} /> : null}
      </div>
    </div>
  );
});

export default PrTimeline;

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

// Color mirroring a referenced PR/issue's state (used by cross_reference).
function crossRefColor(state: "open" | "closed" | "merged" | "draft"): string {
  if (state === "merged") return COLORS.accent;
  if (state === "closed") return COLORS.danger;
  if (state === "open") return COLORS.success;
  return COLORS.textMuted;
}

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
    // The digest model never emits pr_opened, commit_push, or check_update as
    // rows: pushes are section dividers, and checks live in the Merge card and
    // the Checks tab.
    case "description":
      return near ? (
        <DescriptionContent
          event={event}
          prId={prId}
          viewerLogin={viewerLogin}
          repoOwner={repoOwner}
          repoName={repoName}
          plain
        />
      ) : (
        <BodySkeleton />
      );
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
      return near ? (
        <IssueCommentContent
          event={event}
          prId={prId}
          viewerLogin={viewerLogin}
          repoOwner={repoOwner}
          repoName={repoName}
        />
      ) : (
        <BodySkeleton />
      );
    }
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

function lifecycleVisual(state: Extract<PrTimelineEvent, { type: "lifecycle" }>["state"]): { icon: ReactNode; color: string } {
  if (state === "closed") return { icon: <XCircle size={13} weight="fill" />, color: COLORS.danger };
  if (state === "converted_to_draft") return { icon: <FileDashed size={13} weight="bold" />, color: COLORS.textMuted };
  // reopened / ready_for_review
  return { icon: <GitPullRequest size={13} weight="bold" />, color: COLORS.success };
}

function LifecycleRow({ event }: { event: Extract<PrTimelineEvent, { type: "lifecycle" }> }) {
  const visual = lifecycleVisual(event.state);
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

// Past-tense summary used for the compact (bodyless) review row, matching
// GitHub's "X approved these changes" / "X reviewed" timeline lines.
function reviewActionLabel(state: string): string {
  if (state === "approved") return "approved these changes";
  if (state === "changes_requested") return "requested changes";
  if (state === "dismissed") return "dismissed their review";
  return "reviewed";
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
    reviewerIsBot: event.isBot,
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
