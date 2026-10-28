import React from "react";
import { ArrowSquareOut, Copy, FileText } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { joinDisplayPath } from "../pathDisplay";
import { formatBytes } from "../../../../../shared/formatting";
import { isWebClientMode } from "../../../../lib/webClientMode";

/**
 * The honest "no in-app preview" card, shared by every viewer that cannot (or
 * chose not to) draw its file: the Office formats without a renderer, and the
 * new spreadsheet/presentation viewers when the bytes turn out to be
 * something their parser refuses.
 *
 * Before this existed, each failure grew its own card, which is how a preview
 * panel ends up with three different "open externally" buttons. One surface,
 * one set of actions, one place the copy lives.
 */
export function DocumentSurface({
  rootPath,
  relativePath,
  title,
  mimeType,
  size,
  /** One line about why the preview is not shown; omitted for plain falls. */
  notice = null,
  /** Extra buttons before the shared ones (e.g. a viewer's "try again"). */
  extraActions = null,
}: {
  rootPath: string;
  relativePath: string;
  title: string;
  mimeType: string | null;
  size: number;
  notice?: string | null;
  extraActions?: React.ReactNode;
}) {
  const absolutePath = joinDisplayPath(rootPath, relativePath);
  const openExternally = () => {
    void window.ade.app.openPathInEditor?.({ rootPath, relativePath, target: "default" }).catch(() => {});
  };
  const copyPath = () => {
    void window.ade.app.writeClipboardText?.(absolutePath);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileText size={42} color={COLORS.textDim} weight="thin" />
      <div className="text-sm" style={{ color: COLORS.textMuted }}>
        {title}
      </div>
      <div className="max-w-xl text-xs leading-5" style={{ color: COLORS.textDim }}>
        {mimeType ?? "document"} · {formatBytes(size)}
      </div>
      {notice ? (
        <div className="max-w-xl text-xs leading-5" style={{ color: COLORS.textMuted }}>
          {notice}
        </div>
      ) : null}
      <div className="max-w-xl truncate text-xs" title={absolutePath} style={{ color: COLORS.textDim }}>
        {absolutePath}
      </div>
      <div className="mt-1 flex items-center gap-2">
        {extraActions}
        <button
          type="button"
          onClick={copyPath}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
          style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
        >
          <Copy size={14} /> Copy full path
        </button>
        {/* The web client has no OS to open the file in, so it hides this instead of no-oping. */}
        {isWebClientMode() ? null : (
          <button
            type="button"
            onClick={openExternally}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs"
            style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}
          >
            <ArrowSquareOut size={14} /> Open externally
          </button>
        )}
      </div>
    </div>
  );
}
