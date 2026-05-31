import type { FilePreviewKind } from "../../../../shared/types";
import type { ViewerKind } from "./editorGroupsStore";

/**
 * Decide which viewer renders a file. The renderer owns this richer dispatch;
 * the backend `FilePreviewKind` stays a coarse text/image/binary hint. Mode-driven
 * viewers (diff, conflict) are selected by the shell, not here.
 */
export type ViewerResolveContext = {
  path: string;
  previewKind?: FilePreviewKind;
  mimeType?: string | null;
  isBinary?: boolean;
  /** True when the backend returned only a streamable first chunk (oversized text). */
  isPartial?: boolean;
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

export function extensionOf(path: string): string {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
}

/**
 * Ordered first-match resolution:
 *   pdf → image → csv → largeText(streamed) → markdown → binary → code(default).
 *
 * Special file types (pdf/image/csv) win over the large-text streamer because
 * their viewers stream bytes themselves; an oversized plain/markdown/code file
 * falls through to the read-only virtualized largeText viewer.
 */
export function resolveViewerKind(ctx: ViewerResolveContext): ViewerKind {
  const ext = extensionOf(ctx.path);

  if (ext === "pdf") return "pdf";
  if (ctx.previewKind === "image" || IMAGE_EXTS.has(ext) || ext === "svg") return "image";
  if (ext === "csv" || ext === "tsv") return "csv";
  // previewKind === "image" already returned above, so only text/binary remain here.
  if (ctx.isPartial && !ctx.isBinary) return "largeText";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ctx.isBinary || ctx.previewKind === "binary") return "binary";
  return "code";
}

/** Whether a viewer kind supports inline editing (others are read-only). */
export function viewerIsEditable(kind: ViewerKind): boolean {
  return kind === "code";
}
