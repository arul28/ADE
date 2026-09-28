/**
 * The scrolling transcript.
 *
 * Scroll behaviour: pinned to the bottom while the user is at the bottom, and
 * released the moment they scroll up. That release is deliberate — an
 * auto-scroll that fights the reader is the single most common complaint about
 * embedded chat, so once escaped it stays escaped until they return to the
 * bottom themselves.
 *
 * Windowing: past `windowThreshold` rows, only the rows in view plus
 * `overscan` rows either side are mounted, with spacers standing in for the
 * rest (`useWindowedRows`). Where there is no layout to measure every row
 * renders, which is the pre-0.3 behaviour.
 *
 * Paging: with `hasOlder`, a "Load older messages" control sits at the top and
 * scrolling to the top calls `onLoadOlder`; the reader's position is kept when
 * the older rows land above them.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ActivityLabelConfig } from "../activity/labels";
import { resolveActivityLabel, DEFAULT_THINKING_LABEL } from "../activity/labels";
import type { ThreadStatus } from "../sdkTypes";
import { ApprovalCard, type ApprovalRespond, type ApprovalUiOptions } from "./ApprovalCard";
import { renderMarkdown as defaultRenderMarkdown } from "./markdown";
import { ToolChip, type ToolChipAction } from "./ToolChip";
import type { ToolChipRow, TranscriptRow } from "./transcriptRows";
import { RowSlot, useWindowedRows } from "./useWindowedRows";

export type TranscriptProps = {
  rows: readonly TranscriptRow[];
  /** Drives the inline live activity indicator at the tail. */
  status?: ThreadStatus["state"];
  labels?: ActivityLabelConfig;
  /** Hide tool chips entirely. Reasoning and text are unaffected. */
  hideToolCalls?: boolean;
  /** Hide reasoning rows entirely. */
  hideReasoning?: boolean;
  /** Reasoning starts collapsed; set true to start open. */
  expandReasoning?: boolean;
  /** Replace the built-in markdown renderer. */
  renderMarkdown?: (text: string) => ReactNode;
  /**
   * Answer an approval. Omit when the thread has no `approve`: approval cards
   * then render read-only with a line saying why.
   */
  onApprove?: ApprovalRespond;
  /** Custom approval card renderer and button wording. */
  approvals?: ApprovalUiOptions;
  /**
   * Extra content drawn under a tool chip — a preview, a result card, links
   * built from `row.resourceLinks`. Called for every tool chip row, running
   * ones included (check `row.status`); return null to draw nothing. Pure
   * rendering: it runs on every render of that row.
   */
  renderToolResult?: (row: ToolChipRow) => ReactNode;
  /**
   * Buttons on a tool chip (e.g. "Open in Versic" from `row.resourceLinks` or
   * `row.identity`). Called for every tool chip row; return `[]` for none.
   * Labels must be unique within one chip.
   */
  toolChipActions?: (row: ToolChipRow) => readonly ToolChipAction[];
  /** Older history exists (see `ThreadState.hasOlder`). Shows the load control. */
  hasOlder?: boolean;
  /** An older page is loading; the control is disabled meanwhile. */
  loadingOlder?: boolean;
  /**
   * Load the next older page. Called from the top control and when the reader
   * scrolls to the top while `hasOlder` is true and nothing is loading.
   */
  onLoadOlder?: () => void | Promise<void>;
  /**
   * Row count above which only the rows in view (plus `overscan`) are mounted.
   * Default 150. `Infinity` turns windowing off. A row scrolled out of the
   * window unmounts, so its local UI state (an expanded reasoning block or
   * tool chip) resets when it scrolls back in.
   */
  windowThreshold?: number;
  /** Rows mounted beyond each edge of the viewport when windowed. Default 8. */
  overscan?: number;
  /** Shown when there are no rows. */
  emptyState?: ReactNode;
  className?: string;
};

const TOP_LOAD_THRESHOLD_PX = 48;
const DEFAULT_WINDOW_THRESHOLD = 150;
const DEFAULT_OVERSCAN = 8;

/**
 * Replaces the thinking label while an approval sits unanswered at the tail.
 *
 * "Working…" under a card that is waiting on the reader is a lie, and the
 * reason a blocked turn reads as a hung one.
 */
export const DEFAULT_APPROVAL_WAITING_LABEL = "Waiting for your approval…";

