/**
 * Lane story — Timeline view.
 *
 * Header row 1 is the lane's identity (name, branch, PR chips); row 2 is the
 * controls: story filters on the left, the git readout + Pull/Push/Git ▾ on the
 * right. Under them sits the deterministic summary sentence, then the canvas.
 *
 * `Git ▾` mounts the existing `LaneGitActionsPane` in a floating sheet rather
 * than re-implementing any git UI: the pane is handed down from `LanesPage` as
 * a render prop with exactly the props the Lanes pane region already passes.
 */

import React, { useCallback, useMemo, useState } from "react";
import { CaretDown, GitBranch, Signpost, X } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneEvent } from "../../../../shared/types/laneEvents";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge, outlineButton } from "../laneDesignTokens";
import type { LaneTabPrTag } from "../lanePageModel";
import { openAgentInWorkTabPath } from "../../../lib/laneNavigation";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";
import { StoryPrChips } from "./LaneStoryVisuals";
import { LaneStoryCanvas } from "./LaneStoryCanvas";
import { useLaneEvents } from "./useLaneEvents";
import {
  COMMIT_COLOR,
  LANE_COLOR,
  PR_COLOR,
  REVIEW_COLOR,
  SESSION_COLOR,
  STORY_FILTERS,
  STORY_FILTER_LABELS,
  buildHeatStrip,
  buildLaneStoryLayout,
  buildStorySummary,
  filterStoryEvents,
  formatGitReadout,
  type StoryFilter,
} from "./laneStoryModel";

const FILTER_SWATCH: Record<StoryFilter, string> = {
  commits: COMMIT_COLOR,
  prs: PR_COLOR,
  ci: PR_COLOR,
  reviews: REVIEW_COLOR,
  lanes: LANE_COLOR,
  sessions: SESSION_COLOR,
};

const ALL_FILTERS = new Set<StoryFilter>(STORY_FILTERS);
const EMPTY_EVENTS: LaneEvent[] = [];

export type LaneStoryTimelineProps = {
  lane: LaneSummary | null;
  prs: readonly LaneTabPrTag[];
  humanAvatarUrl: string | null;
  /** The Lanes pane region's Git Actions pane, rendered inside the Git ▾ sheet. */
  renderGitActions?: (laneId: string) => React.ReactNode;
  onOpenPr?: (pr: LaneTabPrTag) => void;
  /** False while the Lanes route is parked; suspends the story read entirely. */
  active?: boolean;
};

