/**
 * Size ceilings for chat attachments, shared by the desktop renderer, the
 * desktop main process, and the ADE CLI sync host.
 *
 * There are two caps because there are two fundamentally different ways an
 * attachment reaches the host:
 *
 * - **As a file.** A local disk-to-disk copy, or a streamed HTTP upload to a
 *   paired host. Bytes never sit in a JS string and never ride a message-shaped
 *   transport, so the ceiling is the product one: {@link MAX_CHAT_ATTACHMENT_BYTES}.
 * - **As base64 in a command payload.** The legacy `chat.saveTempAttachment`
 *   path. Base64 inflates by a third, the whole payload is buffered in memory on
 *   both ends, and over sync it is chunked into 720 KiB frames under a 25 MB
 *   payload cap. That path keeps its historical ceiling,
 *   {@link LEGACY_MAX_CHAT_ATTACHMENT_BYTES}.
 *
 * A client talking to a host that does not advertise the upload route only ever
 * sees the legacy cap, so an older host is never handed a payload it would
 * reject halfway through.
 */

/** Ceiling for attachments that move as files (local copy or HTTP upload). */
export const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Ceiling for attachments that move as base64 inside a command payload. */
export const LEGACY_MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling for image bytes a provider adapter inlines into a model request.
 *
 * Independent of the attachment cap on purpose. Staging a 50 MB screenshot for
 * Codex or handing its path to Droid is fine; base64-inlining it into an
 * Anthropic or OpenCode request is not — it triples the request body and the
 * provider rejects it. Raising the attachment cap must not raise this one, so
 * every inline path checks it and degrades to a path hint instead.
 */
export const MAX_PROVIDER_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Human size for composer copy: "9 KB", "1.4 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * The one message every legacy-cap rejection uses.
 *
 * `subject` names what was rejected ("Temporary attachments", "Image",
 * "Clipboard image") because the caller knows which of the base64 paths the
 * user actually took. The ceiling is rendered from the constant, so raising
 * {@link LEGACY_MAX_CHAT_ATTACHMENT_BYTES} can never leave a stale "10 MB"
 * behind in a message the constant no longer matches.
 */
export function legacyAttachmentCapMessage(subject: string): string {
  return `${subject} must be ${formatAttachmentSize(LEGACY_MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`;
}

/** The one message every "too large" rejection uses, so all surfaces agree. */
export function attachmentTooLargeMessage(
  name: string,
  bytes: number,
  limitBytes: number,
): string {
  const label = name.trim() || "attachment";
  return `File "${label}" is too large (${formatAttachmentSize(bytes)}). Maximum allowed size is ${formatAttachmentSize(limitBytes)}.`;
}
