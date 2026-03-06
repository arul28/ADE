import React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretLeft,
  CaretRight,
  FolderOpen,
  GitBranch,
  Stack,
  FileCode,
  Terminal,
  Compass
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { sortLanesForStackGraph } from "../lanes/laneUtils";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { LaneStackPane } from "../lanes/LaneStackPane";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneWorkPane } from "../lanes/LaneWorkPane";
import { LaneInspectorPane } from "../lanes/LaneInspectorPane";
import { FloatingFilesWorkspace } from "./FloatingFilesWorkspace";
import type { GitCommitSummary } from "../../../shared/types";

type RootBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type PaneRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type ResizeState = {
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startRect: PaneRect;
};

type DragState = {
  startX: number;
  startY: number;
  startRect: PaneRect;
};

type LauncherDragState = {
  startY: number;
  startAnchorY: number;
  moved: boolean;
};

type LaneRuntimeBucket = "running" | "awaiting-input" | "ended" | "none";
type LaneRuntimeMap = Map<string, { bucket: LaneRuntimeBucket }>;

type WorkspaceView = "git" | "files" | "stack" | "diff" | "work" | "inspector";

const EDGE_HOTSPOT_PX = 22;
const LAUNCHER_SAFE_MARGIN = 28;
const PANE_MARGIN = 10;
const MIN_WIDTH = 340;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 920;

const LAUNCHER_RATIO_STORAGE_KEY = "ade:right-pane:launcher-ratio:v1";
const PANE_RECT_STORAGE_KEY = "ade:right-pane:rect:v1";

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "n", className: "dir-n" },
  { direction: "s", className: "dir-s" },
  { direction: "e", className: "dir-e" },
  { direction: "w", className: "dir-w" },
  { direction: "ne", className: "dir-ne" },
  { direction: "nw", className: "dir-nw" },
  { direction: "se", className: "dir-se" },
  { direction: "sw", className: "dir-sw" }
];

const WORKSPACE_VIEWS: Array<{
  id: WorkspaceView;
  label: string;
  Icon: typeof GitBranch;
}> = [
  { id: "git", label: "Git", Icon: GitBranch },
  { id: "files", label: "Files", Icon: FolderOpen },
  { id: "stack", label: "Stack", Icon: Stack },
  { id: "diff", label: "Diff", Icon: FileCode },
  { id: "work", label: "Work", Icon: Terminal },
  { id: "inspector", label: "Inspect", Icon: Compass }
];

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

function getPaneLimits(bounds: RootBounds) {
  const maxWidth = Math.max(220, Math.min(MAX_WIDTH, bounds.width - PANE_MARGIN * 2));
  const maxHeight = Math.max(180, bounds.height - PANE_MARGIN * 2);
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_HEIGHT, maxHeight);
  return {
    maxWidth,
    maxHeight,
    minWidth,
    minHeight,
    minLeft: PANE_MARGIN,
    minTop: PANE_MARGIN,
    maxRight: bounds.width - PANE_MARGIN,
    maxBottom: bounds.height - PANE_MARGIN
  };
}

function readLauncherRatio(): number {
  try {
    const raw = window.localStorage.getItem(LAUNCHER_RATIO_STORAGE_KEY);
    if (!raw) return 0.5;
    const parsed = Number(raw);
    return clamp(parsed, 0, 1);
  } catch {
    return 0.5;
  }
}

function writeLauncherRatio(value: number): void {
  try {
    window.localStorage.setItem(LAUNCHER_RATIO_STORAGE_KEY, String(clamp(value, 0, 1)));
  } catch {
    // ignore localStorage write failures
  }
}

