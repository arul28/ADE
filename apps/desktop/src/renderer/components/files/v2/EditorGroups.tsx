import React, { Fragment } from "react";
import { Funnel, Stack } from "@phosphor-icons/react";
import { Group, Panel } from "react-resizable-panels";
import type { LaneSummary } from "../../../../shared/types";
import { ResizeGutter } from "../../ui/ResizeGutter";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorTab, GroupsState } from "./editorGroupsStore";
import { EditorGroup } from "./EditorGroup";
import type { FilesTabScope } from "./filesTabScope";
import type { EditorThemeMode } from "./viewers/types";

const splitSizesByKey = new Map<string, Record<string, number>>();

export type TabWorkspaceContext = {
  workspaceId: string;
  rootPath: string;
  laneId: string | null;
  canEdit: boolean;
  canRevealInFinder: boolean;
};

export type EditorGroupsProps = {
  sessionKey: string;
  state: GroupsState;
  explorerWorkspaceId: string;
  explorerLaneId: string | null;
  lanes: LaneSummary[];
  tabScope: FilesTabScope;
  onTabScopeChange: (scope: FilesTabScope) => void;
  resolveTabContext: (tab: EditorTab) => TabWorkspaceContext;
  theme: EditorThemeMode;
  registry: MonacoModelRegistry;
  dirtyTabIds: ReadonlySet<string>;
  reloadTokensByTabId: Readonly<Record<string, number>>;
  onActivateTab: (groupId: string, tabId: string) => void;
  onCloseTab: (groupId: string, tabId: string) => void;
  onCloseOthers: (groupId: string, tabId: string) => void;
  onPinTab: (groupId: string, tabId: string) => void;
  onSplitTab: (groupId: string, tabId: string) => void;
  onPromoteTab: (groupId: string, tabId: string) => void;
  onFocusGroup: (groupId: string) => void;
  onSplit: (groupId: string) => void;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  onError: (message: string) => void;
  onTabDragStart: (groupId: string, tabId: string) => void;
  onTabDragEnd: () => void;
  onTabDrop: (groupId: string) => void;
  isTabDragging: boolean;
  onBodyDrop: (targetGroupId: string, side: "left" | "right" | "center") => void;
};

export function EditorGroups(props: EditorGroupsProps) {
  const groupEntries = props.state.groupOrder
    .map((id) => {
      const group = props.state.groups[id];
      return group ? { id, group } : null;
    })
    .filter((entry): entry is { id: string; group: GroupsState["groups"][string] } => entry != null);
  const evenSize = (100 / Math.max(1, groupEntries.length)).toFixed(4);
  const layoutKey = groupEntries.map((entry) => entry.id).join("|");
  const sizeKey = `${props.sessionKey}::${layoutKey}`;
  const persisted = splitSizesByKey.get(sizeKey);

  const panelSize = (id: string): string => {
    const saved = persisted?.[`files-group-${id}`];
    return typeof saved === "number" && Number.isFinite(saved) ? `${saved}%` : `${evenSize}%`;
  };

  const scopeLabel = props.tabScope === "all" ? "All lanes" : "This lane only";
  const scopeTitle =
    props.tabScope === "all"
      ? "Keep files from all lanes open. Click to show only this lane's files."
      : "Show only this lane's files. Click to keep files from all lanes open.";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        className="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-0.5"
        style={{ borderColor: "var(--color-border, rgba(255,255,255,0.08))" }}
      >
        <button
          type="button"
          onClick={() => props.onTabScopeChange(props.tabScope === "all" ? "lane" : "all")}
          title={scopeTitle}
          aria-label={scopeTitle}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-white/5"
          style={{ color: "var(--color-fg-muted, rgba(255,255,255,0.55))" }}
        >
          {props.tabScope === "all" ? <Stack size={12} weight="fill" /> : <Funnel size={12} weight="fill" />}
          <span>{scopeLabel}</span>
        </button>
      </div>
      <Group
        key={layoutKey}
        orientation="horizontal"
        className="h-full w-full min-h-0 min-w-0"
        onLayoutChanged={(next) => {
          if (next && Object.keys(next).length > 1) splitSizesByKey.set(sizeKey, next);
        }}
      >
        {groupEntries.map(({ id, group }, i) => (
          <Fragment key={id}>
            <Panel id={`files-group-${id}`} defaultSize={panelSize(id)} minSize="15%" className="min-h-0 min-w-0 overflow-hidden">
              <EditorGroup
                group={group}
                isActiveGroup={id === props.state.activeGroupId}
                explorerWorkspaceId={props.explorerWorkspaceId}
                explorerLaneId={props.explorerLaneId}
                lanes={props.lanes}
                tabScope={props.tabScope}
                resolveTabContext={props.resolveTabContext}
                theme={props.theme}
                registry={props.registry}
                dirtyTabIds={props.dirtyTabIds}
                reloadTokensByTabId={props.reloadTokensByTabId}
                onActivateTab={props.onActivateTab}
                onCloseTab={props.onCloseTab}
                onCloseOthers={props.onCloseOthers}
                onPinTab={props.onPinTab}
                onSplitTab={props.onSplitTab}
                onPromoteTab={props.onPromoteTab}
                onFocusGroup={props.onFocusGroup}
                onSplit={props.onSplit}
                onDirtyChange={props.onDirtyChange}
                onError={props.onError}
                onTabDragStart={props.onTabDragStart}
                onTabDragEnd={props.onTabDragEnd}
                onTabDrop={props.onTabDrop}
                isTabDragging={props.isTabDragging}
                onBodyDrop={props.onBodyDrop}
              />
            </Panel>
            {i < groupEntries.length - 1 ? <ResizeGutter orientation="vertical" thin /> : null}
          </Fragment>
        ))}
      </Group>
    </div>
  );
}
