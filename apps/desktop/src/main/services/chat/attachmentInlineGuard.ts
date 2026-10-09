import {
  MAX_PROVIDER_INLINE_FILE_BYTES,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";

/**
 * The attachment cap and the provider inline caps are different numbers on
 * purpose. A staged attachment may be up to `MAX_CHAT_ATTACHMENT_BYTES`,
 * because most providers receive a *path*: Codex gets a staged copy, Cursor,
 * Pi and Droid get path-shaped worker IPC, Claude gets `[File attached: ...]`
 * for non-images. Those paths do not care how big the file is.
 *
 * The call sites that base64 bytes into the model request itself do care:
 * Claude images (`buildClaudeV2MessageAsync`), OpenCode/AI-SDK streaming
 * content (`buildStreamingUserContent`), ACP prompt blocks
 * (`buildAcpPromptBlocks`), and the Cursor/Pi/Droid workers
 * (`materializeWorkerImages`). Images there go through
 * `fitImageForProviderInline`, which downscales them to the provider limits;
 * non-image files are checked against {@link MAX_PROVIDER_INLINE_FILE_BYTES}.
 * Whatever does not fit falls back to a text hint naming the path, which every
 * provider can still act on.
 */
export function exceedsProviderInlineLimit(byteLength: number): boolean {
  return byteLength > MAX_PROVIDER_INLINE_FILE_BYTES;
}

/**
 * The stand-in a provider sees instead of inlined bytes. Names the path so the
 * agent can read the file itself with its own tools, and says why — an
 * unexplained omission reads as a bug to the model and to the user.
 */
function attachmentTooLargeToInlineText(displayPath: string, byteLength: number): string {
  return `[Attachment not inlined: ${displayPath} is ${formatAttachmentSize(byteLength)}, over the ${formatAttachmentSize(MAX_PROVIDER_INLINE_FILE_BYTES)} inline limit. Read it from that path if you need its contents.]`;
}

/**
 * The hint as a content part, ready to push. Every inlining call site builds
 * the same `text` part with the same leading newline, so they take the whole
 * part from here rather than each re-deriving the wording and spacing.
 */
export function inlineAttachmentHintPart(
  displayPath: string,
  byteLength: number,
): { type: "text"; text: string } {
  return { type: "text", text: `\n${attachmentTooLargeToInlineText(displayPath, byteLength)}` };
}

/** The stand-in for an image `fitImageForProviderInline` could not fit. */
export function imageNotInlinedText(displayPath: string, reason: string): string {
  return `[Image not inlined: ${displayPath} (${reason}). Read it from that path if you need to see it.]`;
}

/** {@link imageNotInlinedText} as a content part, ready to push. */
export function imageNotInlinedHintPart(
  displayPath: string,
  reason: string,
): { type: "text"; text: string } {
  return { type: "text", text: `\n${imageNotInlinedText(displayPath, reason)}` };
}