function readPaneRect(): PaneRect | null {
  try {
    const raw = window.localStorage.getItem(PANE_RECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PaneRect>;
    if (
      typeof parsed.x !== "number" ||
      typeof parsed.y !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return null;
    }
    return {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height
    };
  } catch {
    return null;
  }
}

function writePaneRect(rect: PaneRect): void {
  try {
    window.localStorage.setItem(PANE_RECT_STORAGE_KEY, JSON.stringify(rect));
  } catch {
    // ignore localStorage write failures
  }
}

function clampPaneRect(rect: PaneRect, bounds: RootBounds): PaneRect {
  const limits = getPaneLimits(bounds);
  const width = clamp(rect.width, limits.minWidth, limits.maxWidth);
  const height = clamp(rect.height, limits.minHeight, limits.maxHeight);
  const x = clamp(rect.x, limits.minLeft, bounds.width - width - PANE_MARGIN);
  const y = clamp(rect.y, limits.minTop, bounds.height - height - PANE_MARGIN);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function buildDefaultPaneRect(bounds: RootBounds, launcherRatio: number): PaneRect {
  const limits = getPaneLimits(bounds);
  const width = clamp(Math.round(bounds.width * 0.38), limits.minWidth, limits.maxWidth);
  const height = limits.maxHeight;
  const x = bounds.width - width - PANE_MARGIN;
  const y = clamp(PANE_MARGIN, PANE_MARGIN, bounds.height - height - PANE_MARGIN);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width,
    height
  };
}

function resizePaneRect(
  state: ResizeState,
  bounds: RootBounds,
  nextClientX: number,
  nextClientY: number
): PaneRect {
  const limits = getPaneLimits(bounds);
  const dx = nextClientX - state.startX;
  const dy = nextClientY - state.startY;

  const startLeft = state.startRect.x;
  const startTop = state.startRect.y;
  const startRight = state.startRect.x + state.startRect.width;
  const startBottom = state.startRect.y + state.startRect.height;

  let left = startLeft;
  let top = startTop;
  let right = startRight;
  let bottom = startBottom;

  if (state.direction.includes("w")) {
    left = clamp(startLeft + dx, limits.minLeft, startRight - limits.minWidth);
  }
  if (state.direction.includes("e")) {
    right = clamp(startRight + dx, startLeft + limits.minWidth, limits.maxRight);
  }
  if (state.direction.includes("n")) {
    top = clamp(startTop + dy, limits.minTop, startBottom - limits.minHeight);
  }
  if (state.direction.includes("s")) {
    bottom = clamp(startBottom + dy, startTop + limits.minHeight, limits.maxBottom);
  }

  let width = clamp(right - left, limits.minWidth, limits.maxWidth);
  let height = clamp(bottom - top, limits.minHeight, limits.maxHeight);

  if (state.direction.includes("w") && !state.direction.includes("e")) {
    left = right - width;
  } else {
    right = left + width;
  }

  if (state.direction.includes("n") && !state.direction.includes("s")) {
    top = bottom - height;
  } else {
    bottom = top + height;
  }

  left = clamp(left, limits.minLeft, limits.maxRight - width);
  top = clamp(top, limits.minTop, limits.maxBottom - height);

  width = clamp(width, limits.minWidth, limits.maxWidth);
  height = clamp(height, limits.minHeight, limits.maxHeight);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  };
}

