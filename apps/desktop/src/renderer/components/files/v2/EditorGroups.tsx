import React, { Fragment } from "react";
import { Group, Panel } from "react-resizable-panels";
import { ResizeGutter } from "../../ui/ResizeGutter";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { GroupsState } from "./editorGroupsStore";
import { EditorGroup } from "./EditorGroup";
import type { EditorThemeMode } from "./viewers/types";

// Persisted divider sizes, keyed by lane session + exact group layout. A given
// split config (e.g. [g1,g2]) restores its dragged sizes when you return to it;
// a NEW split config has no entry and starts even. In-memory (per app run).
const splitSizesByKey = new Map<string, Record<string, number>>();

export type EditorGroupsProps = {
  sessionKey: string;
  state: GroupsState;
  workspaceId: string;
  rootPath: string;
  laneId: string | null;
  canEdit: boolean;
  canRevealInFinder: boolean;
  theme: EditorThemeMode;
  registry: MonacoModelRegistry;
  dirtyPaths: ReadonlySet<string>;
  onActivateTab: (groupId: string, path: string) => void;
  onCloseTab: (groupId: string, path: string) => void;
  onCloseOthers: (groupId: string, path: string) => void;
  onPinTab: (groupId: string, path: string) => void;
  onSplitTab: (groupId: string, path: string) => void;
  onPromoteTab: (groupId: string, path: string) => void;
  onFocusGroup: (groupId: string) => void;
  onSplit: (groupId: string) => void;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onTabDragStart: (groupId: string, path: string) => void;
  onTabDragEnd: () => void;
  onTabDrop: (groupId: string) => void;
  isTabDragging: boolean;
  onBodyDrop: (targetGroupId: string, side: "left" | "right" | "center") => void;
};

/**
 * Editor groups laid out side-by-side in a single horizontal resizable group.
 * Splits always tile left↔right (VSCode-style), unlike the perpendicular grid
 * tiling of PaneTilingLayout — so an explicit split or a drag-to-edge produces
 * columns, never stacked rows. react-resizable-panels reconciles the dynamic
 * panel set by stable `id`.
 */
export function EditorGroups(props: EditorGroupsProps) {
  const ids = props.state.groupOrder.filter((id) => props.state.groups[id]);
  const evenSize = (100 / Math.max(1, ids.length)).toFixed(4);
  // Re-key only when the SET of groups changes (split/close/move) so the group
  // re-initialises; manual divider resizes keep the same key and are preserved.
  // Sizes are percentages, so they reflow with the window width.
  const layoutKey = ids.join("|");
  const sizeKey = `${props.sessionKey}::${layoutKey}`;
  const persisted = splitSizesByKey.get(sizeKey);

  const panelSize = (id: string): string => {
    const saved = persisted?.[`files-group-${id}`];
    return typeof saved === "number" && Number.isFinite(saved) ? `${saved}%` : `${evenSize}%`;
  };

  return (
    <Group
      key={layoutKey}
      orientation="horizontal"
      className="h-full w-full min-h-0 min-w-0"
      onLayoutChanged={(next) => {
        if (next && Object.keys(next).length > 1) splitSizesByKey.set(sizeKey, next);
      }}
    >
      {ids.map((id, i) => (
        <Fragment key={id}>
          <Panel id={`files-group-${id}`} defaultSize={panelSize(id)} minSize="15%" className="min-h-0 min-w-0 overflow-hidden">
            <EditorGroup
              group={props.state.groups[id]!}
              isActiveGroup={id === props.state.activeGroupId}
              workspaceId={props.workspaceId}
              rootPath={props.rootPath}
              laneId={props.laneId}
              canEdit={props.canEdit}
              canRevealInFinder={props.canRevealInFinder}
              theme={props.theme}
              registry={props.registry}
              dirtyPaths={props.dirtyPaths}
              onActivateTab={props.onActivateTab}
              onCloseTab={props.onCloseTab}
              onCloseOthers={props.onCloseOthers}
              onPinTab={props.onPinTab}
              onSplitTab={props.onSplitTab}
              onPromoteTab={props.onPromoteTab}
              onFocusGroup={props.onFocusGroup}
              onSplit={props.onSplit}
              onDirtyChange={props.onDirtyChange}
              onTabDragStart={props.onTabDragStart}
              onTabDragEnd={props.onTabDragEnd}
              onTabDrop={props.onTabDrop}
              isTabDragging={props.isTabDragging}
              onBodyDrop={props.onBodyDrop}
            />
          </Panel>
          {i < ids.length - 1 ? <ResizeGutter orientation="vertical" thin /> : null}
        </Fragment>
      ))}
    </Group>
  );
}
