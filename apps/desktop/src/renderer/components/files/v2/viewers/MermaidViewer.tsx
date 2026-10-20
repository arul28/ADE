import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowsOut,
  Code,
  Copy,
  Eye,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import { showToast } from "../../../app/toast/toastStore";
import { COLORS } from "../../../lanes/laneDesignTokens";
import type { MermaidRenderResult } from "../../../shared/MermaidDiagram";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

// Mermaid is heavy, so load it only after a diagram viewer is opened.
const MermaidDiagram = lazy(() =>
  import("../../../shared/MermaidDiagram").then((module) => ({
    default: module.MermaidDiagram,
  })),
);

type Mode = "diagram" | "source";

/** Toolbar for diagram navigation, source access, and copy actions. */
function MermaidToolbar({
  mode,
  setMode,
  zoom,
  onFit,
  onZoom,
  onCopySvg,
  onCopySource,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  zoom: number;
  onFit: () => void;
  onZoom: (factor: number) => void;
  onCopySvg: () => void;
  onCopySource: () => void;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1"
      style={{ borderColor: COLORS.border }}
    >
      <ViewerModeToggleButton
        active={mode === "diagram"}
        onClick={() => setMode("diagram")}
        icon={<Eye size={14} />}
        label="Diagram"
      />
      <ViewerModeToggleButton
        active={mode === "source"}
        onClick={() => setMode("source")}
        icon={<Code size={14} />}
        label="Source"
      />
      {mode === "diagram" ? (
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="Fit diagram to view"
            aria-label="Fit diagram to view"
            onClick={onFit}
            className="rounded p-1 hover:bg-fg/5"
          >
            <ArrowsOut size={15} />
          </button>
          <button
            type="button"
            title="100%"
            aria-label="100%"
            onClick={() => onZoom(1 / zoom)}
            className="rounded p-1 hover:bg-fg/5"
          >
            <span className="text-xs">100%</span>
          </button>
          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => onZoom(1 / 1.2)}
            className="rounded p-1 hover:bg-fg/5"
          >
            <MagnifyingGlassMinus size={15} />
          </button>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => onZoom(1.2)}
            className="rounded p-1 hover:bg-fg/5"
          >
            <MagnifyingGlassPlus size={15} />
          </button>
          <button
            type="button"
            title="Copy SVG"
            aria-label="Copy SVG"
            onClick={onCopySvg}
            className="rounded p-1 hover:bg-fg/5"
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            title="Copy source"
            aria-label="Copy source"
            onClick={onCopySource}
            className="rounded p-1 hover:bg-fg/5"
          >
            <Code size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Shows a structured Mermaid failure and offers a direct switch to editable source. */
function MermaidErrorCard({
  error,
  onEditSource,
}: {
  error: Extract<MermaidRenderResult, { ok: false }> | null;
  onEditSource: () => void;
}) {
  if (!error) return null;
  return (
    <div
      className="absolute inset-x-3 top-3 rounded-md border p-3 shadow-sm"
      style={{
        borderColor: COLORS.border,
        background: "var(--color-bg)",
        color: COLORS.textPrimary,
      }}
      role="alert"
    >
      <div className="text-sm font-medium">Diagram couldn’t be rendered</div>
      <div
        className="mt-1 break-words text-xs"
        style={{ color: COLORS.textMuted }}
      >
        {error.message}
        {error.line ? ` (line ${error.line})` : ""}
      </div>
      <button
        type="button"
        onClick={onEditSource}
        className="mt-2 rounded px-2 py-1 text-xs hover:bg-fg/5"
      >
        Edit source
      </button>
    </div>
  );
}

/** Mermaid viewer with editable source, remembered mode, pan, and zoom. */
export function MermaidViewer(props: ViewerProps) {
  const { registry, tab, content } = props;
  const [mode, setModeState] = useState<Mode>(() =>
    readViewerMode<Mode>(tab.id, "diagram"),
  );
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [liveText, setLiveText] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [error, setError] = useState<Extract<
    MermaidRenderResult,
    { ok: false }
  > | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  const dirty = mode === "diagram" && registry.isDirty(tab.id);

  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    if (next === "diagram") {
      setLiveText(registry.isDirty(tab.id) ? registry.getValue(tab.id) : null);
    } else {
      setLiveText(null);
    }
    setModeState(next);
  };

  // Match Markdown's dirty-model policy: use the authoritative payload while
  // clean, and read the parked Monaco buffer when returning to Diagram mode.
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(
      () => setLiveText(registry.getValue(tab.id)),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [dirty, registry, tab.id]);

  const source = liveText ?? content.content;
  const transform = useMemo(
    () => `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
    [offset.x, offset.y, zoom],
  );
  const handleRenderResult = useCallback((result: MermaidRenderResult) => {
    if (result.ok) {
      setRenderedSvg(result.svg);
      setError(null);
    } else {
      setError(result);
    }
  }, []);

  useEffect(() => {
    setError(null);
  }, [source]);

  const copyText = async (value: string, title: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      showToast({
        title,
        message: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    }
  };

  const copySvg = () => {
    if (renderedSvg) void copyText(renderedSvg, "Could not copy SVG");
  };

  const panStart = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const panMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.ox + event.clientX - drag.x,
      y: drag.oy + event.clientY - drag.y,
    });
  };

  const zoomBy = (factor: number) => {
    setZoom((value) => Math.min(8, Math.max(0.1, value * factor)));
  };

  const fitDiagram = () => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector("svg");
    if (!viewport || !svg) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const box = svg.getBoundingClientRect();
    const width = box.width / zoom;
    const height = box.height / zoom;
    if (width <= 0 || height <= 0) return;
    const availableWidth = Math.max(1, viewport.clientWidth - 32);
    const availableHeight = Math.max(1, viewport.clientHeight - 32);
    const fitScale = Math.min(
      availableWidth / width,
      availableHeight / height,
      8,
    );
    setZoom(Math.max(0.1, fitScale));
    setOffset({ x: 0, y: 0 });
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <MermaidToolbar
        mode={mode}
        setMode={setMode}
        zoom={zoom}
        onFit={fitDiagram}
        onZoom={zoomBy}
        onCopySvg={copySvg}
        onCopySource={() => void copyText(source, "Could not copy source")}
      />
      {mode === "source" ? (
        <CodeViewer
          {...props}
          onDirtyChange={(tabId, isDirty) =>
            props.onDirtyChange?.(tabId, isDirty)
          }
        />
      ) : (
        <div
          ref={viewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto"
          onWheel={onWheel}
          onPointerDown={panStart}
          onPointerMove={panMove}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        >
          {!source.trim() ? (
            <div
              className="flex h-full items-center justify-center px-6 text-center text-sm"
              style={{ color: COLORS.textDim }}
            >
              This Mermaid file is empty. Add diagram source to preview it.
            </div>
          ) : (
            <div className="min-h-full min-w-full" style={{ cursor: "grab" }}>
              <div style={{ transform, transformOrigin: "center center" }}>
                <Suspense
                  fallback={
                    <div
                      className="px-6 py-4 text-xs"
                      style={{ color: COLORS.textDim }}
                    >
                      Loading diagram renderer…
                    </div>
                  }
                >
                  <MermaidDiagram
                    source={source}
                    variant="file"
                    renderCode={() => null}
                    onRenderResult={handleRenderResult}
                  />
                </Suspense>
              </div>
            </div>
          )}
          <MermaidErrorCard
            error={error}
            onEditSource={() => setMode("source")}
          />
        </div>
      )}
    </div>
  );
}
