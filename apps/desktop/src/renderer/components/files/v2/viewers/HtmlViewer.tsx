import React, { useMemo, useState } from "react";
import { Code, Eye } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { CodeViewer } from "./CodeViewer";
import type { ViewerProps } from "./types";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

type Mode = "preview" | "source";

const HTML_PREVIEW_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

/**
 * Keep previews self-contained and inert. The iframe sandbox blocks scripts,
 * forms, popups, downloads, and parent navigation; this document policy also
 * prevents the markup from fetching remote resources.
 */
export function buildHtmlPreviewDocument(source: string): string {
  // A detached HTMLDocument has no browsing context, so parsing cannot start
  // image, iframe, stylesheet, or other subresource requests before CSP exists.
  const preview = document.implementation.createHTMLDocument("");
  preview.open();
  preview.write(source);
  preview.close();
  preview.querySelectorAll("base").forEach((element) => element.remove());
  preview.querySelectorAll("meta[http-equiv]").forEach((element) => {
    if (element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      element.remove();
    }
  });

  const policy = preview.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", HTML_PREVIEW_POLICY);
  const referrer = preview.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  preview.head.prepend(referrer);
  preview.head.prepend(policy);

  return `<!doctype html>${preview.documentElement.outerHTML}`;
}

/** HTML viewer with an inert Preview and the normal editable Monaco source. */
export function HtmlViewer(props: ViewerProps) {
  const { registry, tab, content } = props;
  const [mode, setModeState] = useState<Mode>(() => readViewerMode<Mode>(tab.id, "preview"));
  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };

  const liveText = mode === "preview" && registry.isDirty(tab.id) ? registry.getValue(tab.id) : null;
  const previewDocument = useMemo(
    () => buildHtmlPreviewDocument(liveText ?? content.content),
    [content.content, liveText],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1" style={{ borderColor: COLORS.border }}>
        <ViewerModeToggleButton active={mode === "preview"} onClick={() => setMode("preview")} icon={<Eye size={14} />} label="Preview" />
        <ViewerModeToggleButton active={mode === "source"} onClick={() => setMode("source")} icon={<Code size={14} />} label="Source" />
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        {mode === "source" ? (
          <CodeViewer {...props} />
        ) : (
          <iframe
            title={`Preview of ${tab.title}`}
            data-testid="files-html-preview"
            className="h-full w-full border-0 bg-white"
            sandbox=""
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={previewDocument}
          />
        )}
      </div>
    </div>
  );
}
