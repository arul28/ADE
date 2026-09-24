import React, { useCallback, useEffect, useRef, useState } from "react";
import { MagnifyingGlass, Plus, Rows, TreeStructure, X } from "@phosphor-icons/react";
import type { LaneDeleteProgress, LaneListSnapshot } from "../../../../shared/types";
import type { CreatingIssuePlaceholder } from "../../../lib/launchedLanesHighlight";
import { getLaneDeleteStatusLabel, isLaneDeleteProgressActive } from "../../../lib/laneDeleteProgress";
import { COLORS } from "../laneDesignTokens";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { LaneSidebarGroupHeader, LaneSidebarGroupMenu, laneGroupHasActions } from "./LaneSidebarGroupHeader";
import { LaneSidebarCreatingRow, LaneSidebarRow } from "./LaneSidebarRow";
import {
  laneStateGroupSectionId,
  type LaneGroupBulkAction,
  type LaneSidebarGroupBy,
  type LaneSidebarLayout,
  type LaneSidebarTreeRow,
  type LaneStateGroupId,
} from "./laneSidebarModel";

const GROUP_BY_OPTIONS: Array<{ value: LaneSidebarGroupBy; label: string; description: string; Icon: typeof Rows }> = [
  { value: "state", label: "State", description: "Group lanes by what they need: needs you, active, behind, done, stale.", Icon: Rows },
  { value: "stack", label: "Stack", description: "Show lanes as the stack tree, children under their parent.", Icon: TreeStructure },
];

const EMPTY_AGENTS: LaneAgent[] = [];

export const LANES_FILTER_INPUT_ID = "lanes-filter-input";

export type LaneSidebarListProps = {
  layout: LaneSidebarLayout;
  onGroupByChange: (next: LaneSidebarGroupBy) => void;
  /** Section ids of collapsed State groups. */
  collapsedGroupIds: ReadonlySet<string>;
  onToggleGroupCollapsed: (sectionId: string) => void;
  /** Bulk action from a group header menu. Opens a confirm step; never runs directly. */
  onGroupBulkAction: (action: LaneGroupBulkAction, laneIds: string[]) => void;
  colorIndexByLaneId: ReadonlyMap<string, number>;
  needsYouReasonByLaneId: ReadonlyMap<string, string>;
  selectedLaneId: string | null;
  multiSelectedLaneIds: ReadonlySet<string>;
  filter: string;
  onFilterChange: (next: string) => void;
  canCreateLane: boolean;
  onCreateLane: () => void;
  loading: boolean;
  totalLaneCount: number;
  laneRuntimeById: ReadonlyMap<string, LaneListSnapshot["runtime"]>;
  laneSnapshotByLaneId: ReadonlyMap<string, LaneListSnapshot>;
  agentsByLaneId: ReadonlyMap<string, LaneAgent[]>;
  lanePrTagsByLaneId: ReadonlyMap<string, LaneTabPrTag[]>;
  deleteProgressByLaneId: Record<string, LaneDeleteProgress>;
  creatingLaneIds: ReadonlySet<string>;
  pendingCreatingIssues: CreatingIssuePlaceholder[];
  pulsingLaneId: string | null;
  onSelectRow: (laneId: string, event: React.MouseEvent) => void;
  onStepSelection: (direction: -1 | 1) => void;
  /** Keybinding checks for "next lane" / "previous lane" while the list has focus. */
  isNextKey: (event: React.KeyboardEvent) => boolean;
  isPrevKey: (event: React.KeyboardEvent) => boolean;
  onContextMenu: (laneId: string, event: React.MouseEvent) => void;
  onOpenPr: (pr: LaneTabPrTag) => void;
  onOpenAgent: (agent: LaneAgent) => void;
  onClearMultiSelection: () => void;
};

/**
 * The Lanes tab's sidebar body: a filter, a Group by toggle, a New lane
 * button, and every lane. By State, Primary is pinned on top and the rest sit
 * in groups (Needs you, Active, Behind main, Done, Stale, Quiet); by Stack,
 * lanes form the stack tree with children indented under their parent.
 */
