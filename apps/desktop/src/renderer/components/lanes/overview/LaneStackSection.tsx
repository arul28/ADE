import React from "react";
import type { LaneSummary } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { LaneIcon } from "../../ui/vcsIcons";
import { getLaneAccent } from "../laneColorPalette";
import type { LaneTabPrTag } from "../lanePageModel";
import { LaneSidebarPrChip } from "../sidebar/LaneSidebarPrChip";
import { laneBranchLabel } from "../sidebar/laneSidebarModel";
import { OVERVIEW_ROW, OVERVIEW_ROW_HOVER, OverviewSection } from "./sectionUi";

function StackRow({
  lane,
  depth,
  current,
  colorIndex,
  prs,
  onSelect,
  onOpenPr,
}: {
  lane: LaneSummary;
  depth: number;
  current: boolean;
  colorIndex: number;
  prs: LaneTabPrTag[];
  onSelect: (laneId: string) => void;
  onOpenPr: (pr: LaneTabPrTag) => void;
}) {
  // Drawn like a sidebar row: the lane glyph and name in the lane's color.
  const accent = getLaneAccent(lane, colorIndex);
  const content = (
    <>
      <span className={cn("flex min-w-0 shrink items-center gap-1.5 text-[13px]", current ? "font-semibold" : "font-medium")} style={{ color: accent }}>
        <LaneIcon size={13} />
        <span className="min-w-0 truncate">{lane.name}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-fg/60">
        {laneBranchLabel(lane.branchRef)}
      </span>
      {current ? <span className="shrink-0 text-[11.5px] text-muted-fg/60">This lane</span> : null}
      {prs.length > 0 ? <LaneSidebarPrChip prs={prs} onOpenPr={onOpenPr} /> : null}
    </>
  );
  const style = { paddingLeft: 8 + depth * 16 };
  if (current) {
    return (
      <div
        className={cn(OVERVIEW_ROW, "h-8")}
        style={{ ...style, background: "color-mix(in srgb, var(--color-fg) 4%, transparent)" }}
        data-testid="lane-stack-row"
        data-current=""
      >
        {content}
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-8")}
      style={style}
      onClick={() => onSelect(lane.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect(lane.id);
      }}
      title={`Open ${lane.name}`}
      data-testid="lane-stack-row"
    >
      {content}
    </div>
  );
}

/** Where the lane sits in its stack: its parent above, its children below. */
export function LaneStackSection({
  lane,
  parent,
  children,
  colorIndexByLaneId,
  prTagsByLaneId,
  onSelectLane,
  onOpenPr,
}: {
  lane: LaneSummary;
  parent: LaneSummary | null;
  children: LaneSummary[];
  colorIndexByLaneId: ReadonlyMap<string, number>;
  prTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  onSelectLane: (laneId: string) => void;
  onOpenPr: (pr: LaneTabPrTag) => void;
}) {
  const row = (target: LaneSummary, depth: number, current = false) => (
    <StackRow
      key={target.id}
      lane={target}
      depth={depth}
      current={current}
      colorIndex={colorIndexByLaneId.get(target.id) ?? 0}
      prs={prTagsByLaneId.get(target.id) ?? []}
      onSelect={onSelectLane}
      onOpenPr={onOpenPr}
    />
  );
  const ownDepth = parent ? 1 : 0;
  return (
    <OverviewSection title="Stack" testId="lane-stack-section" collapseKey="stack">
      {parent ? row(parent, 0) : null}
      {row(lane, ownDepth, true)}
      {children.map((child) => row(child, ownDepth + 1))}
    </OverviewSection>
  );
}
