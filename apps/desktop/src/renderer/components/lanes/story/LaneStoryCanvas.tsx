/**
 * The Lane story canvas: horizontal spines, event nodes, staggered cards,
 * session swimlanes and the live tail.
 *
 * Perf shape (see .agents/skills/ade-perf-lanes): the canvas holds no
 * per-frame React state. Scrolling is native (a wheel handler maps vertical
 * delta to `scrollLeft`), the scrubber writes its thumb position through a ref
 * inside a rAF, and only a click — selecting a node or expanding a fold —
 * re-renders.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, FileCode, GitBranch, ChatText } from "@phosphor-icons/react";
import type { LaneEvent, LaneEventsChat } from "../../../../shared/types/laneEvents";
import type { CommitPayload, PrPayload } from "../../../../shared/types/laneEvents";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../laneDesignTokens";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { StoryAvatar, StoryLegend, StoryNodeGlyph, StoryStatusDot } from "./LaneStoryVisuals";
import { LaneStoryScrubber } from "./LaneStoryScrubber";
import {
  CANVAS_PADDING_X,
  CARD_EXPANDED_WIDTH,
  CARD_HEIGHT,
  CARD_OFFSET,
  CARD_WIDTH,
  FIRST_ROW_Y,
  PR_EVENT_KINDS,
  SWIMLANE_HEIGHT,
  actorLabel,
  eventMessage,
  eventStat,
  eventTitle,
  formatClockTime,
  storyProviderColor,
  type HeatStrip,
  type LaneStoryLayout,
  type StoryNode,
} from "./laneStoryModel";

export type LaneStoryCanvasProps = {
  layout: LaneStoryLayout;
  heat: HeatStrip;
  humanAvatarUrl: string | null;
  /** Live chat state for the branch tails (live session state wins over events). */
  tailChats: readonly LaneEventsChat[];
  /** Reset scroll to the right edge whenever this changes (i.e. the lane opened). */
  settleKey: string;
  unfoldedIds: ReadonlySet<string>;
  onToggleFold: (foldId: string) => void;
  onOpenChat?: (chatSessionId: string) => void;
  onOpenDiff?: (event: LaneEvent) => void;
  onOpenPr?: (prNumber: number) => void;
};

