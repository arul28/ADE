/**
 * SpecPreviewCard — inline preview for HTML specs registered in the
 * orchestration bundle (see `goal.md` §10.6).
 *
 * Renders a 240×180 sandboxed iframe thumbnail, the relative asset path,
 * and an "Open in ADE browser" button that focuses the Work-tab Browser
 * surface and navigates to the file URL.
 *
 * Right-click → "Annotate spec" opens the AnnotationPopover with the spec
 * id as the anchor — the resulting context item is injected into the lead
 * chat composer.
 *
 * This component is owned by Step 5 of the orchestrator implementation.
 * It is consumed by `PlanMarkdown.tsx` (the markdown engine) and may be
 * imported directly by `OrchestrationPanel.tsx` when rendering a task
 * card's asset preview.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowSquareOut, FileHtml } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { AnnotationPopover, type AnnotationPopoverAnchor } from "./AnnotationPopover";

export type SpecPreviewCardProps = {
  /** Original href used in plan.md (relative bundle path, e.g. `artifacts/ui/login.html`). */
  href: string;
  /** Resolved absolute URL (typically `file:///...`) used as the iframe `src` and "Open" target. */
  resolvedUrl: string | null;
  /** Short label (defaults to filename derived from href). */
  label?: string;
  /** Run id used to tag annotations. */
  runId?: string;
  /** Optional asset id; used as anchor when "Annotate spec" is invoked. */
  assetId?: string;
  /** Target session for the dispatched annotation event. */
  sessionId?: string | null;
  /** Width of the card; defaults to 260 px. */
  width?: number;
  /** Height of the iframe thumbnail; defaults to 180 px per the spec. */
  thumbnailHeight?: number;
  className?: string;
};

export function SpecPreviewCard({
  href,
  resolvedUrl,
  label,
  runId,
  assetId,
  sessionId,
  width = 260,
  thumbnailHeight = 180,
  className,
}: SpecPreviewCardProps) {
  const url = resolvedUrl ?? href;
  const displayLabel = label ?? href.split("/").slice(-1)[0] ?? href;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<AnnotationPopoverAnchor | null>(null);

  const handleOpen = useCallback(() => {
    openUrlInAdeBrowser(url);
  }, [url]);

  // Annotation opens via right-click on the card OR via the "Annotate spec"
  // hidden button (exposed for tests / programmatic invocation).
  const openAnnotation = useCallback(() => {
    setPopoverAnchor({
      kind: "spec",
      id: assetId ?? href,
      preview: `Spec: ${displayLabel}`,
      href: url,
    });
  }, [assetId, href, url, displayLabel]);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!runId) return;
      event.preventDefault();
      openAnnotation();
    },
    [runId, openAnnotation],
  );

  useEffect(() => {
    // Reset the popover when the card unmounts so we don't leak a portal node.
    return () => setPopoverAnchor(null);
  }, []);

  return (
    <div
      ref={containerRef}
      data-plan-spec-card={href}
      data-testid="orchestration-spec-preview-card"
      onContextMenu={handleContextMenu}
      className={cn(
        "my-3 inline-flex max-w-full flex-col gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] p-2.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.45)]",
        className,
      )}
      style={{ width }}
    >
      <div className="flex items-center gap-2 px-1 pt-0.5">
        <FileHtml size={12} weight="duotone" className="text-violet-200/85" />
        <span className="truncate font-mono text-[10px] text-fg/75" title={href}>
          {displayLabel}
        </span>
      </div>
      <div
        className="overflow-hidden rounded-md border border-white/[0.06] bg-black/40"
        style={{ width: "100%", height: thumbnailHeight }}
      >
        {/* `sandbox=""` means: no scripts, no same-origin, no plugins, no forms.
            Live reflection of the current file contents only. */}
        <iframe
          title={`Preview of ${href}`}
          src={url}
          sandbox=""
          className="block h-full w-full"
          style={{ border: 0, pointerEvents: "none" }}
          loading="lazy"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          onClick={handleOpen}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-violet-300/25 bg-violet-300/10 px-2.5 py-1 font-sans text-[10.5px] font-medium text-violet-100 transition-colors hover:bg-violet-300/15"
        >
          <ArrowSquareOut size={11} weight="bold" />
          Open in ADE browser
        </button>
        {runId ? (
          <button
            type="button"
            data-testid="orchestration-spec-annotate-button"
            onClick={openAnnotation}
            className="inline-flex items-center justify-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 py-1 font-sans text-[10.5px] font-medium text-fg/60 transition-colors hover:bg-white/[0.06] hover:text-fg/85"
            aria-label="Annotate this spec"
          >
            Annotate spec
          </button>
        ) : null}
      </div>
      {popoverAnchor && runId ? (
        <AnnotationPopover
          runId={runId}
          sessionId={sessionId ?? null}
          anchor={popoverAnchor}
          onClose={() => setPopoverAnchor(null)}
          mountTarget={containerRef.current}
        />
      ) : null}
    </div>
  );
}
