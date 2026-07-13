import React, { Suspense, lazy, useState } from "react";
import { Code, Eye } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

// Same renderer the orchestration / plan.md views use (react-markdown + remark-gfm
// + rehype-raw/sanitize, styled headings/tables/code, shiki, mermaid). Lazy-loaded
// so its mermaid dependency stays out of the main bundle.
const PlanMarkdown = lazy(() =>
  import("../../../orchestration/PlanMarkdown").then((m) => ({ default: m.PlanMarkdown })),
);

type Mode = "preview" | "source";

/** Markdown viewer with a code↔preview toggle. Source uses the full code editor
 *  (editable immediately, model-backed — Cmd+S saves); preview renders the live
 *  buffer value including unsaved edits. */
export function MarkdownViewer(props: ViewerProps) {
  const { registry, tab, content } = props;
  const [mode, setModeState] = useState<Mode>(() => readViewerMode<Mode>(tab.id, "preview"));
  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };

  // Preview reflects the live model value (incl. unsaved edits) when present.
  const previewText = mode === "preview" ? registry.getValue(tab.id) ?? content.content : "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1" style={{ borderColor: COLORS.border }}>
        <ToggleButton active={mode === "preview"} onClick={() => setMode("preview")} icon={<Eye size={14} />} label="Preview" />
        <ToggleButton active={mode === "source"} onClick={() => setMode("source")} icon={<Code size={14} />} label="Source" />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {mode === "source" ? (
          <CodeViewer {...props} />
        ) : (
          <Suspense fallback={<div className="px-6 py-4 text-xs" style={{ color: COLORS.textDim }}>Rendering markdown…</div>}>
            {/* break-words so long inline code / URLs wrap to the pane instead of clipping */}
            <div className="min-w-0 break-words [&_pre]:overflow-x-auto" style={{ maxWidth: "100%" }}>
              <PlanMarkdown source={previewText} className="px-6 py-4" />
            </div>
          </Suspense>
        )}
      </div>
    </div>
  );
}

function ToggleButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
      style={{
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        background: active ? "rgba(255,255,255,0.07)" : "transparent",
      }}
    >
      {icon} {label}
    </button>
  );
}
