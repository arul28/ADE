import type { AgentChatFileRef } from "./types.js";

/**
 * Attachment refs, completed before they reach the wire.
 *
 * The runtime decides "send as an image the model can see" versus "send a
 * path hint" from `type` alone. Until 0.3 this package had no such field, so
 * every image an SDK host attached reached the model as a path. Inferring it
 * here, in one place, means a host that never heard of the field still gets
 * images delivered as images.
 */

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * The extension of the last path segment, lowercased, with the dot.
 *
 * Splits on both separators because the path may be a Windows path read on
 * any host, and a dot in a directory name must not count.
 */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * `"image"` for the formats both Claude and Codex accept as image input,
 * `"file"` for everything else.
 *
 * The mime type wins when present, because a host that set one read it from
 * the file; the extension is the fallback for a ref built from a path alone.
 */
export function inferAttachmentType(ref: Pick<AgentChatFileRef, "path" | "name" | "mimeType">): "file" | "image" {
  const mime = typeof ref.mimeType === "string" ? ref.mimeType.trim().toLowerCase() : "";
  if (mime) return IMAGE_MIME_TYPES.has(mime) ? "image" : "file";
  const fromPath = typeof ref.path === "string" ? extensionOf(ref.path) : "";
  const fromName = typeof ref.name === "string" ? extensionOf(ref.name) : "";
  return IMAGE_EXTENSIONS.has(fromPath) || IMAGE_EXTENSIONS.has(fromName) ? "image" : "file";
}

/**
 * The refs as they go on the wire: `type` filled in where the caller left it
 * out, everything else untouched. A caller's explicit `type` always wins.
 */
export function completeAttachments(refs: readonly AgentChatFileRef[]): AgentChatFileRef[] {
  return refs.map((ref) =>
    ref.type === "file" || ref.type === "image" ? { ...ref } : { ...ref, type: inferAttachmentType(ref) },
  );
}
