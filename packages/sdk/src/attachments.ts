import type { AgentChatFileRef } from "./types.js";

/**
 * Attachment refs, completed before they reach the wire.
 *
 * The runtime decides "send as an image the model can see" versus "send a
 * path hint" from `type` alone. Until 0.3 this package had no such field, so
 * every image an SDK host attached reached the model as a path. Inferring it
 * here, in one place, means a host that never heard of the field still gets
 * images delivered as images.
 *
 * ONE RULE, THREE COPIES. `inferAttachmentType` below is a word-for-word copy
 * of the runtime's own `inferAttachmentType` (with `isImageAttachmentPath` and
 * its extension table) in `apps/desktop/src/shared/types/chat.ts`, and
 * `@ade-dev/chat-ui` carries the same copy in
 * `packages/chat-ui/src/adapters/sdkClient.ts`. The SDK cannot import either
 * (it ships with zero dependencies), so a change to the rule is made in all
 * three places or none: a file the SDK typed differently from the runtime would
 * be sent one way from a host and another way from ADE itself.
 */

/** The runtime's `IMAGE_ATTACHMENT_MEDIA_TYPES` keys: the extensions it reads as images. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

/** The runtime's `isImageAttachmentPath`: the last suffix of the path, lowercased. */
function isImageAttachmentPath(filePath: string): boolean {
  const extension = filePath.match(/\.[^./\\]+$/)?.[0]?.toLowerCase();
  return extension ? IMAGE_EXTENSIONS.has(extension) : false;
}

/**
 * `"image"` or `"file"` for one attachment, by the runtime's rule.
 *
 * Any `image/*` mime type means image. Otherwise — including for a non-image
 * mime type, which does NOT force `"file"` — the path's extension decides:
 * `.bmp .gif .heic .heif .ico .jpeg .jpg .png .svg .tif .tiff .webp` are
 * images, everything else is a file. Same name, signature and answer as the
 * runtime's `inferAttachmentType`.
 */
export function inferAttachmentType(filePath: string, mimeType?: string | null): "file" | "image" {
  if (mimeType?.toLowerCase().startsWith("image/")) return "image";
  return isImageAttachmentPath(filePath) ? "image" : "file";
}

/**
 * The refs as they go on the wire: `type` filled in where the caller left it
 * out, everything else untouched. A caller's explicit `type` always wins.
 */
export function completeAttachments(refs: readonly AgentChatFileRef[]): AgentChatFileRef[] {
  return refs.map((ref) =>
    ref.type === "file" || ref.type === "image"
      ? { ...ref }
      : { ...ref, type: inferAttachmentType(typeof ref.path === "string" ? ref.path : "", ref.mimeType) },
  );
}
