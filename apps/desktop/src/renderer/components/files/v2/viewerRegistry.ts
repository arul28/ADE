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
const AUDIO_EXTS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"]);
const VIDEO_EXTS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"]);
const DOCUMENT_EXTS = new Set(["doc", "docx", "ppt", "pptx", "xls", "xlsx"]);

export function extensionOf(path: string): string {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
}

/**
 * Ordered first-match resolution:
 *   pdf → image → media → csv → documents → largeText(streamed) → markdown → binary → code(default).
 *
 * Special file types (pdf/image/csv) win over the large-text streamer because
 * their viewers stream bytes themselves; an oversized plain/markdown/code file
 * falls through to the read-only virtualized largeText viewer.
 */
export function resolveViewerKind(ctx: ViewerResolveContext): ViewerKind {
  const ext = extensionOf(ctx.path);

  if (ext === "pdf") return "pdf";
  if (ctx.previewKind === "image" || IMAGE_EXTS.has(ext) || ext === "svg") return "image";
  if (ctx.mimeType?.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  if (ctx.mimeType?.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  // previewKind === "image" already returned above, so only text/binary remain here.
  if (ctx.isPartial && !ctx.isBinary) return "largeText";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ctx.isBinary || ctx.previewKind === "binary") return "binary";
  return "code";
}

/**
 * Viewer kinds whose surface mounts the Monaco code editor over the full text
 * buffer: plain code/text, markdown (Source mode), and CSV/TSV (Source mode).
 * These are text-backed formats ADE round-trips losslessly through
 * `files.writeText`, so they are editable immediately — no trust toggle, no
 * enable-editing step, no read-only default.
 */
const TEXT_EDITABLE_VIEWER_KINDS: ReadonlySet<ViewerKind> = new Set(["code", "markdown", "csv"]);

/** Whether a viewer kind has a text-editing surface (others are read-only viewers). */
export function viewerIsEditable(kind: ViewerKind): boolean {
  return TEXT_EDITABLE_VIEWER_KINDS.has(kind);
}

/**
 * Whether the loaded payload itself can be safely edited and written back as
 * text. This is the honest safety boundary, not a trust gate: a partial
 * (streamed) buffer would truncate the file on save, and binary/base64
 * payloads cannot round-trip through the text editor.
 */
export function contentSupportsTextEditing(content: {
  isBinary?: boolean;
  isPartial?: boolean;
  encoding?: string;
  contentOmitted?: boolean;
}): boolean {
  return !content.isBinary
    && !content.isPartial
    && !content.contentOmitted
    && content.encoding !== "base64";
}

/** Editable = the viewer has a text surface AND the payload round-trips as text. */
export function tabIsTextEditable(
  kind: ViewerKind,
  content: { isBinary?: boolean; isPartial?: boolean; encoding?: string; contentOmitted?: boolean },
): boolean {
  return viewerIsEditable(kind) && contentSupportsTextEditing(content);
}