export function LaneStoryTimeline({
  lane,
  prs,
  humanAvatarUrl,
  renderGitActions,
  onOpenPr,
  active = true,
}: LaneStoryTimelineProps) {
  const navigate = useNavigate();
  const laneId = lane?.id ?? null;
  const { result, loading } = useLaneEvents(laneId, active);
  const [filters, setFilters] = useState<Set<StoryFilter>>(() => new Set(ALL_FILTERS));
  const [unfoldedIds, setUnfoldedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [gitSheetOpen, setGitSheetOpen] = useState(false);
  const [busy, setBusy] = useState<null | "pull" | "push">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const projectRoot = useAppStore(selectActiveProjectRoot);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneWorkViewState = useAppStore((s) => s.setLaneWorkViewState);

  // Memoised so a re-render with the same result does not rebuild the layout.
  const events = useMemo(() => result?.events ?? EMPTY_EVENTS, [result]);
  const visibleEvents = useMemo(() => filterStoryEvents(events, filters), [events, filters]);

  const layout = useMemo(() => buildLaneStoryLayout({
    events: visibleEvents,
    branches: result?.branches ?? [],
    chats: result?.chats ?? [],
    showSwimlanes: filters.has("sessions"),
    unfoldedIds,
  }), [visibleEvents, result, filters, unfoldedIds]);

  const heat = useMemo(() => buildHeatStrip(visibleEvents), [visibleEvents]);
  const summary = useMemo(() => buildStorySummary({
    events,
    chats: result?.chats ?? [],
    baseRef: result?.baseRef ?? lane?.baseRef ?? null,
  }), [events, result, lane]);

  const readout = useMemo(
    () => formatGitReadout(lane?.status ?? null, lane?.baseRef ?? "base"),
    [lane?.status, lane?.baseRef],
  );

  const toggleFilter = useCallback((filter: StoryFilter) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      // Never leave the canvas with nothing to draw.
      return next.size ? next : new Set(ALL_FILTERS);
    });
  }, []);

  const toggleFold = useCallback((foldId: string) => {
    setUnfoldedIds((prev) => {
      const next = new Set(prev);
      if (next.has(foldId)) next.delete(foldId);
      else next.add(foldId);
      return next;
    });
  }, []);

  const runPull = useCallback(async () => {
    if (!laneId) return;
    setBusy("pull");
    setActionError(null);
    try {
      await window.ade.git.sync({ laneId, mode: "rebase", baseRef: lane?.baseRef ?? undefined });
      // Local git action → lane status only; snapshot decorations are untouched
      // (ade-perf-lanes: "Scope Git Actions refreshes to lane status").
      await refreshLanes({ includeStatus: true, includeSnapshots: false });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [lane?.baseRef, laneId, refreshLanes]);

  const runPush = useCallback(async () => {
    if (!laneId) return;
    setBusy("push");
    setActionError(null);
    try {
      await window.ade.git.push({ laneId });
      await refreshLanes({ includeStatus: true, includeSnapshots: false });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [laneId, refreshLanes]);

  const openChat = useCallback((chatSessionId: string) => {
    if (!laneId) return;
    selectLane(laneId);
    setLaneWorkViewState(projectRoot, laneId, (prev) => ({
      ...prev,
      viewMode: "tabs",
      openItemIds: prev.openItemIds.includes(chatSessionId) ? prev.openItemIds : [...prev.openItemIds, chatSessionId],
      activeItemId: chatSessionId,
      selectedItemId: chatSessionId,
    }));
    navigate(openAgentInWorkTabPath(laneId, chatSessionId));
  }, [laneId, navigate, projectRoot, selectLane, setLaneWorkViewState]);

  const openDiff = useCallback((_event: LaneEvent) => {
    // v1: the diff lives in the Git Actions pane, so a commit's "View diff"
    // opens the same sheet the Git ▾ control does rather than inventing a
    // second diff surface.
    setGitSheetOpen(true);
  }, []);

  const openPrNumber = useCallback((prNumber: number) => {
    const match = prs.find((pr) => pr.githubPrNumber === prNumber) ?? null;
    if (match) onOpenPr?.(match);
  }, [onOpenPr, prs]);

  if (!lane) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
        Select a lane to read its story.
      </div>
    );
  }

  const empty = !loading && events.length === 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative" data-testid="lane-story-timeline">
      {/* Row 1 — identity */}
      <div className="flex items-center gap-8 px-4 pt-3" style={{ minHeight: 30 }}>
        <div className="flex items-center gap-2 min-w-0">
          <Signpost size={15} weight="bold" color={lane.color ?? COLORS.accent} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
            {lane.name}
          </span>
          <GitBranch size={11} color={COLORS.textDim} />
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{lane.branchRef}</span>
        </div>
        <StoryPrChips prs={prs} onOpen={onOpenPr} />
      </div>

      {/* Summary sentence */}
      <div className="px-4 pt-1.5" style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>
        {summary}
      </div>

      {/* Row 2 — filters + git */}
      <div className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {STORY_FILTERS.map((filter) => {
            const active = filters.has(filter);
            return (
              <button
                key={filter}
                type="button"
                data-testid={`lane-story-filter-${filter}`}
                aria-pressed={active}
                onClick={() => toggleFilter(filter)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 22,
                  padding: "0 8px",
                  borderRadius: 6,
                  fontFamily: SANS_FONT,
                  fontSize: 10,
                  color: active ? COLORS.textSecondary : COLORS.textDim,
                  background: active ? "color-mix(in srgb, var(--color-fg) 5%, transparent)" : "transparent",
                  border: `1px solid ${active ? COLORS.outlineBorder : "transparent"}`,
                  cursor: "pointer",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 2, background: FILTER_SWATCH[filter], opacity: active ? 1 : 0.4 }} />
                {STORY_FILTER_LABELS[filter]}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1 }} />

        <div className="flex items-center gap-2">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, whiteSpace: "nowrap" }}>
            {readout.base}
          </span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, whiteSpace: "nowrap" }}>
            {readout.remote}
          </span>
          <span style={inlineBadge(readout.clean ? COLORS.success : COLORS.warning, {
            height: 18,
            padding: "0 6px",
            fontSize: 9,
            fontFamily: MONO_FONT,
            letterSpacing: "0.6px",
          })}
          >
            {readout.clean ? "CLEAN" : "DIRTY"}
          </span>
          <button
            type="button"
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
            disabled={busy != null}
            onClick={() => { void runPull(); }}
          >
            {busy === "pull" ? "Pulling…" : "Pull (rebase)"}
          </button>
          <button
            type="button"
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
            disabled={busy != null}
            onClick={() => { void runPush(); }}
          >
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
          <button
            type="button"
            data-testid="lane-story-git-sheet-toggle"
            aria-expanded={gitSheetOpen}
            style={outlineButton({
              height: 26,
              padding: "0 10px",
              fontSize: 11,
              color: gitSheetOpen ? COLORS.accent : COLORS.textSecondary,
              borderColor: gitSheetOpen ? COLORS.accent : undefined,
            })}
            onClick={() => setGitSheetOpen((prev) => !prev)}
          >
            Git <CaretDown size={10} />
          </button>
        </div>
      </div>

      {actionError ? (
        <div className="px-4 pb-2" style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.danger }}>
          {actionError}
        </div>
      ) : null}

      {empty ? (
        <div className="flex-1 flex items-center justify-center relative">
          <div className="ade-lane-story-bg" aria-hidden />
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, position: "relative" }}>
            No story yet — actions in this lane will appear here.
          </span>
        </div>
      ) : (
        <LaneStoryCanvas
          layout={layout}
          heat={heat}
          humanAvatarUrl={humanAvatarUrl}
          tailChats={result?.chats ?? []}
          settleKey={lane.id}
          unfoldedIds={unfoldedIds}
          onToggleFold={toggleFold}
          onOpenChat={openChat}
          onOpenDiff={openDiff}
          onOpenPr={openPrNumber}
        />
      )}

      {/* Git ▾ sheet — the real Git Actions pane, floated over the canvas. */}
      {gitSheetOpen && renderGitActions ? (
        <div
          data-testid="lane-story-git-sheet"
          className="ade-glass-card"
          style={{
            position: "absolute",
            top: 96,
            right: 12,
            bottom: 12,
            width: 460,
            maxWidth: "calc(100% - 24px)",
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: COLORS.cardBgSolid,
          }}
        >
          <div
            className="flex items-center justify-between px-3"
            style={{ height: 30, borderBottom: `1px solid ${COLORS.borderMuted}`, flexShrink: 0 }}
          >
            <span style={{ fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", color: COLORS.textMuted }}>
              Git actions
            </span>
            <button
              type="button"
              aria-label="Close git actions"
              style={outlineButton({ height: 20, padding: "0 6px", fontSize: 10 })}
              onClick={() => setGitSheetOpen(false)}
            >
              <X size={11} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">{renderGitActions(lane.id)}</div>
        </div>
      ) : null}
    </div>
  );
}
