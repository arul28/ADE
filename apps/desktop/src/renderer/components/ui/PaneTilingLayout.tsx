import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import type { LucideIcon } from "lucide-react";
import { ResizeGutter } from "./ResizeGutter";
import { FloatingPane } from "./FloatingPane";
import { useDockLayout } from "./DockLayoutState";
import { cn } from "./cn";
import {
  collectLeafIds,
  detectDropEdge,
  splitPaneAtEdge,
  swapPanes,
  isValidTree,
  type PaneLeaf,
  type PaneSplit,
  type PaneLayoutEntry,
  type DropEdge
} from "./paneTreeOps";

/* Re-export types for backward compat */
export type { PaneLeaf, PaneSplit, PaneLayoutEntry } from "./paneTreeOps";

/* ---- Pane config ---- */

export type PaneConfig = {
  title: string;
  icon?: LucideIcon;
  meta?: React.ReactNode;
  minimizable?: boolean;
  headerActions?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
};

/* ---- Component ---- */

export function PaneTilingLayout({
  layoutId,
  tree,
  panes,
  className
}: {
  layoutId: string;
  tree: PaneSplit;
  panes: Record<string, PaneConfig>;
  className?: string;
}) {
  const { layout, loaded, saveLayout } = useDockLayout(layoutId, {});

  /* ---- Mutable tree state (Phase D) ---- */
  const expectedPaneIds = useMemo(() => collectLeafIds(tree), [tree]);
  const [liveTree, setLiveTree] = useState<PaneSplit>(tree);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted tree on mount
  useEffect(() => {
    let cancelled = false;
    window.ade.tilingTree
      .get(layoutId)
      .then((saved) => {
        if (cancelled) return;
        if (saved && typeof saved === "object" && (saved as PaneSplit).type === "split") {
          const candidate = saved as PaneSplit;
          if (isValidTree(candidate, expectedPaneIds)) {
            setLiveTree(candidate);
          }
        }
        setTreeLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setTreeLoaded(true);
      });
    return () => { cancelled = true; };
  }, [layoutId, expectedPaneIds]);

  // Re-sync if prop tree changes shape (e.g., panes added/removed)
  useEffect(() => {
    if (!treeLoaded) return;
    if (!isValidTree(liveTree, expectedPaneIds)) {
      setLiveTree(tree);
    }
  }, [expectedPaneIds, treeLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist tree changes (debounced)
  const persistTree = useCallback(
    (next: PaneSplit) => {
      setLiveTree(next);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        window.ade.tilingTree.set(layoutId, next).catch(() => {});
      }, 300);
    },
    [layoutId]
  );

  /* ---- Minimize state (CSS-only collapse) ---- */
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});

  const toggleMinimize = useCallback((paneId: string) => {
    setMinimized((prev) => ({ ...prev, [paneId]: !prev[paneId] }));
  }, []);

  /* ---- Drag state (Phase E) ---- */
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);

  const handleDragStart = useCallback((paneId: string) => {
    setDragSourceId(paneId);
  }, []);

  const handleDragOverRaw = useCallback(
    (paneId: string, e: React.DragEvent) => {
      if (!dragSourceId || dragSourceId === paneId) return;
      setDropTargetId(paneId);

      const paneEl = (e.currentTarget as HTMLElement).closest("[data-pane-id]") as HTMLElement | null;
      if (paneEl) {
        const rect = paneEl.getBoundingClientRect();
        const edge = detectDropEdge(rect, e.clientX, e.clientY);
        setDropEdge(edge);
      }
    },
    [dragSourceId]
  );

  const handleDragEnd = useCallback(() => {
    if (dragSourceId && dropTargetId && dragSourceId !== dropTargetId && dropEdge) {
      if (dropEdge === "center") {
        // Swap panes in the tree
        const swapped = swapPanes(liveTree, dragSourceId, dropTargetId) as PaneSplit;
        persistTree(swapped);
      } else {
        // Split at edge
        const split = splitPaneAtEdge(liveTree, dropTargetId, dragSourceId, dropEdge);
        persistTree(split);
      }
    }
    setDragSourceId(null);
    setDropTargetId(null);
    setDropEdge(null);
  }, [dragSourceId, dropTargetId, dropEdge, liveTree, persistTree]);

  const handleDrop = useCallback(() => {
    // The actual operation happens in handleDragEnd
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropEdge(null);
    setDropTargetId(null);
  }, []);

  /* ---- Reset to default layout ---- */
  const resetLayout = useCallback(() => {
    setLiveTree(tree);
    window.ade.tilingTree.set(layoutId, tree).catch(() => {});
  }, [tree, layoutId]);

  /* ---- Recursive renderer ---- */

  const renderNode = (
    node: PaneLeaf | PaneSplit,
    key: string,
    depth: number
  ): React.ReactNode => {
    if (node.type === "pane") {
      const paneId = node.id;
      const config = panes[paneId];
      if (!config) return null;

      const isMinimized = minimized[paneId] ?? false;
      const currentDropEdge =
        dropTargetId === paneId && dragSourceId !== paneId ? dropEdge : null;

      return (
        <FloatingPane
          id={paneId}
          title={config.title}
          icon={config.icon}
          meta={config.meta}
          minimized={isMinimized}
          onMinimizeToggle={() => toggleMinimize(paneId)}
          minimizable={config.minimizable ?? true}
          headerActions={config.headerActions}
          bodyClassName={config.bodyClassName}
          draggable
          isDragging={dragSourceId === paneId}
          isDropTarget={dropTargetId === paneId}
          dropEdge={currentDropEdge}
          onDragStart={() => handleDragStart(paneId)}
          onDragOverRaw={(e) => handleDragOverRaw(paneId, e)}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          onDragLeave={handleDragLeave}
          className="h-full"
        >
          {config.children}
        </FloatingPane>
      );
    }

    return (
      <Group
        key={key}
        id={key}
        orientation={node.direction}
        className="h-full w-full min-h-0 min-w-0"
      >
        {node.children.map((child, idx) => {
          const childKey = `${key}:${idx}`;
          const sizeKey = `${key}:${idx}:size`;
          const savedSize =
            layout[sizeKey] != null ? Number(layout[sizeKey]) : undefined;

          return (
            <React.Fragment key={childKey}>
              <Panel
                id={childKey}
                defaultSize={savedSize ?? child.defaultSize}
                minSize={child.minSize ?? 5}
                className="min-h-0 min-w-0 overflow-hidden"
                onResize={(panelSize) => {
                  const next = panelSize.asPercentage;
                  if (!Number.isFinite(next)) return;
                  saveLayout({ ...layout, [sizeKey]: next });
                }}
              >
                {renderNode(child.node, childKey, depth + 1)}
              </Panel>
              {idx < node.children.length - 1 ? (
                <ResizeGutter
                  orientation={
                    node.direction === "horizontal" ? "vertical" : "horizontal"
                  }
                  thin
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </Group>
    );
  };

  if (!loaded || !treeLoaded) return null;

  return (
    <div className={cn("ade-tiling-surface h-full min-h-0", className)}>
      {renderNode(liveTree, layoutId, 0)}
    </div>
  );
}
