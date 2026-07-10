import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CaretRight, Copy, FloppyDisk, PushPin, SplitHorizontal, X, XCircle } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import { getLaneAccent } from "../../lanes/laneColorPalette";
import { COLORS } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorGroup as EditorGroupModel, EditorTab } from "./editorGroupsStore";
import type { TabWorkspaceContext } from "./EditorGroups";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { FilesTabScope } from "./filesTabScope";
import { filterTabsForScope, isLaneGroupBoundary, orderTabsByLane } from "./tabDisplayOrder";
import { ViewerHost } from "./ViewerHost";
import { DiffViewer } from "./viewers/DiffViewer";
import type { EditorApi, EditorThemeMode } from "./viewers/types";
import { joinDisplayPath } from "./pathDisplay";

export type EditorGroupProps = {
  group: EditorGroupModel;
  isActiveGroup: boolean;
  explorerWorkspaceId: string;
  explorerLaneId: string | null;
  lanes: LaneSummary[];
  tabScope: FilesTabScope;
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

type DropZone = "left" | "right" | "center";

function laneAccentForTab(tab: EditorTab, lanes: readonly LaneSummary[]): string {
  const lane = tab.laneId ? lanes.find((entry) => entry.id === tab.laneId) : null;
  const fallbackIndex = tab.laneId ? lanes.findIndex((entry) => entry.id === tab.laneId) : 0;
  return getLaneAccent(lane, fallbackIndex >= 0 ? fallbackIndex : 0);
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export function EditorGroup(props: EditorGroupProps) {
  const { group, dirtyTabIds, onDirtyChange, onError, registry, resolveTabContext } = props;
  const groupRef = useRef<HTMLDivElement | null>(null);
  const editorApis = useRef<Map<string, EditorApi>>(new Map());
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [diffTabIds, setDiffTabIds] = useState<Set<string>>(new Set());

  const displayTabs = useMemo(() => {
    const filtered = filterTabsForScope(group.tabs, props.tabScope, props.explorerLaneId, props.explorerWorkspaceId);
    return props.tabScope === "all" ? orderTabsByLane(filtered, props.lanes) : filtered;
  }, [group.tabs, props.explorerLaneId, props.explorerWorkspaceId, props.lanes, props.tabScope]);

  const activeTab = useMemo(() => {
    const fromGroup = group.tabs.find((t) => t.id === group.activeTabId) ?? null;
    if (props.tabScope === "all") return fromGroup;
    if (!fromGroup) return null;
    if (displayTabs.some((tab) => tab.id === fromGroup.id)) return fromGroup;
    return displayTabs[displayTabs.length - 1] ?? null;
  }, [displayTabs, group.activeTabId, group.tabs, props.tabScope]);
  const activeContext = activeTab ? resolveTabContext(activeTab) : null;
  const diffAvailable = !!activeContext?.laneId && activeTab?.viewerKind === "code";
  const activeInDiff = !!activeTab && diffAvailable && diffTabIds.has(activeTab.id);
  const toggleDiff = (tabId: string) =>
    setDiffTabIds((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });

  const tabMenuItems = (tabId: string): ContextMenuItem[] => {
    const tab = group.tabs.find((t) => t.id === tabId);
    if (!tab) return [];
    const ctx = resolveTabContext(tab);
    const pinned = tab.pinned;
    const name = tab.path.split("/").filter(Boolean).pop() ?? tab.path;
    return [
      { type: "item", label: "Close", icon: <X size={13} />, onClick: () => props.onCloseTab(group.id, tabId) },
      { type: "item", label: "Close Others", icon: <XCircle size={13} />, onClick: () => props.onCloseOthers(group.id, tabId), disabled: group.tabs.length <= 1 },
      { type: "separator" },
      { type: "item", label: pinned ? "Pinned" : "Pin", icon: <PushPin size={13} weight={pinned ? "fill" : "regular"} />, onClick: () => props.onPinTab(group.id, tabId), disabled: pinned },
      { type: "item", label: "Split Right", icon: <SplitHorizontal size={13} />, onClick: () => props.onSplitTab(group.id, tabId), disabled: group.tabs.length <= 1 },
      { type: "separator" },
      { type: "item", label: "Copy Full Path", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(joinDisplayPath(ctx.rootPath, tab.path)) },
      { type: "item", label: "Copy Relative Path", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(tab.path) },
      { type: "item", label: "Copy Name", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(name) },
      {
        type: "item",
        label: "Reveal in Finder",
        icon: <ArrowSquareOut size={13} />,
        onClick: () => void window.ade.app.openPathInEditor?.({ rootPath: ctx.rootPath, relativePath: tab.path, target: "finder" }).catch(() => {}),
        disabled: !ctx.canRevealInFinder,
      },
    ];
  };

  const registerApi = (tabId: string, api: EditorApi | null) => {
    if (api) editorApis.current.set(tabId, api);
    else editorApis.current.delete(tabId);
  };

  const saveActive = useCallback(() => {
    if (!activeTab || !activeContext) return;
    const api = editorApis.current.get(activeTab.id);
    if (api) {
      void api.save().catch((err) => {
        onError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (activeTab.viewerKind !== "code") return;
    const text = registry.getValue(activeTab.id);
    if (text == null) return;
    void window.ade.files
      .writeText({ workspaceId: activeContext.workspaceId, path: activeTab.path, text })
      .then(() => {
        registry.markSaved(activeTab.id);
        onDirtyChange(activeTab.id, false);
      })
      .catch((err) => {
        onError(err instanceof Error ? err.message : String(err));
      });
  }, [activeContext, activeTab, onDirtyChange, onError, registry]);

  useEffect(() => {
    if (!props.isActiveGroup || !activeTab || activeTab.viewerKind !== "code") return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey || (event.key !== "s" && event.key !== "S")) return;
      const target = event.target;
      if (!(target instanceof Node) || !groupRef.current?.contains(target)) return;
      if (isTextInputTarget(target)) return;
      if (target instanceof Element && target.closest("[data-testid='files-v2-code-editor']")) return;
      event.preventDefault();
      saveActive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, props.isActiveGroup, saveActive]);

  return (
    <div
      ref={groupRef}
      className="flex h-full min-h-0 min-w-0 flex-col"
      onMouseDown={() => props.onFocusGroup(group.id)}
      style={{ outline: props.isActiveGroup ? `1px solid ${COLORS.accentBorder}` : "none", outlineOffset: -1 }}
    >
      <div
        className="flex shrink-0 items-stretch overflow-x-auto border-b"
        style={{ borderColor: COLORS.border, background: COLORS.recessedBg }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => props.onTabDrop(group.id)}
      >
        {displayTabs.length === 0 ? (
          <div className="px-3 py-1.5 text-xs" style={{ color: COLORS.textDim }}>No open files</div>
        ) : (
          displayTabs.map((tab, index) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              dirty={dirtyTabIds.has(tab.id)}
              laneAccent={props.tabScope === "all" ? laneAccentForTab(tab, props.lanes) : undefined}
              showLaneDivider={props.tabScope === "all" && isLaneGroupBoundary(displayTabs, index)}
              onActivate={() => props.onActivateTab(group.id, tab.id)}
              onClose={() => props.onCloseTab(group.id, tab.id)}
              onPromote={() => props.onPromoteTab(group.id, tab.id)}
              onDragStart={() => props.onTabDragStart(group.id, tab.id)}
              onDragEnd={props.onTabDragEnd}
              onContextMenu={(x, y) => setTabMenu({ x, y, tabId: tab.id })}
            />
          ))
        )}
      </div>

      {activeTab && activeContext ? (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs" style={{ borderColor: COLORS.border }}>
          <Breadcrumb path={activeTab.path} />
          <div className="ml-auto flex items-center gap-1">
            {diffAvailable ? (
              <div className="mr-1 inline-flex items-center overflow-hidden rounded" style={{ border: `1px solid ${COLORS.border}` }}>
                {(["edit", "diff"] as const).map((m) => {
                  const isOn = m === "diff" ? activeInDiff : !activeInDiff;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleDiff(activeTab.id)}
                      className="px-2 py-0.5 text-[10px] font-semibold uppercase"
                      style={{ color: isOn ? "var(--color-accent-fg)" : COLORS.textMuted, background: isOn ? COLORS.accent : "transparent" }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {activeTab.viewerKind === "code" ? (
              <button type="button" onClick={saveActive} title="Save (⌘S)" className="rounded p-1 hover:bg-white/5" style={{ color: COLORS.textMuted }}>
                <FloppyDisk size={14} />
              </button>
            ) : null}
            <button type="button" onClick={() => props.onSplit(group.id)} title="Split editor" className="rounded p-1 hover:bg-white/5" style={{ color: COLORS.textMuted }}>
              <SplitHorizontal size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1">
        {activeTab && activeContext && activeInDiff && activeContext.laneId ? (
          <DiffViewer laneId={activeContext.laneId} path={activeTab.path} theme={props.theme} />
        ) : activeTab && activeContext ? (
          <ViewerHost
            workspaceId={activeContext.workspaceId}
            rootPath={activeContext.rootPath}
            tab={activeTab}
            theme={props.theme}
            registry={props.registry}
            reloadToken={props.reloadTokensByTabId[activeTab.id] ?? 0}
            onDirtyChange={props.onDirtyChange}
            onEdit={(tabId) => props.onPromoteTab(group.id, tabId)}
            onRegisterEditorApi={registerApi}
            onError={props.onError}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm" style={{ color: COLORS.textDim }}>
            Select a file
          </div>
        )}

        {props.isTabDragging ? (
          <div
            className="absolute inset-0 z-10"
            onDragOver={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - r.left) / r.width;
              setDropZone(x < 0.28 ? "left" : x > 0.72 ? "right" : "center");
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropZone(null);
            }}
            onDrop={() => {
              if (dropZone) props.onBodyDrop(group.id, dropZone);
              setDropZone(null);
            }}
          >
            {dropZone ? (
              <div
                className="absolute transition-all"
                style={{
                  top: 0,
                  bottom: 0,
                  left: dropZone === "right" ? "50%" : 0,
                  right: dropZone === "left" ? "50%" : 0,
                  background: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
                  border: `2px solid ${COLORS.accent}`,
                  borderRadius: 8,
                  pointerEvents: "none",
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {tabMenu ? (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.tabId)} onClose={() => setTabMenu(null)} />
      ) : null}
    </div>
  );
}

function TabButton({
  tab,
  active,
  dirty,
  laneAccent,
  showLaneDivider,
  onActivate,
  onClose,
  onPromote,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: {
  tab: EditorTab;
  active: boolean;
  dirty: boolean;
  laneAccent?: string;
  showLaneDivider?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onPromote: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { icon: Icon, color } = getFileIcon(tab.title);
  return (
    <div
      role="tab"
      aria-selected={active}
      draggable
      onDragStart={(e) => {
        try { e.dataTransfer.setData("text/plain", tab.id); e.dataTransfer.effectAllowed = "move"; } catch { /* ignore */ }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onClick={onActivate}
      onDoubleClick={onPromote}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className="group flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-2.5 py-1.5 text-xs"
      style={{
        borderColor: COLORS.border,
        borderLeft: laneAccent ? `2px solid ${laneAccent}` : showLaneDivider ? `2px solid ${COLORS.border}` : undefined,
        marginLeft: showLaneDivider ? 4 : undefined,
        background: active ? COLORS.cardBg : "transparent",
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        fontStyle: tab.preview ? "italic" : "normal",
        maxWidth: 200,
      }}
      title={tab.path}
    >
      <Icon size={13} color={color} weight="regular" />
      <span className="truncate">{tab.title}</span>
      {dirty ? (
        <span className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: COLORS.textMuted }} />
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-white/10 group-hover:opacity-100"
        style={{ color: COLORS.textMuted }}
        aria-label={`Close ${tab.title}`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-0.5 truncate" style={{ color: COLORS.textDim }}>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <CaretRight size={10} /> : null}
          <span className={i === segments.length - 1 ? "" : "truncate"} style={{ color: i === segments.length - 1 ? COLORS.textMuted : COLORS.textDim }}>
            {seg}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