export function Transcript({
  rows,
  status = "idle",
  labels,
  hideToolCalls = false,
  hideReasoning = false,
  expandReasoning = false,
  renderMarkdown = defaultRenderMarkdown,
  onApprove,
  approvals,
  renderToolResult,
  toolChipActions,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  windowThreshold = DEFAULT_WINDOW_THRESHOLD,
  overscan = DEFAULT_OVERSCAN,
  emptyState,
  className,
}: TranscriptProps) {
  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (hideToolCalls && row.event.type === "tool_chip") return false;
        if (hideReasoning && row.event.type === "reasoning") return false;
        // Status rows are consumed by the live indicator, never drawn as cards.
        return row.event.type !== "status";
      }),
    [rows, hideToolCalls, hideReasoning],
  );

  const {
    rendered,
    topSpacer,
    bottomSpacer,
    scrollRef,
    pinnedRef,
    onScroll: onWindowScroll,
    observer,
    offsets,
  } = useWindowedRows(visible, { threshold: windowThreshold, overscan });

  const loadOlderRef = useRef<{ hasOlder: boolean; loadingOlder: boolean; onLoadOlder?: () => unknown }>({
    hasOlder,
    loadingOlder,
  });
  loadOlderRef.current = onLoadOlder
    ? { hasOlder, loadingOlder, onLoadOlder }
    : { hasOlder, loadingOlder };

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    onWindowScroll();
    const older = loadOlderRef.current;
    if (
      node.scrollTop <= TOP_LOAD_THRESHOLD_PX
      && older.hasOlder
      && !older.loadingOlder
      && older.onLoadOlder
      // Only a scroll that has somewhere to go: a transcript shorter than its
      // box sits at scrollTop 0 permanently and would page without end.
      && node.scrollHeight > node.clientHeight
    ) {
      void older.onLoadOlder();
    }
  }, [onWindowScroll, scrollRef]);

  // Keep the reader where they were when older rows land above them.
  const firstKeyRef = useRef<string | null>(null);
  const scrollHeightRef = useRef(0);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const firstKey = visible[0]?.key ?? null;
    const prepended =
      firstKeyRef.current !== null
      && firstKey !== firstKeyRef.current
      && visible.some((row, index) => index > 0 && row.key === firstKeyRef.current);
    if (pinnedRef.current) {
      node.scrollTop = node.scrollHeight;
    } else if (prepended) {
      node.scrollTop += node.scrollHeight - scrollHeightRef.current;
    }
    firstKeyRef.current = firstKey;
    scrollHeightRef.current = node.scrollHeight;
  }, [visible, status, offsets, pinnedRef, scrollRef]);

  const tail = visible[visible.length - 1];
  // An unanswered approval is shown as waiting even when the host reports the
  // thread idle: the request is still on screen and still answerable, and
  // silence under it reads as a hang.
  const awaitingApproval = tail?.event.type === "approval" && tail.event.state === "pending";
  const showActivity =
    awaitingApproval
    || (status === "running" && (visible.length === 0 || tail!.event.type !== "tool_chip"));

  return (
    <div
      ref={scrollRef}
      className={["adechat-transcript", className].filter(Boolean).join(" ")}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {hasOlder && onLoadOlder ? (
        <button
          type="button"
          className="adechat-transcript-older"
          onClick={() => void onLoadOlder()}
          disabled={loadingOlder}
        >
          {loadingOlder ? "Loading older messages…" : "Load older messages"}
        </button>
      ) : null}

      {visible.length === 0 && !showActivity ? (
        <div className="adechat-transcript-empty">{emptyState ?? "No messages yet."}</div>
      ) : null}

      {topSpacer > 0 ? (
        <div className="adechat-transcript-spacer" style={{ height: topSpacer }} aria-hidden="true" />
      ) : null}

      {rendered.map((row) => (
        <RowSlot key={row.key} rowKey={row.key} observer={observer}>
          <TranscriptRowView
            row={row}
            {...(labels ? { labels } : {})}
            expandReasoning={expandReasoning}
            renderMarkdown={renderMarkdown}
            {...(onApprove ? { onApprove } : {})}
            {...(approvals ? { approvals } : {})}
            {...(renderToolResult ? { renderToolResult } : {})}
            {...(toolChipActions ? { toolChipActions } : {})}
          />
        </RowSlot>
      ))}

      {bottomSpacer > 0 ? (
        <div className="adechat-transcript-spacer" style={{ height: bottomSpacer }} aria-hidden="true" />
      ) : null}

      {showActivity ? (
        <ActivityIndicator
          labels={labels}
          {...(awaitingApproval ? { label: DEFAULT_APPROVAL_WAITING_LABEL } : {})}
        />
      ) : null}
    </div>
  );
}

