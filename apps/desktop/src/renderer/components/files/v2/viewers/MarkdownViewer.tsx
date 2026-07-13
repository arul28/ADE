import React, { Suspense, lazy, useState } from "react";
import { Code, Eye } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

// Same renderer the orchestration / plan.md views use (react-markdown + remark-gfm
// + rehype-raw/sanitize, styled headings/tables/code, shiki, mermaid). Lazy-loaded
// so its mermaid dependency stays out of the main bundle.
const PlanMarkdown = lazy(() =>
  import("../../../orchestration/PlanMarkdown").then((m) => ({ default: m.PlanMarkdown })),
);

type Mode = "preview" | "source";

/** Markdown viewer with a code↔preview toggle. Source uses the full code editor
 *  (editable immediately, model-backed — Cmd+S saves); preview renders unsaved
 *  edits when the buffer is dirty, else the authoritative file payload. */
export function MarkdownViewer(props: ViewerProps) {
  const { registry, tab, content } = props;
  const [mode, setModeState] = useState<Mode>(() => readViewerMode<Mode>(tab.id, "preview"));
  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };

  // Preview shows unsaved edits from a dirty model; a clean model is ignored
  // because external edits reload `content`, not the parked model, so a clean
  // model may be stale.
  const liveText = mode === "preview" && registry.isDirty(tab.id) ? registry.getValue(tab.id) : null;
  const previewText = mode === "preview" ? liveText ?? content.content : "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1" style={{ borderColor: COLORS.border }}>
        <ViewerModeToggleButton active={mode === "preview"} onClick={() => setMode("preview")} icon={<Eye size={14} />} label="Preview" />
        <ViewerModeToggleButton active={mode === "source"} onClick={() => setMode("source")} icon={<Code size={14} />} label="Source" />
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
