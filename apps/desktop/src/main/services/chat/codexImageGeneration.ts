/** Codex's inline `result` is bare base64 (no `data:` prefix), and a JPEG's starts with `/9j/`. */
export function looksLikeInlineBase64Image(value: string): boolean {
  return value.length >= 256 && /^[A-Za-z0-9+/=\s]+$/.test(value);
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
