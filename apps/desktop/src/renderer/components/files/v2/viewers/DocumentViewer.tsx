import React from "react";
import type { ViewerProps } from "./types";
import { DocumentSurface } from "./DocumentSurface";

/**
 * The fallback for documents with no in-app renderer: Word files (no preview
 * yet) and the legacy binary Office formats.
 *
 * `.doc` / `.xls` / `.ppt` are OLE compound files, not zip packages, so the
 * spreadsheet and presentation viewers cannot read them — the reference
 * implementation routed them at a zip parser and failed on every one. Here
 * they stay on this card and say why, which is the difference between "ADE
 * cannot show this" and "this file is broken".
 */
const LEGACY_OFFICE_EXTENSIONS: Record<string, string> = {
  ".doc": "Legacy .doc files cannot be previewed in ADE. Open it externally, or save it as .docx.",
  ".xls": "Legacy .xls files cannot be previewed in ADE. Open it externally, or save it as .xlsx.",
  ".ppt": "Legacy .ppt files cannot be previewed in ADE. Open it externally, or save it as .pptx.",
};

function legacyNoticeFor(relativePath: string): string | null {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return LEGACY_OFFICE_EXTENSIONS[lower.slice(dot)] ?? null;
}

export function DocumentViewer({ rootPath, tab, content }: ViewerProps) {
  return (
    <DocumentSurface
      rootPath={rootPath}
      relativePath={tab.path}
      title={tab.title}
      mimeType={content.mimeType ?? null}
      size={content.size}
      notice={legacyNoticeFor(tab.path)}
    />
  );
}