export function LaneSidebarList(props: LaneSidebarListProps) {
  const {
    layout,
    onGroupByChange,
    collapsedGroupIds,
    onToggleGroupCollapsed,
    onGroupBulkAction,
    colorIndexByLaneId,
    needsYouReasonByLaneId,
    selectedLaneId,
    multiSelectedLaneIds,
    filter,
    onFilterChange,
    canCreateLane,
    onCreateLane,
    loading,
    totalLaneCount,
    laneRuntimeById,
    laneSnapshotByLaneId,
    agentsByLaneId,
    lanePrTagsByLaneId,
    deleteProgressByLaneId,
    creatingLaneIds,
    pendingCreatingIssues,
    pulsingLaneId,
    onSelectRow,
    onStepSelection,
    isNextKey,
    isPrevKey,
    onContextMenu,
    onOpenPr,
    onOpenAgent,
    onClearMultiSelection,
  } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const [groupMenu, setGroupMenu] = useState<{ groupId: LaneStateGroupId; laneIds: string[]; x: number; y: number } | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const groupBy = layout.groupBy;

  // Keep the selected row on screen when the selection moves by keyboard or
  // by a deep link.
  useEffect(() => {
    if (!selectedLaneId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-lane-id="${CSS.escape(selectedLaneId)}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selectedLaneId]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (isNextKey(event)) {
      event.preventDefault();
      onStepSelection(1);
    } else if (isPrevKey(event)) {
      event.preventDefault();
      onStepSelection(-1);
    } else if (event.key === "Escape" && multiSelectedLaneIds.size > 0) {
      event.preventDefault();
      onClearMultiSelection();
    }
  };

  const renderRow = (row: LaneSidebarTreeRow) => {
    const laneId = row.lane.id;
    const snapshot = laneSnapshotByLaneId.get(laneId);
    const deleteProgress = deleteProgressByLaneId[laneId] ?? null;
    const deleting = isLaneDeleteProgressActive(deleteProgress);
    return (
      <LaneSidebarRow
        key={laneId}
        lane={row.lane}
        depth={row.depth}
        indentLevel={row.indentLevel}
        fallbackColorIndex={colorIndexByLaneId.get(laneId) ?? 0}
        selected={selectedLaneId === laneId}
        multiSelected={multiSelectedLaneIds.has(laneId)}
        pulsing={pulsingLaneId === laneId}
        runtime={laneRuntimeById.get(laneId) ?? null}
        agents={agentsByLaneId.get(laneId) ?? EMPTY_AGENTS}
        prs={lanePrTagsByLaneId.get(laneId)}
        rebaseSuggestion={snapshot?.rebaseSuggestion ?? null}
        autoRebaseStatus={snapshot?.autoRebaseStatus ?? null}
        deleteStatusLabel={deleting ? getLaneDeleteStatusLabel(deleteProgress) : null}
        creating={!deleting && creatingLaneIds.has(laneId)}
        parentHint={row.parentHint ?? null}
        needsYouReason={needsYouReasonByLaneId.get(laneId) ?? null}
        onSelect={onSelectRow}
        onContextMenu={onContextMenu}
        onOpenPr={onOpenPr}
        onOpenAgent={onOpenAgent}
      />
    );
  };
  // Lanes a batch launch is still creating. By State they sit right under
  // Primary, where a new lane is about to appear; by Stack, at the end.
  const creatingRows = pendingCreatingIssues.map((placeholder) => (
    <LaneSidebarCreatingRow key={`creating:${placeholder.issueId}`} name={placeholder.name} />
  ));
  const rowCount = layout.groupBy === "stack"
    ? layout.rows.length
    : layout.pinned.length + layout.groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lane-sidebar-list">
      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2 pt-1">
        <div className="relative flex min-w-0 flex-1 items-center">
          <MagnifyingGlass
            size={12}
            className="pointer-events-none absolute left-2"
            style={{ color: COLORS.textDim }}
          />
          <input
            id={LANES_FILTER_INPUT_ID}
            data-tour="lanes.filter"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
                onStepSelection(1);
              }
            }}
            placeholder="Filter lanes"
            title="Filter lanes (is:dirty, is:clean, type:worktree)"
            aria-label="Filter lanes"
            className="h-7 w-full rounded-md bg-[color-mix(in_srgb,var(--color-fg)_4%,transparent)] pl-7 pr-7 text-[12px] outline-none transition-colors placeholder:text-muted-fg/60 focus:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]"
            style={{ color: COLORS.textPrimary, border: "1px solid transparent" }}
          />
          {filter.length > 0 ? (
            <button
              type="button"
              className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded"
              style={{ color: COLORS.textMuted }}
              onClick={() => onFilterChange("")}
              aria-label="Clear filter"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
        <div className="ade-work-segmented shrink-0" role="group" aria-label="Group lanes by" data-testid="lane-sidebar-group-by">
          {GROUP_BY_OPTIONS.map(({ value, label, description, Icon }) => (
            <SmartTooltip key={value} content={{ label: `Group by ${label}`, description }}>
              <button
                type="button"
                className="ade-work-segmented-item"
                style={{ padding: "3px 6px" }}
                data-active={groupBy === value ? "true" : undefined}
                aria-pressed={groupBy === value}
                aria-label={`Group by ${label}`}
                data-testid={`lane-sidebar-group-by-${value}`}
                onClick={() => onGroupByChange(value)}
              >
                <Icon size={12} weight={groupBy === value ? "fill" : "regular"} aria-hidden />
              </button>
            </SmartTooltip>
          ))}
        </div>
        <button
          type="button"
          data-tour="lanes.newLane"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)] disabled:opacity-40"
          style={{ color: COLORS.textSecondary }}
          disabled={!canCreateLane}
          onClick={onCreateLane}
          title="New lane"
          aria-label="New lane"
        >
          <Plus size={14} />
        </button>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label="Lanes"
        aria-multiselectable
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 outline-none"
        onKeyDown={onListKeyDown}
      >
        {groupBy === "stack" ? (
          <div className="flex flex-col gap-0.5">
            {layout.rows.map(renderRow)}
            {creatingRows}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {layout.pinned.length > 0 || creatingRows.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {layout.pinned.map(renderRow)}
                {creatingRows}
              </div>
            ) : null}
            {layout.groups.map((group) => {
              const sectionId = laneStateGroupSectionId(group.id);
              const collapsed = collapsedGroupIds.has(sectionId);
              const bulkLaneIds = group.rows
                .map((row) => row.lane.id)
                .filter((laneId) => !isLaneDeleteProgressActive(deleteProgressByLaneId[laneId] ?? null));
              const openMenu = laneGroupHasActions(group.id) && bulkLaneIds.length > 0
                ? (point: { x: number; y: number }) => setGroupMenu({ groupId: group.id, laneIds: bulkLaneIds, ...point })
                : null;
              return (
                <section key={group.id} className="flex flex-col gap-0.5" data-testid="lane-sidebar-group" data-group-id={group.id}>
                  <LaneSidebarGroupHeader
                    groupId={group.id}
                    count={group.rows.length}
                    collapsed={collapsed}
                    onToggleCollapsed={() => onToggleGroupCollapsed(sectionId)}
                    onOpenMenu={openMenu}
                  />
                  {collapsed ? null : group.rows.map(renderRow)}
                </section>
              );
            })}
          </div>
        )}
        {rowCount === 0 && pendingCreatingIssues.length === 0 ? (
          <div className="px-2 py-3 text-[12px]" style={{ color: COLORS.textMuted }}>
            {loading && totalLaneCount === 0 ? "Loading lanes…" : totalLaneCount === 0 ? "No lanes yet." : "No lanes match."}
          </div>
        ) : null}
      </div>
      {groupMenu ? (
        <LaneSidebarGroupMenu menu={groupMenu} onClose={closeGroupMenu} onAction={onGroupBulkAction} />
      ) : null}
    </div>
  );
}
