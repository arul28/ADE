import React from "react";
import { FileX, ArrowSquareOut } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import type { ViewerProps } from "./types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fallback for unpreviewable binary files — offers revealing in Finder. */
export function BinaryViewer({ rootPath, tab, content }: ViewerProps) {
  const openExternally = () => {
    void window.ade.app.openPathInEditor?.({ rootPath, relativePath: tab.path, target: "finder" }).catch(() => {});
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileX size={40} color={COLORS.textDim} weight="thin" />
      <div className="text-sm" style={{ color: COLORS.textMuted }}>
        {tab.title} can't be previewed here
      </div>
      <div className="text-xs" style={{ color: COLORS.textDim }}>
        {formatBytes(content.size)} · {content.mimeType ?? "binary"}
      </div>
      <button
        type="button"
        onClick={openExternally}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
        style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
      >
        <ArrowSquareOut size={14} /> Open externally
      </button>
    </div>
  );
}