/**
 * One row. Memoised: the row builder keeps an unchanged row's object identity,
 * so a streamed delta re-renders the tail row and nothing above it.
 */
const TranscriptRowView = memo(function TranscriptRowView({
  row,
  labels,
  expandReasoning,
  renderMarkdown,
  onApprove,
  approvals,
  renderToolResult,
  toolChipActions,
}: {
  row: TranscriptRow;
  labels?: ActivityLabelConfig | undefined;
  expandReasoning: boolean;
  renderMarkdown: (text: string) => ReactNode;
  onApprove?: ApprovalRespond | undefined;
  approvals?: ApprovalUiOptions | undefined;
  renderToolResult?: ((row: ToolChipRow) => ReactNode) | undefined;
  toolChipActions?: ((row: ToolChipRow) => readonly ToolChipAction[]) | undefined;
}) {
  const event = row.event;

  if (event.type === "approval") {
    return (
      <div className="adechat-row">
        <ApprovalCard
          row={event}
          {...(onApprove ? { onApprove } : {})}
          {...(approvals ? { options: approvals } : {})}
        />
      </div>
    );
  }

  if (event.type === "user_message") {
    const text = event.displayText ?? event.text;
    return (
      <div className="adechat-row adechat-row-user">
        <div className="adechat-bubble-user">{text}</div>
        {event.attachments?.length ? (
          <div className="adechat-attachments">
            {event.attachments.map((attachment) => (
              <span key={attachment.id} className="adechat-attachment">
                {attachment.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (event.type === "text") {
    return (
      <div className="adechat-row">
        <div className="adechat-assistant">{renderMarkdown(event.text)}</div>
      </div>
    );
  }

  if (event.type === "reasoning") {
    return <ReasoningRow text={event.text} defaultExpanded={expandReasoning} />;
  }

  if (event.type === "tool_chip") {
    const actions = toolChipActions?.(event);
    const extra = renderToolResult?.(event);
    return (
      <div className="adechat-row">
        <ToolChip
          chip={event}
          {...(labels ? { labels } : {})}
          {...(actions?.length ? { actions } : {})}
          startedAt={Date.parse(row.timestamp) || undefined}
        />
        {extra !== undefined && extra !== null && extra !== false ? (
          <div className="adechat-tool-result">{extra}</div>
        ) : null}
      </div>
    );
  }

  if (event.type === "error") {
    const label =
      resolveActivityLabel({ kind: "error", tool: null, phase: "error", event }, labels)
      ?? event.message;
    return (
      <div className="adechat-row">
        <div className="adechat-error" role="alert">
          <div className="adechat-error-message">{label}</div>
          {event.detail ? <pre className="adechat-error-detail">{event.detail}</pre> : null}
        </div>
      </div>
    );
  }

  return null;
});

function ReasoningRow({ text, defaultExpanded }: { text: string; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="adechat-row adechat-reasoning">
      <button
        type="button"
        className="adechat-reasoning-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? "Hide reasoning" : "Show reasoning"}
      </button>
      {expanded ? <div className="adechat-reasoning-body">{text}</div> : null}
    </div>
  );
}

/** Inline "the agent is working" line, shown at the tail of a running turn. */
export function ActivityIndicator({
  labels,
  label: labelOverride,
}: {
  labels?: ActivityLabelConfig | undefined;
  /** Replaces the resolved label outright (the approval wait uses this). */
  label?: string | undefined;
}) {
  const [dots, setDots] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setDots((value) => (value + 1) % 4), 450);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const label =
    labelOverride
    ?? resolveActivityLabel({ kind: "thinking", tool: null, phase: "running", event: null }, labels)
    ?? DEFAULT_THINKING_LABEL;

  return (
    <div className="adechat-activity" role="status">
      <span className="adechat-activity-dot" aria-hidden="true" />
      <span>
        {label}
        {reducedMotion ? "" : ".".repeat(dots)}
      </span>
    </div>
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Safari < 14 only has the deprecated listener API.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);
  return reduced;
}
