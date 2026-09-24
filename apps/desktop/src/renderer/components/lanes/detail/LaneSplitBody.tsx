import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const STORAGE_KEY = "ade.lanes.gitColumnWidth";
const MIN_GIT_WIDTH = 420;
const MAX_GIT_WIDTH = 760;
const DEFAULT_GIT_FRACTION = 0.44;
/** The dashboard keeps at least this much room when the window is narrow. */
const MIN_DASHBOARD_WIDTH = 440;
const KEY_STEP = 24;

/** The Git column's width for a container, kept inside 420-760px and off the dashboard's floor. */
export function clampGitColumnWidth(width: number, containerWidth: number): number {
  const max = Math.min(MAX_GIT_WIDTH, Math.max(MIN_GIT_WIDTH, containerWidth - MIN_DASHBOARD_WIDTH));
  return Math.round(Math.min(max, Math.max(MIN_GIT_WIDTH, width)));
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(width: number | null): void {
  try {
    if (width == null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Private storage can refuse writes; the width then lasts for the session.
  }
}

/**
 * The Lanes main area: the dashboard on the left, the Git pane on the right,
 * with a hairline splitter between them. The Git column's width is saved
 * across launches; double-click the splitter to go back to the default.
 */
export function LaneSplitBody({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [storedWidth, setStoredWidth] = useState<number | null>(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragEndRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    // CSS px, not screen px: the app zoom scales bounding rects but not layout widths.
    setContainerWidth(node.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A drag in progress when the page unmounts must not leave listeners behind.
  useEffect(() => () => dragEndRef.current?.(), []);

  const width = containerWidth > 0
    ? clampGitColumnWidth(storedWidth ?? containerWidth * DEFAULT_GIT_FRACTION, containerWidth)
    : null;

  const commitWidth = useCallback((next: number | null) => {
    setStoredWidth(next);
    writeStoredWidth(next);
  }, []);

  const onMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || width == null) return;
    event.preventDefault();
    dragEndRef.current?.();
    const startX = event.clientX;
    const startWidth = width;
    // Mouse moves arrive in screen px; the app zoom makes those differ from CSS px.
    const container = containerRef.current;
    const scale = container && container.offsetWidth > 0
      ? container.getBoundingClientRect().width / container.offsetWidth
      : 1;
    const total = containerWidth;
    let pending = startWidth;
    let frame: number | null = null;
    const apply = () => {
      frame = null;
      if (rightRef.current) rightRef.current.style.width = `${pending}px`;
    };
    const onMove = (moveEvent: MouseEvent) => {
      // Dragging left makes the Git column wider.
      pending = clampGitColumnWidth(startWidth + (startX - moveEvent.clientX) / scale, total);
      if (frame == null) frame = window.requestAnimationFrame(apply);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey, true);
      if (frame != null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragEndRef.current = null;
      setDragging(false);
      if (commit) commitWidth(pending);
      else if (rightRef.current) rightRef.current.style.width = `${startWidth}px`;
    };
    const onUp = () => finish(true);
    // Escape puts the column back where the drag started.
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey, true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    dragEndRef.current = () => finish(false);
    setDragging(true);
  }, [commitWidth, containerWidth, width]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (width == null) return;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + KEY_STEP;
    else if (event.key === "ArrowRight") next = width - KEY_STEP;
    else if (event.key === "Home") next = MAX_GIT_WIDTH;
    else if (event.key === "End") next = MIN_GIT_WIDTH;
    if (next == null) return;
    event.preventDefault();
    commitWidth(clampGitColumnWidth(next, containerWidth));
  }, [commitWidth, containerWidth, width]);

  return (
    <div ref={containerRef} className="ade-lanes-split flex min-h-0 min-w-0 flex-1" data-testid="lane-split-body">
      <div className="min-h-0 min-w-0 flex-1">{left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Git pane"
        aria-valuenow={width ?? undefined}
        aria-valuemin={MIN_GIT_WIDTH}
        aria-valuemax={MAX_GIT_WIDTH}
        tabIndex={0}
        data-testid="lane-split-gutter"
        data-resize-handle-active={dragging ? "" : undefined}
        title="Drag to resize. Double-click to reset."
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commitWidth(null)}
        className="ade-pane-gutter ade-tool-gutter vertical shrink-0"
      />
      <div
        ref={rightRef}
        data-testid="lane-git-column"
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{
          width: width ?? `${DEFAULT_GIT_FRACTION * 100}%`,
          minWidth: MIN_GIT_WIDTH,
          maxWidth: MAX_GIT_WIDTH,
          borderLeft: "1px solid var(--ade-work-chrome-rail-border, var(--color-border))",
        }}
      >
        {right}
      </div>
    </div>
  );
}
