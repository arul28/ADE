/**
 * The `List | Timeline` segmented control that the Lanes header grows while the
 * Lane story experiment is on, plus the hook that owns (and persists) the view.
 *
 * This module is imported eagerly by `LanesPage` so the header can render the
 * control; it stays deliberately tiny — the story body itself is lazy, so the
 * experiment costs the off-state bundle almost nothing.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ListBullets, ChartLineUp } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../laneDesignTokens";
import { readLaneStoryView, writeLaneStoryView, type LaneStoryView } from "./laneStoryViewState";

export type { LaneStoryView } from "./laneStoryViewState";

export function useLaneStoryView(projectKey: string | null | undefined): {
  view: LaneStoryView;
  setView: (next: LaneStoryView) => void;
} {
  const [view, setViewState] = useState<LaneStoryView>(() => readLaneStoryView(projectKey));
  const projectKeyRef = useRef(projectKey);
  projectKeyRef.current = projectKey;

  // A project switch re-reads that project's own key rather than carrying the
  // previous project's view across.
  useEffect(() => {
    setViewState(readLaneStoryView(projectKey));
  }, [projectKey]);

  const setView = useCallback((next: LaneStoryView) => {
    setViewState(next);
    writeLaneStoryView(projectKeyRef.current, next);
  }, []);

  return { view, setView };
}

const OPTIONS: Array<{ value: LaneStoryView; label: string; Icon: typeof ListBullets }> = [
  { value: "list", label: "List", Icon: ListBullets },
  { value: "timeline", label: "Timeline", Icon: ChartLineUp },
];

export function LaneStoryViewControl({
  view,
  onChange,
}: {
  view: LaneStoryView;
  onChange: (next: LaneStoryView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Lane story view"
      data-testid="lane-story-view-control"
      className="inline-flex items-center shrink-0"
      style={{ border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 6, overflow: "hidden", height: 24 }}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className="inline-flex items-center gap-1"
            style={{
              height: 22,
              padding: "0 8px",
              fontFamily: MONO_FONT,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
              color: active ? COLORS.accent : COLORS.textMuted,
              background: active ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Icon size={10} weight="bold" /> {label}
          </button>
        );
      })}
    </div>
  );
}
