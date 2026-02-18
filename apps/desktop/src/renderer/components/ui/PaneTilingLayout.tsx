import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, type PanelImperativeHandle } from "react-resizable-panels";
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

const RESIZE_TARGET_MINIMUM_SIZE = { coarse: 37, fine: 27 } as const;
/* Direction-aware compaction: width needs more space for readable headers;
   height just needs enough for stacked header rows. */
const COMPACTED_WIDTH_PX = 180;
const COMPACTED_HEIGHT_PER_LEAF_PX = 44;
const LEAF_MINIMIZED_HEIGHT_PX = 44;
const LEAF_MINIMIZED_WIDTH_PX = 44;

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
  const splitPanelRefs = useRef<Record<string, PanelImperativeHandle | null>>({});
  const compactedSplitStateRef = useRef<Record<string, { compacted: boolean; previousSize: number | null }>>({});
  /* Leaf panel refs for individual pane minimization */
  const leafPanelRefs = useRef<Record<string, PanelImperativeHandle | null>>({});
  const leafCompactedRef = useRef<Record<string, { compacted: boolean; previousSize: number | null; parentDirection: "horizontal" | "vertical" }>>({});

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

  /* ---- Minimize state ---- */
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const toggleMinimize = useCallback((paneId: string) => {
    setMinimized((prev) => ({ ...prev, [paneId]: !(prev[paneId] ?? false) }));
  }, []);

  const resizePanelToPixels = useCallback((panelHandle: PanelImperativeHandle, targetPixels: number) => {
    const current = panelHandle.getSize();
    if (!Number.isFinite(current.asPercentage) || !Number.isFinite(current.inPixels)) return;
    if (current.asPercentage <= 0 || current.inPixels <= 0) return;
    const groupPixels = current.inPixels / (current.asPercentage / 100);
    if (!Number.isFinite(groupPixels) || groupPixels <= 0) return;
    const nextPercentage = Math.max(0.5, Math.min(99.5, (targetPixels / groupPixels) * 100));
    panelHandle.resize(nextPercentage);
  }, []);

  useEffect(() => {
    const expected = new Set(expectedPaneIds);
    setMinimized((prev) => {
      const next: Record<string, boolean> = {};
      for (const [paneId, isMinimized] of Object.entries(prev)) {
        if (expected.has(paneId)) next[paneId] = isMinimized;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [expectedPaneIds]);

  /* ---- Split compaction (all descendants minimized → collapse parent panel) ---- */
  useEffect(() => {
    const desiredCompactedState: Record<string, { shouldCompact: boolean; parentDirection: "horizontal" | "vertical"; leafCount: number }> = {};
    const liveSplitKeys = new Set<string>();

    const collectDesiredState = (node: PaneLeaf | PaneSplit, key: string) => {
      if (node.type !== "split") return;
      node.children.forEach((child, idx) => {
        const childKey = `${key}:${idx}`;
        if (child.node.type === "split") {
          liveSplitKeys.add(childKey);
          const descendantLeafIds = collectLeafIds(child.node);
          desiredCompactedState[childKey] = {
            shouldCompact:
              descendantLeafIds.length > 0 &&
              descendantLeafIds.every((leafId) => minimized[leafId] === true),
            parentDirection: node.direction,
            leafCount: descendantLeafIds.length
          };
        }
        collectDesiredState(child.node, childKey);
      });
    };

    collectDesiredState(liveTree, layoutId);

    for (const [splitKey, info] of Object.entries(desiredCompactedState)) {
      const handle = splitPanelRefs.current[splitKey];
      const tracked = compactedSplitStateRef.current[splitKey] ?? { compacted: false, previousSize: null };
      if (!handle) {
        compactedSplitStateRef.current[splitKey] = tracked;
        continue;
      }
      if (info.shouldCompact && !tracked.compacted) {
        try {
          const size = handle.getSize();
          tracked.previousSize =
            Number.isFinite(size.asPercentage) && size.asPercentage > 0 ? size.asPercentage : tracked.previousSize;
          /* Width compaction needs more space for readable headers;
             height compaction scales with how many leaf headers are stacked. */
          const targetPixels =
            info.parentDirection === "horizontal"
              ? COMPACTED_WIDTH_PX
              : Math.max(COMPACTED_HEIGHT_PER_LEAF_PX, info.leafCount * COMPACTED_HEIGHT_PER_LEAF_PX);
          resizePanelToPixels(handle, targetPixels);
          tracked.compacted = true;
        } catch {
          // Ignore transient timing errors while Group/Panel mounts.
        }
      } else if (!info.shouldCompact && tracked.compacted) {
        try {
          if (tracked.previousSize != null && Number.isFinite(tracked.previousSize)) {
            handle.resize(tracked.previousSize);
          }
        } catch {
          // Ignore transient timing errors while Group/Panel mounts.
        }
        tracked.compacted = false;
        tracked.previousSize = null;
      }
      compactedSplitStateRef.current[splitKey] = tracked;
    }

    for (const splitKey of Object.keys(splitPanelRefs.current)) {
      if (!liveSplitKeys.has(splitKey)) delete splitPanelRefs.current[splitKey];
    }
    for (const splitKey of Object.keys(compactedSplitStateRef.current)) {
      if (!liveSplitKeys.has(splitKey)) delete compactedSplitStateRef.current[splitKey];
    }
  }, [layoutId, liveTree, minimized, resizePanelToPixels]);

  /* ---- Individual leaf panel compaction (single pane minimized → shrink its panel) ---- */
  useEffect(() => {
    const leafParentDirections: Record<string, "horizontal" | "vertical"> = {};
    const collectLeafDirections = (node: PaneLeaf | PaneSplit) => {
      if (node.type !== "split") return;
      for (const child of node.children) {
        if (child.node.type === "pane") {
          leafParentDirections[child.node.id] = node.direction;
        }
        collectLeafDirections(child.node);
      }
    };
    collectLeafDirections(liveTree);

    for (const paneId of expectedPaneIds) {
      const isMin = minimized[paneId] ?? false;
      const handle = leafPanelRefs.current[paneId];
      if (!handle) continue;
      const tracked = leafCompactedRef.current[paneId] ?? { compacted: false, previousSize: null, parentDirection: "vertical" };
      const parentDir = leafParentDirections[paneId] ?? "vertical";
      tracked.parentDirection = parentDir;

      if (isMin && !tracked.compacted) {
        try {
          const size = handle.getSize();
          tracked.previousSize =
            Number.isFinite(size.asPercentage) && size.asPercentage > 0 ? size.asPercentage : tracked.previousSize;
          const targetPx = parentDir === "vertical" ? LEAF_MINIMIZED_HEIGHT_PX : LEAF_MINIMIZED_WIDTH_PX;
          resizePanelToPixels(handle, targetPx);
          tracked.compacted = true;
        } catch {
          // Ignore transient timing errors
        }
      } else if (!isMin && tracked.compacted) {
        try {
          if (tracked.previousSize != null && Number.isFinite(tracked.previousSize)) {
            handle.resize(tracked.previousSize);
          }
        } catch {
          // Ignore transient timing errors
        }
        tracked.compacted = false;
        tracked.previousSize = null;
      }
      leafCompactedRef.current[paneId] = tracked;
    }

    // Cleanup stale entries
    const expected = new Set(expectedPaneIds);
    for (const key of Object.keys(leafPanelRefs.current)) {
      if (!expected.has(key)) delete leafPanelRefs.current[key];
    }
    for (const key of Object.keys(leafCompactedRef.current)) {
      if (!expected.has(key)) delete leafCompactedRef.current[key];
    }
  }, [layoutId, liveTree, minimized, expectedPaneIds, resizePanelToPixels]);

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
          minimizeBehavior="css"
          className="h-full"
        >
          {config.children}
        </FloatingPane>
      );
    }

    return (
      <Group
        key={key}
        orientation={node.direction}
        resizeTargetMinimumSize={RESIZE_TARGET_MINIMUM_SIZE}
        className="h-full w-full min-h-0 min-w-0"
        onLayoutChanged={(nextLayout) => {
          const updates: Record<string, number> = {};
          for (let idx = 0; idx < node.children.length; idx += 1) {
            const panelId = `${key}:${idx}`;
            const panelSize = nextLayout[panelId];
            if (typeof panelSize === "number" && Number.isFinite(panelSize)) {
              updates[`${key}:${idx}:size`] = panelSize;
            }
          }
          if (Object.keys(updates).length > 0) {
            saveLayout((prev) => ({ ...prev, ...updates }));
          }
        }}
      >
        {node.children.map((child, idx) => {
          const childKey = `${key}:${idx}`;
          const sizeKey = `${key}:${idx}:size`;
          const savedSize =
            layout[sizeKey] != null ? Number(layout[sizeKey]) : undefined;
          const defaultSize = savedSize ?? child.defaultSize;
          const isSplitNode = child.node.type === "split";
          const minSize = isSplitNode ? "0.5%" : `${child.minSize ?? 5}%`;

          return (
            <React.Fragment key={childKey}>
              <Panel
                id={childKey}
                defaultSize={defaultSize != null ? `${defaultSize}%` : undefined}
                minSize={minSize}
                panelRef={(panelHandle) => {
                  if (isSplitNode) {
                    splitPanelRefs.current[childKey] = panelHandle;
                  } else if (child.node.type === "pane") {
                    leafPanelRefs.current[child.node.id] = panelHandle;
                  }
                }}
                className="min-h-0 min-w-0 overflow-hidden"
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
