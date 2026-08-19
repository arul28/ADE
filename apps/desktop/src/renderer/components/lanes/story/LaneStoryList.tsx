/**
 * Lane story — List view.
 *
 * One row per lane: index, name + branch, a compact spine of the lane's recent
 * milestones, the agents that are live in it right now, and its PR chips.
 * Clicking a row selects the lane and switches to the Timeline.
 */

import React, { memo, useMemo } from "react";
import { GitBranch, Signpost } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneEventsSummary } from "../../../../shared/types/laneEvents";
import { COLORS, MONO_FONT, SANS_FONT } from "../laneDesignTokens";
import type { LaneTabPrTag } from "../lanePageModel";
import { useLaneAgents, type LaneAgent, type LaneAgentActivity } from "../laneAgents";
import { StoryAvatar, StoryPrChips, StoryStatusDot, type StoryStatusTone } from "./LaneStoryVisuals";
import { actorColor, formatRelativeTime } from "./laneStoryModel";

const ACTIVITY_TONE: Record<LaneAgentActivity, StoryStatusTone> = {
  working: "working",
  monitoring: "working",
  "awaiting-input": "awaiting",
  idle: "idle",
  ended: "ended",
};

const ACTIVITY_HINT: Record<LaneAgentActivity, string> = {
  working: "working",
  monitoring: "monitoring",
  "awaiting-input": "needs you",
  idle: "idle",
  ended: "ended",
};

/** A 20-dot sparkline of the lane's most recent milestones. */
const CompactSpine = memo(function CompactSpine({ summary }: { summary: LaneEventsSummary | null }) {
  const dots = useMemo(() => (summary?.spine ?? []).slice(-20), [summary]);
  const width = 168;
  const height = 18;
  if (!dots.length) {
    return (
      <svg width={width} height={height} role="img" aria-label="No story yet">
        <line x1={2} y1={height / 2} x2={width - 2} y2={height / 2} stroke={COLORS.border} strokeWidth={1} strokeDasharray="2 3" />
      </svg>
    );
  }
  const step = dots.length > 1 ? (width - 12) / (dots.length - 1) : 0;
  return (
    <svg width={width} height={height} role="img" aria-label={`${summary?.eventCount ?? 0} events`}>
      <line x1={6} y1={height / 2} x2={6 + step * (dots.length - 1)} y2={height / 2} stroke={COLORS.border} strokeWidth={1} />
      {dots.map((entry, index) => (
        <circle
          key={`${entry.kind}:${entry.ts}:${index}`}
          cx={6 + step * index}
          cy={height / 2}
          r={entry.kind === "pr_merged" ? 4 : 3}
          // Exactly the colour the timeline would paint the same event.
          fill={actorColor({ kind: entry.actorKind, provider: entry.provider }, entry.kind)}
          opacity={0.35 + (0.65 * (index + 1)) / dots.length}
        />
      ))}
    </svg>
  );
});

const AgentPips = memo(function AgentPips({
  agents,
  humanAvatarUrl,
}: {
  agents: readonly LaneAgent[];
  humanAvatarUrl: string | null;
}) {
  const shown = agents.slice(0, 3);
  if (!shown.length) {
    return <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>no agent</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      {shown.map((agent) => {
        const provider = agent.providerLabel.toLowerCase();
        return (
          <span key={agent.sessionId} style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            <StoryAvatar
              actor={{ kind: "agent", provider, login: null }}
              humanAvatarUrl={humanAvatarUrl}
              size={18}
              title={`${agent.providerLabel} — ${agent.name}`}
            />
            <StoryStatusDot tone={ACTIVITY_TONE[agent.activity]} />
            <span
              style={{
                fontSize: 10,
                fontFamily: SANS_FONT,
                color: agent.activity === "awaiting-input" ? COLORS.warning : COLORS.textMuted,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 132,
              }}
              title={agent.lastHint ?? undefined}
            >
              {agent.lastHint?.trim() || ACTIVITY_HINT[agent.activity]}
            </span>
          </span>
        );
      })}
      {agents.length > shown.length ? (
        <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>+{agents.length - shown.length}</span>
      ) : null}
    </span>
  );
});

export type LaneStoryListProps = {
  lanes: readonly LaneSummary[];
  summaries: ReadonlyMap<string, LaneEventsSummary>;
  lanePrTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  selectedLaneId: string | null;
  humanAvatarUrl: string | null;
  onOpenLane: (laneId: string) => void;
  onOpenPr?: (pr: LaneTabPrTag) => void;
};

export function LaneStoryList({
  lanes,
  summaries,
  lanePrTagsByLaneId,
  selectedLaneId,
  humanAvatarUrl,
  onOpenLane,
  onOpenPr,
}: LaneStoryListProps) {
  const laneIds = useMemo(() => lanes.map((lane) => lane.id), [lanes]);
  const agentsByLaneId = useLaneAgents(laneIds);

  if (!lanes.length) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
        No lanes match the current filter.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="lane-story-list">
      <div style={{ display: "flex", flexDirection: "column" }}>
        {lanes.map((lane, index) => {
          const summary = summaries.get(lane.id) ?? null;
          const prs = lanePrTagsByLaneId.get(lane.id) ?? [];
          const agents = agentsByLaneId.get(lane.id) ?? [];
          const selected = lane.id === selectedLaneId;
          return (
            <div
              key={lane.id}
              role="button"
              tabIndex={0}
              data-testid={`lane-story-row-${lane.id}`}
              onClick={() => onOpenLane(lane.id)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                  keyEvent.preventDefault();
                  onOpenLane(lane.id);
                }
              }}
              className="ade-lane-story-row"
              style={{
                display: "grid",
                gridTemplateColumns: "34px minmax(180px, 1.2fr) 176px minmax(160px, 1.4fr) auto",
                alignItems: "center",
                gap: 14,
                padding: "10px 16px",
                textAlign: "left",
                background: selected ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "transparent",
                borderBottom: `1px solid ${COLORS.borderMuted}`,
                borderLeft: `2px solid ${selected ? COLORS.accent : "transparent"}`,
                cursor: "pointer",
              }}
            >
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, color: COLORS.textDim }}>
                {String(index + 1).padStart(2, "0")}
              </span>

              <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <Signpost size={13} weight="bold" color={lane.color ?? COLORS.accent} />
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      fontWeight: 600,
                      color: COLORS.textPrimary,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {lane.name}
                  </span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <GitBranch size={10} color={COLORS.textDim} />
                  <span
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 10,
                      color: COLORS.textMuted,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {lane.branchRef}
                  </span>
                </span>
              </span>

              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <CompactSpine summary={summary} />
              </span>

              <AgentPips agents={agents} humanAvatarUrl={humanAvatarUrl} />

              <span style={{ display: "inline-flex", alignItems: "center", gap: 10, justifySelf: "end" }}>
                {summary?.lastEventTs ? (
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, whiteSpace: "nowrap" }}>
                    {formatRelativeTime(summary.lastEventTs)}
                  </span>
                ) : null}
                <StoryPrChips prs={prs} onOpen={onOpenPr} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
