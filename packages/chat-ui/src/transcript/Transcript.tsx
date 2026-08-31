/**
 * The scrolling transcript.
 *
 * Scroll behaviour: pinned to the bottom while the user is at the bottom, and
 * released the moment they scroll up. That release is deliberate — an
 * auto-scroll that fights the reader is the single most common complaint about
 * embedded chat, so once escaped it stays escaped until they return to the
 * bottom themselves.
 *
 * v1 uses plain overflow scroll, not virtualization. Row counts here are
 * bounded by the host's `history()` window.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ActivityLabelConfig } from "../activity/labels";
import { resolveActivityLabel, DEFAULT_THINKING_LABEL } from "../activity/labels";
import type { ThreadStatus } from "../sdkTypes";
import { renderMarkdown as defaultRenderMarkdown } from "./markdown";
import { ToolChip } from "./ToolChip";
import type { TranscriptRow } from "./transcriptRows";

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
  /** Shown when there are no rows. */
  emptyState?: ReactNode;
  className?: string;
};

const BOTTOM_THRESHOLD_PX = 32;

export function Transcript({
  rows,
  status = "idle",
  labels,
  hideToolCalls = false,
  hideReasoning = false,
  expandReasoning = false,
  renderMarkdown = defaultRenderMarkdown,
  emptyState,
  className,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedRef.current = distance <= BOTTOM_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [rows, status]);

  const visible = rows.filter((row) => {
    if (hideToolCalls && row.event.type === "tool_chip") return false;
    if (hideReasoning && row.event.type === "reasoning") return false;
    // Status rows are consumed by the live indicator, never drawn as cards.
    return row.event.type !== "status";
  });

  const showActivity =
    status === "running"
    && (visible.length === 0 || visible[visible.length - 1]!.event.type !== "tool_chip");

  return (
    <div
      ref={scrollRef}
      className={["adechat-transcript", className].filter(Boolean).join(" ")}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {visible.length === 0 && !showActivity ? (
        <div className="adechat-transcript-empty">{emptyState ?? "No messages yet."}</div>
      ) : null}

      {visible.map((row) => (
        <TranscriptRowView
          key={row.key}
          row={row}
          {...(labels ? { labels } : {})}
          expandReasoning={expandReasoning}
          renderMarkdown={renderMarkdown}
        />
      ))}

      {showActivity ? <ActivityIndicator labels={labels} /> : null}
    </div>
  );
}

function TranscriptRowView({
  row,
  labels,
  expandReasoning,
  renderMarkdown,
}: {
  row: TranscriptRow;
  labels?: ActivityLabelConfig | undefined;
  expandReasoning: boolean;
  renderMarkdown: (text: string) => ReactNode;
}) {
  const event = row.event;

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
    return (
      <div className="adechat-row">
        <ToolChip
          chip={event}
          {...(labels ? { labels } : {})}
          startedAt={Date.parse(row.timestamp) || undefined}
        />
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
}

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
export function ActivityIndicator({ labels }: { labels?: ActivityLabelConfig | undefined }) {
  const [dots, setDots] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setDots((value) => (value + 1) % 4), 450);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const label =
    resolveActivityLabel({ kind: "thinking", tool: null, phase: "running", event: null }, labels)
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
