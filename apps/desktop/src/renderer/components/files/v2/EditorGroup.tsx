import React, { useRef, useState } from "react";
import { ArrowSquareOut, CaretRight, Copy, FloppyDisk, PushPin, SplitHorizontal, X, XCircle } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorGroup as EditorGroupModel, EditorTab } from "./editorGroupsStore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ViewerHost } from "./ViewerHost";
import { DiffViewer } from "./viewers/DiffViewer";
import type { EditorApi, EditorThemeMode } from "./viewers/types";
import { joinDisplayPath } from "./pathDisplay";

export type EditorGroupProps = {
  group: EditorGroupModel;
  isActiveGroup: boolean;
  workspaceId: string;
  rootPath: string;
  /** Lane id of the active workspace, or null for the primary checkout (no diff). */
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
  /** True while any tab is being dragged — shows this group's split/move drop zones. */
  isTabDragging: boolean;
  onBodyDrop: (targetGroupId: string, side: "left" | "right" | "center") => void;
};

type DropZone = "left" | "right" | "center";

export function EditorGroup(props: EditorGroupProps) {
  const { group, dirtyPaths } = props;
  const editorApis = useRef<Map<string, EditorApi>>(new Map());
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [diffPaths, setDiffPaths] = useState<Set<string>>(new Set());
  const activeTab = group.tabs.find((t) => t.path === group.activeTabId) ?? null;
  const diffAvailable = !!props.laneId && activeTab?.viewerKind === "code";
  const activeInDiff = !!activeTab && diffAvailable && diffPaths.has(activeTab.path);
  const toggleDiff = (path: string) =>
    setDiffPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const tabMenuItems = (path: string): ContextMenuItem[] => {
    const pinned = group.tabs.find((t) => t.path === path)?.pinned ?? false;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    return [
      { type: "item", label: "Close", icon: <X size={13} />, onClick: () => props.onCloseTab(group.id, path) },
      { type: "item", label: "Close Others", icon: <XCircle size={13} />, onClick: () => props.onCloseOthers(group.id, path), disabled: group.tabs.length <= 1 },
      { type: "separator" },
      { type: "item", label: pinned ? "Pinned" : "Pin", icon: <PushPin size={13} weight={pinned ? "fill" : "regular"} />, onClick: () => props.onPinTab(group.id, path), disabled: pinned },
      { type: "item", label: "Split Right", icon: <SplitHorizontal size={13} />, onClick: () => props.onSplitTab(group.id, path), disabled: group.tabs.length <= 1 },
      { type: "separator" },
      { type: "item", label: "Copy Full Path", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(joinDisplayPath(props.rootPath, path)) },
      { type: "item", label: "Copy Relative Path", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(path) },
      { type: "item", label: "Copy Name", icon: <Copy size={13} />, onClick: () => void window.ade.app.writeClipboardText?.(name) },
      {
        type: "item",
        label: "Reveal in Finder",
        icon: <ArrowSquareOut size={13} />,
        onClick: () => void window.ade.app.openPathInEditor?.({ rootPath: props.rootPath, relativePath: path, target: "finder" }).catch(() => {}),
        disabled: !props.canRevealInFinder,
      },
    ];
  };

  const registerApi = (path: string, api: EditorApi | null) => {
    if (api) editorApis.current.set(path, api);
    else editorApis.current.delete(path);
  };

  const saveActive = () => {
    if (!activeTab) return;
    void editorApis.current.get(activeTab.path)?.save();
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onMouseDown={() => props.onFocusGroup(group.id)}
      style={{ outline: props.isActiveGroup ? `1px solid ${COLORS.accentBorder}` : "none", outlineOffset: -1 }}
    >
      {/* Tab strip */}
      <div
        className="flex shrink-0 items-stretch overflow-x-auto border-b"
        style={{ borderColor: COLORS.border, background: COLORS.recessedBg }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => props.onTabDrop(group.id)}
      >
        {group.tabs.length === 0 ? (
          <div className="px-3 py-1.5 text-xs" style={{ color: COLORS.textDim }}>No open files</div>
        ) : (
          group.tabs.map((tab) => (
            <TabButton
              key={tab.path}
              tab={tab}
              active={tab.path === group.activeTabId}
              dirty={dirtyPaths.has(tab.path)}
              onActivate={() => props.onActivateTab(group.id, tab.path)}
              onClose={() => props.onCloseTab(group.id, tab.path)}
              onPromote={() => props.onPromoteTab(group.id, tab.path)}
              onDragStart={() => props.onTabDragStart(group.id, tab.path)}
              onDragEnd={props.onTabDragEnd}
              onContextMenu={(x, y) => setTabMenu({ x, y, path: tab.path })}
            />
          ))
        )}
      </div>

      {/* Breadcrumb + toolbar */}
      {activeTab ? (
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
                      onClick={() => toggleDiff(activeTab.path)}
                      className="px-2 py-0.5 text-[10px] font-semibold uppercase"
                      style={{ color: isOn ? "var(--color-accent-fg)" : COLORS.textMuted, background: isOn ? COLORS.accent : "transparent" }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {activeTab.viewerKind === "code" && props.canEdit && !activeInDiff ? (
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

      {/* Body */}
      <div className="relative min-h-0 min-w-0 flex-1">
        {activeTab && activeInDiff && props.laneId ? (
          <DiffViewer laneId={props.laneId} path={activeTab.path} theme={props.theme} />
        ) : activeTab ? (
          <ViewerHost
            workspaceId={props.workspaceId}
            rootPath={props.rootPath}
            tab={activeTab}
            canEdit={props.canEdit}
            theme={props.theme}
            registry={props.registry}
            onDirtyChange={props.onDirtyChange}
            onEdit={(path) => props.onPromoteTab(group.id, path)}
            onRegisterEditorApi={registerApi}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm" style={{ color: COLORS.textDim }}>
            Select a file
          </div>
        )}

        {/* Drag-to-split / move drop zone (only while a tab is being dragged). */}
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
        <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.path)} onClose={() => setTabMenu(null)} />
      ) : null}
    </div>
  );
}

function TabButton({
  tab,
  active,
  dirty,
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
        // Some Chromium builds won't start a DnD without payload set.
        try { e.dataTransfer.setData("text/plain", tab.path); e.dataTransfer.effectAllowed = "move"; } catch { /* ignore */ }
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
