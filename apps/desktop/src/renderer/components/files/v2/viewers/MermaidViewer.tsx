import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Code, Copy, Eye } from "@phosphor-icons/react";
import { showToast } from "../../../app/toast/toastStore";
import { COLORS } from "../../../lanes/laneDesignTokens";
import type { MermaidRenderResult } from "../../../shared/MermaidDiagram";
import { Banner } from "../../../ui/notice";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { usePanZoom } from "./usePanZoom";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { ZoomControls } from "./ZoomControls";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

// Mermaid is heavy, so load it only after a diagram viewer is opened.
const MermaidDiagram = lazy(() =>
  import("../../../shared/MermaidDiagram").then((module) => ({
    default: module.MermaidDiagram,
  })),
);

type Mode = "diagram" | "source";
type MermaidFailure = Extract<MermaidRenderResult, { ok: false }>;

/** Mermaid's parse errors name the line in a few shapes ("line 3", "(line 3"). */
function errorLine(message: string): number | null {
  const match = message.match(/(?:line\s*[:=]?\s*|\(line\s+)(\d+)/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/** Toolbar for diagram navigation, source access, and copy actions. */
function MermaidToolbar({
  mode,
  setMode,
  zoom,
  onFit,
  onZoomIn,
  onZoomOut,
  onActualSize,
  onCopySvg,
  onCopySource,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  zoom: number;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onActualSize: () => void;
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
          <ZoomControls
            percent={zoom * 100}
            onZoomOut={onZoomOut}
            onZoomIn={onZoomIn}
            onFit={onFit}
          />
          <button
            type="button"
            title="Actual size (100%)"
            aria-label="Actual size (100%)"
            onClick={onActualSize}
            className="rounded p-1 hover:bg-fg/5"
          >
            <span className="text-xs">1:1</span>
          </button>
          <button
            type="button"
            title="Copy SVG"
            aria-label="Copy SVG"
            onClick={onCopySvg}
            className="rounded p-1 hover:bg-fg/5"
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            title="Copy source"
            aria-label="Copy source"
            onClick={onCopySource}
            className="rounded p-1 hover:bg-fg/5"
          >
            <Code size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Shows a Mermaid failure over the diagram, with a direct switch to editable source. */
function MermaidErrorBanner({
  error,
  onEditSource,
  onRetry,
}: {
  error: MermaidFailure;
  onEditSource: () => void;
  onRetry: () => void;
}) {
  const line = errorLine(error.error);
  return (
    <div className="absolute inset-x-3 top-3">
      <Banner
        layout="inline"
        model={{
          id: "mermaid-render-error",
          tone: "error",
          title:
            error.kind === "load"
              ? "Couldn't load the diagram renderer"
              : "Diagram couldn’t be rendered",
          detail: `${error.error}${line ? ` (line ${line})` : ""}`,
          actions:
            error.kind === "load"
              ? [{ label: "Retry", onClick: onRetry }]
              : [{ label: "Edit source", onClick: onEditSource }],
        }}
      />
    </div>
  );
}

/** Mermaid viewer with editable source, remembered mode, pan, and zoom. */
export function MermaidViewer(props: ViewerProps) {
  const { registry, tab, content } = props;
  const [mode, setModeState] = useState<Mode>(() =>
    readViewerMode<Mode>(tab.id, "diagram"),
  );
  const view = usePanZoom({ initialFit: false });
  const [liveText, setLiveText] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [error, setError] = useState<MermaidFailure | null>(null);
  // Bumped by Retry: remounting the diagram re-runs a failed renderer import.
  const [renderAttempt, setRenderAttempt] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
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

  const fitDiagram = () => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector("svg");
    if (!viewport || !svg) {
      view.setView(1);
      return;
    }
    const box = svg.getBoundingClientRect();
    const width = box.width / view.scale;
    const height = box.height / view.scale;
    if (width <= 0 || height <= 0) return;
    const availableWidth = Math.max(1, viewport.clientWidth - 32);
    const availableHeight = Math.max(1, viewport.clientHeight - 32);
    view.setView(Math.min(availableWidth / width, availableHeight / height));
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <MermaidToolbar
        mode={mode}
        setMode={setMode}
        zoom={view.scale}
        onFit={fitDiagram}
        onZoomIn={view.zoomIn}
        onZoomOut={view.zoomOut}
        onActualSize={() => view.setView(1)}
        onCopySvg={copySvg}
        onCopySource={() => void copyText(source, "Could not copy source")}
      />
      {mode === "source" ? (
        <CodeViewer {...props} />
      ) : (
        <div
          ref={viewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto"
          {...view.panHandlers}
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
              <div
                style={{
                  transform: view.transform,
                  transformOrigin: "center center",
                }}
              >
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
                    key={renderAttempt}
                    source={source}
                    variant="file"
                    renderCode={() => null}
                    keepLastGood
                    onRenderResult={handleRenderResult}
                  />
                </Suspense>
              </div>
            </div>
          )}
          {error ? (
            <MermaidErrorBanner
              error={error}
              onEditSource={() => setMode("source")}
              onRetry={() => {
                setError(null);
                setRenderAttempt((value) => value + 1);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
