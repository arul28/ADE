import React from "react";
import { ArrowSquareOut, Copy, FileText } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import type { ViewerProps } from "./types";
import { joinDisplayPath } from "../pathDisplay";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentViewer({ rootPath, tab, content }: ViewerProps) {
  const absolutePath = joinDisplayPath(rootPath, tab.path);
  const openExternally = () => {
    void window.ade.app.openPathInEditor?.({ rootPath, relativePath: tab.path, target: "default" }).catch(() => {});
  };
  const copyPath = () => {
    void window.ade.app.writeClipboardText?.(absolutePath);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileText size={42} color={COLORS.textDim} weight="thin" />
      <div className="text-sm" style={{ color: COLORS.textMuted }}>
        {tab.title}
      </div>
      <div className="max-w-xl text-xs leading-5" style={{ color: COLORS.textDim }}>
        {content.mimeType ?? "document"} · {formatBytes(content.size)}
      </div>
      <div className="max-w-xl truncate text-xs" title={absolutePath} style={{ color: COLORS.textDim }}>
        {absolutePath}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={copyPath}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
          style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        >
          <Copy size={14} /> Copy full path
        </button>
        <button
          type="button"
          onClick={openExternally}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
          style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        >
          <ArrowSquareOut size={14} /> Open externally
        </button>
      </div>
    </div>
  );
}
