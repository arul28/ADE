/**
 * Codex's inline image `result` is bare base64 (no `data:` prefix). A JPEG's
 * starts with `/9j/`, so it must never be read as a file path. Shared by the
 * main process (paths, durable history) and the renderer (the preview).
 */
export function looksLikeInlineBase64Image(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length >= 256 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

/** A previewable data URL for an inline base64 image, or null when it is not one. */
export function inlineBase64ImageDataUrl(value: string | null | undefined): string | null {
  if (!value || !looksLikeInlineBase64Image(value)) return null;
  const mime = value.startsWith("/9j/") ? "image/jpeg" : value.startsWith("UklGR") ? "image/webp" : "image/png";
  return `data:${mime};base64,${value.replace(/\s+/g, "")}`;
}

/**
 * The parts of a Codex `imageGeneration` item that are not plain strings.
 *
 * Codex 0.164 uploads a generated image to OpenAI's attachment store and
 * then sends `fileId` instead of the inline base64 `result`; it still writes
 * a local copy (`savedPath`) when it can. An edit also lists the local images
 * it read (`inputImages: [{ path, sha256 }]`). Older items have neither field,
 * so both are omitted rather than set empty.
 */
export function codexImageGenerationRefFields(item: Record<string, unknown>): {
  fileId?: string;
  inputImagePaths?: string[];
} {
  const rawFileId = item.fileId ?? item.file_id;
  const fileId = typeof rawFileId === "string" && rawFileId.trim() ? rawFileId.trim() : null;
  const rawInputs = item.inputImages ?? item.input_images;
  const inputImagePaths = Array.isArray(rawInputs)
    ? rawInputs.flatMap((entry) => {
      const path = entry && typeof entry === "object" ? (entry as { path?: unknown }).path : null;
      return typeof path === "string" && path.trim() ? [path.trim()] : [];
    })
    : [];
  return {
    ...(fileId ? { fileId } : {}),
    ...(inputImagePaths.length ? { inputImagePaths } : {}),
  };
}