export function LaneStoryCanvas({
  layout,
  heat,
  humanAvatarUrl,
  tailChats,
  settleKey,
  unfoldedIds,
  onToggleFold,
  onOpenChat,
  onOpenDiff,
  onOpenPr,
}: LaneStoryCanvasProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Opening a lane should land on the newest end of its story, not its origin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setSelectedNodeId(null);
  }, [settleKey, layout.width]);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
  }, []);

  const rowsByIndex = useMemo(() => new Map(layout.rows.map((row) => [row.index, row] as const)), [layout.rows]);
  const lastRow = layout.rows[layout.rows.length - 1] ?? null;
  const liveChat = useMemo(() => (
    tailChats.find((chat) => chat.status === "running")
    ?? tailChats.find((chat) => chat.status === "awaiting-input")
    ?? tailChats.find((chat) => chat.status === "idle")
    ?? tailChats[tailChats.length - 1]
    ?? null
  ), [tailChats]);

  return (
    <div className="relative flex-1 min-h-0">
      <div className="ade-lane-story-bg" aria-hidden />
      <div
        ref={scrollRef}
        data-testid="lane-story-canvas"
        className="ade-lane-story-scroll relative h-full w-full overflow-x-auto overflow-y-auto"
        onWheel={onWheel}
        onClick={() => setSelectedNodeId(null)}
      >
        <div style={{ position: "relative", width: layout.width, height: layout.height, minWidth: "100%" }}>
          <svg
            width={layout.width}
            height={layout.height}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            aria-hidden
          >
            {/* Branch spines */}
            {layout.rows.map((row) => (
              <g key={`row:${row.index}`}>
                <line
                  x1={row.startX - 28}
                  y1={row.y}
                  x2={row.endX + 28}
                  y2={row.y}
                  stroke={row.index === 0 ? "color-mix(in srgb, var(--color-fg) 18%, transparent)" : "color-mix(in srgb, var(--color-accent) 34%, transparent)"}
                  strokeWidth={row.index === 0 ? 1.5 : 1.25}
                />
                {row.forkFromRowIndex != null && row.forkX != null ? (
                  <path
                    d={forkPath(row.forkX, rowsByIndex.get(row.forkFromRowIndex)?.y ?? FIRST_ROW_Y, row.startX - 28, row.y)}
                    fill="none"
                    stroke="color-mix(in srgb, var(--color-accent) 42%, transparent)"
                    strokeWidth={1.25}
                  />
                ) : null}
              </g>
            ))}

            {/* Review → next-commit causality */}
            {layout.arcs.map((arc) => {
              const y = rowsByIndex.get(arc.rowIndex)?.y ?? FIRST_ROW_Y;
              const mid = (arc.fromX + arc.toX) / 2;
              return (
                <path
                  key={arc.id}
                  d={`M ${arc.fromX} ${y + 6} Q ${mid} ${y + 42} ${arc.toX} ${y + 6}`}
                  fill="none"
                  stroke="var(--color-info)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.55}
                />
              );
            })}

            {/* Session swimlanes */}
            {layout.swimlanes.map((lane) => (
              <rect
                key={`swim:${lane.chatSessionId}`}
                x={lane.startX}
                y={lane.y}
                width={Math.max(56, lane.endX - lane.startX)}
                height={SWIMLANE_HEIGHT}
                rx={8}
                fill={`color-mix(in srgb, ${lane.color} 12%, transparent)`}
                stroke={`color-mix(in srgb, ${lane.color} 26%, transparent)`}
                strokeWidth={1}
              />
            ))}
          </svg>

          {/* Branch labels */}
          {layout.rows.map((row) => (
            <div
              key={`label:${row.index}`}
              style={{
                position: "absolute",
                left: 12,
                top: row.y - 9,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                maxWidth: CANVAS_PADDING_X - 20,
              }}
            >
              <GitBranch size={11} color={COLORS.textDim} />
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textMuted,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={row.branchRef}
              >
                {row.branchRef || "—"}
              </span>
            </div>
          ))}

          {/* Gap markers */}
          {layout.gaps.map((gap) => (
            <div
              key={gap.id}
              style={{
                position: "absolute",
                left: gap.x - 18,
                top: (rowsByIndex.get(gap.rowIndex)?.y ?? FIRST_ROW_Y) - 9,
                width: 36,
                textAlign: "center",
                fontFamily: MONO_FONT,
                fontSize: 9,
                color: COLORS.textDim,
                background: COLORS.pageBg,
                borderRadius: 4,
                padding: "1px 0",
              }}
              title={`${gap.label} with no activity`}
            >
              · {gap.label} ·
            </div>
          ))}

          {/* Swimlane labels */}
          {layout.swimlanes.map((lane) => (
            <div
              key={`swimlabel:${lane.chatSessionId}`}
              style={{
                position: "absolute",
                left: lane.startX + 8,
                top: lane.y + 6,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                maxWidth: Math.max(64, lane.endX - lane.startX - 16),
              }}
            >
              {lane.chat.provider ? <ProviderLogo family={lane.chat.provider} size={16} /> : null}
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 10,
                  color: COLORS.textMuted,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {lane.chat.title?.trim() || lane.chat.model || lane.chat.provider || "session"}
              </span>
            </div>
          ))}

          {/* Nodes + cards */}
          {layout.nodes.map((node) => {
            const row = rowsByIndex.get(node.rowIndex);
            const y = row?.y ?? FIRST_ROW_Y;
            const expanded = selectedNodeId === node.id;
            return (
              <StoryNodeView
                key={node.id}
                node={node}
                y={y}
                expanded={expanded}
                humanAvatarUrl={humanAvatarUrl}
                unfolded={unfoldedIds.has(node.id)}
                onSelect={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
                onToggleFold={onToggleFold}
                onOpenChat={onOpenChat}
                onOpenDiff={onOpenDiff}
                onOpenPr={onOpenPr}
              />
            );
          })}

          {/* Live tail at the tip of the story */}
          {lastRow ? (
            <StoryTail
              x={lastRow.endX + 56}
              y={lastRow.y}
              chat={liveChat}
              terminal={lastRow.terminal}
            />
          ) : null}
        </div>
      </div>

      <StoryLegend />
      <LaneStoryScrubber heat={heat} scrollRef={scrollRef} />
    </div>
  );
}

function forkPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const midX = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${fromX} ${toY}, ${toX} ${toY}`;
}

/* ------------------------------------------------------------------ *
 * One node + its card
 * ------------------------------------------------------------------ */

const StoryNodeView = memo(function StoryNodeView({
  node,
  y,
  expanded,
  humanAvatarUrl,
  unfolded,
  onSelect,
  onToggleFold,
  onOpenChat,
  onOpenDiff,
  onOpenPr,
}: {
  node: StoryNode;
  y: number;
  expanded: boolean;
  humanAvatarUrl: string | null;
  unfolded: boolean;
  onSelect: (id: string) => void;
  onToggleFold: (foldId: string) => void;
  onOpenChat?: (chatSessionId: string) => void;
  onOpenDiff?: (event: LaneEvent) => void;
  onOpenPr?: (prNumber: number) => void;
}) {
  const stop = (event: React.MouseEvent) => event.stopPropagation();

  if (node.type === "fold") {
    const count = node.events.length;
    return (
      <button
        type="button"
        data-testid={`lane-story-fold-${node.id}`}
        onClick={(event) => {
          stop(event);
          onToggleFold(node.id);
        }}
        style={{
          position: "absolute",
          left: node.x - 52,
          top: y - 13,
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          borderRadius: 13,
          background: `color-mix(in srgb, ${node.color} 14%, ${COLORS.pageBg})`,
          border: `1px solid color-mix(in srgb, ${node.color} 40%, transparent)`,
          color: node.color,
          fontFamily: MONO_FONT,
          fontSize: 10,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        title={unfolded ? "Collapse this run" : `Expand ${count} commits`}
      >
        <StoryAvatar actor={node.actor} size={14} humanAvatarUrl={humanAvatarUrl} />
        {count} commits
      </button>
    );
  }

  const event = node.event;
  const above = node.side === "above";
  const cardWidth = expanded ? CARD_EXPANDED_WIDTH : CARD_WIDTH;
  const cardTop = above ? y - CARD_OFFSET - CARD_HEIGHT : y + CARD_OFFSET;
  const title = eventTitle(event);
  const message = eventMessage(event);
  const stat = eventStat(event);
  const prNumber = (event.payload as PrPayload).githubPrNumber;
  const chatSessionId = event.actor.chatSessionId ?? null;

  return (
    <>
      {/* Connector */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: node.x,
          top: above ? cardTop + CARD_HEIGHT : y + 6,
          width: 0,
          height: Math.max(0, CARD_OFFSET - 6),
          borderLeft: `1px dashed color-mix(in srgb, ${node.color} 45%, transparent)`,
        }}
      />
      <button
        type="button"
        data-testid={`lane-story-node-${event.id}`}
        aria-label={title}
        onClick={(clickEvent) => {
          stop(clickEvent);
          onSelect(node.id);
        }}
        style={{
          position: "absolute",
          left: node.x - 12,
          top: y - 12,
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          zIndex: expanded ? 30 : 10,
        }}
      >
        <StoryNodeGlyph event={event} color={node.color} humanAvatarUrl={humanAvatarUrl} />
      </button>

      <div
        data-testid={`lane-story-card-${event.id}`}
        role="button"
        tabIndex={0}
        onClick={(clickEvent) => {
          stop(clickEvent);
          onSelect(node.id);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            onSelect(node.id);
          }
        }}
        className="ade-glass-card ade-lane-story-card"
        style={{
          position: "absolute",
          left: node.x - cardWidth / 2,
          top: cardTop,
          width: cardWidth,
          padding: 10,
          cursor: "pointer",
          zIndex: expanded ? 40 : 20,
          boxShadow: expanded ? `0 0 0 1px ${COLORS.accent}, var(--shadow-card-hover)` : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StoryAvatar actor={event.actor} size={16} humanAvatarUrl={humanAvatarUrl} />
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: node.color,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
            }}
          >
            {title}
          </span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>
            {formatClockTime(event.ts)}
          </span>
        </div>

        {message ? (
          <div
            className="ade-lane-story-card-message"
            style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, marginTop: 6 }}
          >
            {message}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: node.color, opacity: 0.9, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {actorLabel(event.actor)}
          </span>
          {stat ? (
            <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>{stat}</span>
          ) : null}
        </div>

        {expanded ? (
          <div style={{ marginTop: 10, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 8 }}>
            {detailRows(event).map((row) => (
              <div key={row.label} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim, width: 74, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {row.label}
                </span>
                <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textSecondary, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.value}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {chatSessionId && onOpenChat ? (
                <button
                  type="button"
                  style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                  onClick={(clickEvent) => {
                    stop(clickEvent);
                    onOpenChat(chatSessionId);
                  }}
                >
                  <ChatText size={11} /> Jump to chat
                </button>
              ) : null}
              {event.kind === "commit" && onOpenDiff ? (
                <button
                  type="button"
                  style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                  onClick={(clickEvent) => {
                    stop(clickEvent);
                    onOpenDiff(event);
                  }}
                >
                  <FileCode size={11} /> View diff
                </button>
              ) : null}
              {prNumber && onOpenPr ? (
                <button
                  type="button"
                  style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                  onClick={(clickEvent) => {
                    stop(clickEvent);
                    onOpenPr(prNumber);
                  }}
                >
                  <ArrowSquareOut size={11} /> Open in PRs
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
});

function detailRows(event: LaneEvent): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (event.kind === "commit") {
    const payload = event.payload as CommitPayload;
    const changes = [
      payload.filesChanged != null ? `${payload.filesChanged} files` : null,
      payload.insertions != null ? `+${payload.insertions}` : null,
      payload.deletions != null ? `−${payload.deletions}` : null,
    ].filter(Boolean).join(" ");
    if (changes) rows.push({ label: "Changes", value: changes });
    if (payload.authorName) rows.push({ label: "Author", value: payload.authorName });
    if (event.actor.chatSessionId) rows.push({ label: "Chat", value: event.actor.chatSessionId.slice(0, 12) });
    rows.push({ label: "When", value: new Date(event.ts).toLocaleString() });
    if (event.actor.attribution) rows.push({ label: "Source", value: event.actor.attribution });
    return rows;
  }
  if (PR_EVENT_KINDS.has(event.kind)) {
    const payload = event.payload as PrPayload;
    if (payload.title) rows.push({ label: "Title", value: payload.title });
    if (payload.checksStatus) rows.push({ label: "Checks", value: payload.checksStatus });
    if (payload.reviewStatus) rows.push({ label: "Reviewed", value: payload.reviewStatus });
    if (payload.mergedByLogin) rows.push({ label: "Merged by", value: payload.mergedByLogin });
    rows.push({ label: "When", value: new Date(event.ts).toLocaleString() });
    return rows;
  }
  if (event.kind === "lane_created") {
    const payload = event.payload as { baseRef?: string; branchRef?: string; source?: string };
    if (payload.baseRef) rows.push({ label: "Base", value: payload.baseRef });
    if (payload.branchRef) rows.push({ label: "Branch", value: payload.branchRef });
    if (payload.source) rows.push({ label: "Origin", value: payload.source });
    rows.push({ label: "When", value: new Date(event.ts).toLocaleString() });
    return rows;
  }
  rows.push({ label: "When", value: new Date(event.ts).toLocaleString() });
  return rows;
}

/* ------------------------------------------------------------------ *
 * Live tail
 * ------------------------------------------------------------------ */

function StoryTail({
  x,
  y,
  chat,
  terminal,
}: {
  x: number;
  y: number;
  chat: LaneEventsChat | null;
  terminal: "merged" | "closed" | null;
}) {
  const running = chat?.status === "running";
  const awaiting = chat?.status === "awaiting-input";
  const color = storyProviderColor(chat?.provider) ?? COLORS.textMuted;
  const label = chat
    ? `${chat.provider ? chat.provider : "agent"}${chat.model ? ` · ${chat.model}` : ""}${chat.statusNote ? ` · ${chat.statusNote}` : ` · ${chat.status}`}`
    : terminal
      ? terminal
      : "no agent yet";
  return (
    <div
      data-testid="lane-story-tail"
      style={{ position: "absolute", left: x, top: y - 13, display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}
    >
      {chat ? (
        <span
          className={running ? "ade-status-breathe" : undefined}
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
            boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`,
          }}
        >
          {chat.provider ? <ProviderLogo family={chat.provider} size={16} /> : null}
        </span>
      ) : (
        <StoryStatusDot tone="idle" size={8} />
      )}
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 10,
          color: awaiting ? COLORS.warning : chat && running ? COLORS.textSecondary : COLORS.textDim,
        }}
      >
        {label}
      </span>
    </div>
  );
}