export function RightEdgeFloatingPane() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const boundsRef = React.useRef<RootBounds | null>(null);
  const launcherDragRef = React.useRef<LauncherDragState | null>(null);
  const launcherRatioRef = React.useRef(0.5);

  const [bounds, setBounds] = React.useState<RootBounds | null>(null);
  const [paneRect, setPaneRect] = React.useState<PaneRect | null>(() => readPaneRect());
  const [paneOpen, setPaneOpen] = React.useState(false);
  const [edgeHot, setEdgeHot] = React.useState(false);
  const [launcherHovered, setLauncherHovered] = React.useState(false);
  const [launcherDragging, setLauncherDragging] = React.useState(false);
  const [dragging, setDragging] = React.useState<DragState | null>(null);
  const [resizing, setResizing] = React.useState<ResizeState | null>(null);
  const [launcherRatio, setLauncherRatio] = React.useState(() => readLauncherRatio());
  const [workspaceView, setWorkspaceView] = React.useState<WorkspaceView>("git");

  const [activeLaneId, setActiveLaneId] = React.useState<string | null>(selectedLaneId ?? null);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [selectedMode, setSelectedMode] = React.useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = React.useState<GitCommitSummary | null>(null);

  const sortedLanes = React.useMemo(() => sortLanesForStackGraph(lanes), [lanes]);
  const runtimeByLaneId = React.useMemo<LaneRuntimeMap>(() => {
    const map: LaneRuntimeMap = new Map();
    for (const lane of sortedLanes) {
      map.set(lane.id, { bucket: "none" });
    }
    return map;
  }, [sortedLanes]);

  React.useEffect(() => {
    launcherRatioRef.current = launcherRatio;
    writeLauncherRatio(launcherRatio);
  }, [launcherRatio]);

  React.useEffect(() => {
    if (!paneRect) return;
    writePaneRect(paneRect);
  }, [paneRect]);

  React.useEffect(() => {
    const hasActive = activeLaneId ? lanes.some((lane) => lane.id === activeLaneId) : false;
    if (hasActive) return;

    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) {
      setActiveLaneId(selectedLaneId);
      return;
    }

    setActiveLaneId(lanes[0]?.id ?? null);
  }, [activeLaneId, lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) return;
    if (!lanes.some((lane) => lane.id === selectedLaneId)) return;
    setActiveLaneId((current) => (current === selectedLaneId ? current : selectedLaneId));
  }, [selectedLaneId, lanes]);

  React.useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    const syncBounds = () => {
      const rect = node.getBoundingClientRect();
      const nextBounds: RootBounds = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
      boundsRef.current = nextBounds;
      setBounds(nextBounds);
    };

    syncBounds();

    const observer = new ResizeObserver(() => {
      syncBounds();
    });

    observer.observe(node);
    window.addEventListener("resize", syncBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, []);

  React.useEffect(() => {
    if (!bounds) return;
    setPaneRect((current) => {
      if (!current) return current;
      return clampPaneRect(current, bounds);
    });
  }, [bounds]);

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const nextBounds = boundsRef.current;
      if (!nextBounds) return;
      if (launcherDragging || dragging || resizing) return;

      const withinX = event.clientX >= nextBounds.left && event.clientX <= nextBounds.right;
      const withinY = event.clientY >= nextBounds.top && event.clientY <= nextBounds.bottom;
      const nearRightEdge =
        withinX && withinY && nextBounds.right - event.clientX <= EDGE_HOTSPOT_PX && nextBounds.right - event.clientX >= 0;
      setEdgeHot((current) => (current === nearRightEdge ? current : nearRightEdge));
    };

    const onWindowBlur = () => {
      setEdgeHot(false);
      setLauncherHovered(false);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [launcherDragging, dragging, resizing]);

  React.useEffect(() => {
    if (!resizing) return;

    const onPointerMove = (event: PointerEvent) => {
      const nextBounds = boundsRef.current;
      if (!nextBounds) return;
      setPaneRect(resizePaneRect(resizing, nextBounds, event.clientX, event.clientY));
    };

    const stopResize = () => {
      setResizing(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [resizing]);

  React.useEffect(() => {
    if (!dragging) return;

    const onPointerMove = (event: PointerEvent) => {
      const nextBounds = boundsRef.current;
      if (!nextBounds) return;
      const dx = event.clientX - dragging.startX;
      const dy = event.clientY - dragging.startY;
      const moved: PaneRect = {
        x: dragging.startRect.x + dx,
        y: dragging.startRect.y + dy,
        width: dragging.startRect.width,
        height: dragging.startRect.height
      };
      setPaneRect(clampPaneRect(moved, nextBounds));
    };

    const stopDrag = () => {
      setDragging(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [dragging]);

  React.useEffect(() => {
    if (!launcherDragging) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = launcherDragRef.current;
      const nextBounds = boundsRef.current;
      if (!drag || !nextBounds) return;

      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(deltaY) > 4) {
        drag.moved = true;
      }

      const anchorY = clamp(
        drag.startAnchorY + deltaY,
        LAUNCHER_SAFE_MARGIN,
        Math.max(LAUNCHER_SAFE_MARGIN, nextBounds.height - LAUNCHER_SAFE_MARGIN)
      );
      setLauncherRatio(clamp(anchorY / nextBounds.height, 0, 1));
    };

    const onPointerUp = () => {
      const drag = launcherDragRef.current;
      launcherDragRef.current = null;
      setLauncherDragging(false);
      if (drag && !drag.moved) {
        setPaneOpen(true);
        setPaneRect((current) => {
          const nextBounds = boundsRef.current;
          if (!nextBounds) return current;
          const base = current ?? buildDefaultPaneRect(nextBounds, launcherRatioRef.current);
          return clampPaneRect(base, nextBounds);
        });
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [launcherDragging]);

  React.useEffect(() => {
    if (!paneOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPaneOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [paneOpen]);

  React.useEffect(() => {
    if (!launcherDragging && !dragging && !resizing) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = resizing ? "grabbing" : launcherDragging ? "ns-resize" : "grabbing";
    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [launcherDragging, dragging, resizing]);

  const launcherTop = React.useMemo(() => {
    if (!bounds) return 120;
    return clamp(
      bounds.height * launcherRatio,
      LAUNCHER_SAFE_MARGIN,
      Math.max(LAUNCHER_SAFE_MARGIN, bounds.height - LAUNCHER_SAFE_MARGIN)
    );
  }, [bounds, launcherRatio]);

  const launcherVisible = !paneOpen && (edgeHot || launcherHovered || launcherDragging);

  const startLauncherDrag = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const nextBounds = boundsRef.current;
      if (!nextBounds) return;
      event.preventDefault();
      event.stopPropagation();

      launcherDragRef.current = {
        startY: event.clientY,
        startAnchorY: clamp(
          nextBounds.height * launcherRatioRef.current,
          LAUNCHER_SAFE_MARGIN,
          Math.max(LAUNCHER_SAFE_MARGIN, nextBounds.height - LAUNCHER_SAFE_MARGIN)
        ),
        moved: false
      };
      setLauncherDragging(true);
    },
    []
  );

  const beginResize = React.useCallback(
    (direction: ResizeDirection, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const currentRect = paneRect;
      if (!currentRect) return;
      event.preventDefault();
      event.stopPropagation();
      setResizing({
        direction,
        startX: event.clientX,
        startY: event.clientY,
        startRect: currentRect
      });
    },
    [paneRect]
  );

  const startPaneDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-pane-control='true']")) return;
      const currentRect = paneRect;
      if (!currentRect) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging({
        startX: event.clientX,
        startY: event.clientY,
        startRect: currentRect
      });
    },
    [paneRect]
  );

  const hidePane = React.useCallback(() => {
    setPaneOpen(false);
  }, []);

  const handleSelectLane = React.useCallback(
    (laneId: string) => {
      setActiveLaneId(laneId);
      selectLane(laneId);
    },
    [selectLane]
  );

  const handleSelectFile = React.useCallback((path: string, mode: "staged" | "unstaged") => {
    setSelectedPath(path);
    setSelectedMode(mode);
    setSelectedCommit(null);
    setWorkspaceView("diff");
  }, []);

  const handleSelectCommit = React.useCallback((commit: GitCommitSummary | null) => {
    setSelectedCommit(commit);
    if (commit) {
      setSelectedPath(null);
      setSelectedMode(null);
      setWorkspaceView("diff");
    }
  }, []);

  const paneStyle = React.useMemo<React.CSSProperties>(() => {
    if (!paneRect) return {};
    return {
      left: paneRect.x,
      top: paneRect.y,
      width: paneRect.width,
      height: paneRect.height
    };
  }, [paneRect]);

  const workspaceContent = React.useMemo(() => {
    if (!activeLaneId) {
      return (
        <div className="ade-right-pane-empty-state">
          Open a project lane to use the floating workspace.
        </div>
      );
    }

    if (workspaceView === "git") {
      return (
        <LaneGitActionsPane
          laneId={activeLaneId}
          autoRebaseEnabled={false}
          onOpenSettings={() => navigate("/settings?tab=automations")}
          onSelectFile={handleSelectFile}
          onSelectCommit={handleSelectCommit}
          selectedPath={selectedPath}
          selectedMode={selectedMode}
          selectedCommitSha={selectedCommit?.sha ?? null}
        />
      );
    }

    if (workspaceView === "stack") {
      return (
        <LaneStackPane
          lanes={sortedLanes}
          selectedLaneId={activeLaneId}
          onSelect={handleSelectLane}
          runtimeByLaneId={runtimeByLaneId}
        />
      );
    }

    if (workspaceView === "diff") {
      return (
        <LaneDiffPane
          laneId={activeLaneId}
          selectedPath={selectedPath}
          selectedFileMode={selectedMode}
          selectedCommit={selectedCommit}
          liveSync
        />
      );
    }

    if (workspaceView === "files") {
      return <FloatingFilesWorkspace preferredLaneId={activeLaneId} />;
    }

    if (workspaceView === "work") {
      return <LaneWorkPane laneId={activeLaneId} />;
    }

    return <LaneInspectorPane laneId={activeLaneId} />;
  }, [
    activeLaneId,
    workspaceView,
    navigate,
    handleSelectFile,
    handleSelectCommit,
    selectedPath,
    selectedMode,
    selectedCommit,
    sortedLanes,
    handleSelectLane,
    runtimeByLaneId
  ]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[86]" aria-hidden={false}>
      <AnimatePresence>
        {launcherVisible ? (
          <motion.button
            key="ade-right-pane-launcher"
            type="button"
            className={cn("ade-right-pane-launcher pointer-events-auto", launcherDragging && "dragging")}
            style={{ top: launcherTop }}
            initial={{ x: 12, opacity: 0, scale: 0.95 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: 14, opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ scale: 1.02, width: 56 }}
            whileTap={{ scale: 0.98 }}
            onPointerDown={startLauncherDrag}
            onMouseEnter={() => setLauncherHovered(true)}
            onMouseLeave={() => setLauncherHovered(false)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setPaneOpen(true);
              setPaneRect((current) => {
                const nextBounds = boundsRef.current;
                if (!nextBounds) return current;
                const base = current ?? buildDefaultPaneRect(nextBounds, launcherRatioRef.current);
                return clampPaneRect(base, nextBounds);
              });
            }}
            title="Open floating workspace"
            aria-label="Open floating workspace"
          >
            <CaretLeft size={13} weight="bold" />
          </motion.button>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {paneOpen && paneRect ? (
          <motion.section
            key="ade-right-floating-pane"
            className={cn("ade-right-floating-pane pointer-events-auto", dragging && "dragging")}
            style={paneStyle}
            initial={{ opacity: 0, x: 24, scale: 0.985 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 32, scale: 0.985 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="ade-right-floating-pane-toolbar" onPointerDown={startPaneDrag}>
              <div className="ade-right-pane-toolbar-left">
                <select
                  className="ade-right-pane-lane-select"
                  value={activeLaneId ?? ""}
                  onChange={(event) => handleSelectLane(event.target.value)}
                  disabled={sortedLanes.length === 0}
                  title="Choose lane"
                  data-pane-control="true"
                >
                  {sortedLanes.length === 0 ? <option value="">No lanes</option> : null}
                  {sortedLanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>
                      {lane.name}
                    </option>
                  ))}
                </select>

                <div className="ade-right-pane-view-tabs" role="tablist" aria-label="Floating workspace views">
                  {WORKSPACE_VIEWS.map((view) => {
                    const Icon = view.Icon;
                    const active = workspaceView === view.id;
                    return (
                      <button
                        key={view.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={cn("ade-right-pane-view-tab", active && "active")}
                        onClick={() => setWorkspaceView(view.id)}
                        title={view.label}
                        data-pane-control="true"
                      >
                        <Icon size={12} weight={active ? "bold" : "regular"} />
                        <span>{view.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="ade-right-pane-toolbar-right">
                <button
                  type="button"
                  className="ade-right-floating-pane-hide"
                  onClick={hidePane}
                  title="Hide pane"
                  aria-label="Hide pane"
                  data-pane-control="true"
                >
                  <CaretRight size={14} weight="bold" />
                </button>
              </div>
            </div>

            <div className="ade-right-pane-workspace">{workspaceContent}</div>

            {RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.direction}
                className={cn("ade-right-pane-resize-handle", handle.className)}
                onPointerDown={(event) => beginResize(handle.direction, event)}
              />
            ))}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
