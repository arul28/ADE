import {
  MAX_PROVIDER_INLINE_IMAGE_BYTES,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";

/**
 * The attachment cap and the provider inline cap are different numbers on
 * purpose. A staged attachment may be up to `MAX_CHAT_ATTACHMENT_BYTES`,
 * because most providers receive a *path*: Codex gets a staged copy, Cursor,
 * Pi and Droid get path-shaped worker IPC, Claude gets `[File attached: ...]`
 * for non-images. Those paths do not care how big the file is.
 *
 * Three call sites do care, because they base64 the bytes into the model
 * request itself: Claude images (`buildClaudeV2Message`), OpenCode/AI-SDK
 * streaming content (`buildStreamingUserContent`), and the Droid/Pi prompt
 * blocks (`buildAgentPromptBlocks`). Base64 inflates by a third and the
 * provider rejects the request, so raising the attachment cap must not raise
 * what those three inline. They check this instead and fall back to a text
 * hint naming the path, which every provider can still act on.
 */
export function exceedsProviderInlineLimit(byteLength: number): boolean {
  return byteLength > MAX_PROVIDER_INLINE_IMAGE_BYTES;
}

/**
 * The stand-in a provider sees instead of inlined bytes. Names the path so the
 * agent can read the file itself with its own tools, and says why — an
 * unexplained omission reads as a bug to the model and to the user.
 */
function attachmentTooLargeToInlineText(displayPath: string, byteLength: number): string {
  return `[Attachment not inlined: ${displayPath} is ${formatAttachmentSize(byteLength)}, over the ${formatAttachmentSize(MAX_PROVIDER_INLINE_IMAGE_BYTES)} inline limit. Read it from that path if you need its contents.]`;
}

/**
 * The hint as a content part, ready to push. All three inlining call sites
 * build the same `text` part with the same leading newline, so they take the
 * whole part from here rather than each re-deriving the wording and spacing —
 * three copies of a provider-facing sentence is three chances to drift.
 */
export function inlineAttachmentHintPart(
  displayPath: string,
  byteLength: number,
): { type: "text"; text: string } {
  return { type: "text", text: `\n${attachmentTooLargeToInlineText(displayPath, byteLength)}` };
}
