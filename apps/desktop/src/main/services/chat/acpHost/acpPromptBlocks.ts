/**
 * Convert ADE attachments into ACP prompt blocks.
 *
 * ACP has no generic file-path block. Images therefore use the dialect's
 * image behavior when both the protocol peer and the dialect support inline
 * images; text files are represented as bounded text with an explicit path
 * label. Unsupported or unreadable attachments become visible text hints so
 * they are never silently recorded in ADE while being absent from the model's
 * request.
 */

import {
  attachmentAgentPath,
  attachmentIsReferenceOnly,
  attachmentPathHint,
  getImageAttachmentMediaType,
  type AgentChatFileRef,
} from "../../../../shared/types/chat";
import { labelAttachments } from "../../../../shared/attachmentLabels";
import { hasNullByte } from "../../shared/utils";
import {
  imageAttachmentReferenceText,
  imageNotInlinedHintPart,
  inlineAttachmentHintPart,
} from "../attachmentInlineGuard";
import {
  fitImageForProviderInline,
  isProviderImageByteMediaType,
  normalizeImageMediaType,
} from "../providerInlineImage";
import { sniffImageMimeType } from "../../../../shared/imageSniff";
import type { AcpImagePromptBehavior } from "./acpHostTypes";
import type { AcpContentBlock } from "./acpProtocolTypes";

export type AcpResolvedAttachment = AgentChatFileRef & {
  _resolvedPath: string;
  _rootPath: string;
};

type AcpTextBlock = Extract<AcpContentBlock, { type: "text" }>;

const MAX_INLINE_TEXT_BYTES = 512 * 1024;

/**
 * The image type an attachment is sent as: the sender's MIME when it gave one,
 * else the extension's. Null when neither names an image type.
 */
function imageMimeType(filePath: string, declared?: string | null): string | null {
  return normalizeImageMediaType(declared)
    || getImageAttachmentMediaType(filePath.split(/[?#]/u, 1)[0] ?? "");
}

function textBlock(text: string): AcpTextBlock {
  return { type: "text", text };
}

function attachmentUnavailableText(attachment: AcpResolvedAttachment): AcpTextBlock {
  return textBlock(`\nAttachment unavailable: ${attachment.path}`);
}

export type BuildAcpPromptBlocksArgs = {
  promptText: string;
  attachments: readonly AcpResolvedAttachment[];
  agentSupportsImages: boolean;
  imagePrompt: AcpImagePromptBehavior | null;
  readAttachmentBytes: (attachment: AcpResolvedAttachment) => Promise<Buffer>;
};

export async function buildAcpPromptBlocks(
  args: BuildAcpPromptBlocksArgs,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = [textBlock(args.promptText)];
  const labels = labelAttachments(args.attachments);

  for (const [index, attachment] of args.attachments.entries()) {
    // The `[Image #k]` / `[File #k: name]` label goes right before the
    // attachment's own block, so a label in the prompt names this block.
    const token = labels[index]?.token;
    if (token) blocks.push(textBlock(`\n${token}`));
    if (attachment.type === "image-url") {
      const url = attachment.url?.trim();
      if (!url) {
        blocks.push(attachmentUnavailableText(attachment));
      } else if (args.agentSupportsImages && args.imagePrompt) {
        const mimeType = imageMimeType(url);
        if (mimeType && !isProviderImageByteMediaType(mimeType)) {
          blocks.push(textBlock(`\n${imageAttachmentReferenceText(url, mimeType)}`));
          continue;
        }
        // ACP peers can resolve a URI without ADE downloading arbitrary user
        // URLs in the main process. The empty data field is required by the
        // protocol schema; the URI is the actual image source. A URL with no
        // image suffix keeps the PNG hint; the peer reads the real type.
        blocks.push(args.imagePrompt({
          base64Data: "",
          mimeType: mimeType ?? "image/png",
          uri: url,
        }));
      } else {
        blocks.push(textBlock(`\nImage URL attachment omitted: ${url} (this provider does not support image prompts).`));
      }
      continue;
    }

    // `hydrate: false`: the bytes are never read; the agent gets the path.
    if (attachmentIsReferenceOnly(attachment)) {
      blocks.push(textBlock(`\n${attachmentPathHint(attachment)}`));
      continue;
    }

    // TIFF, HEIC, BMP, ICO and SVG are not image bytes any provider accepts:
    // the agent gets the path and opens the file with its own tools.
    const declaredImageMimeType = attachment.type === "image"
      ? imageMimeType(attachmentAgentPath(attachment), attachment.mimeType)
      : null;
    if (declaredImageMimeType && !isProviderImageByteMediaType(declaredImageMimeType)) {
      blocks.push(textBlock(`\n${imageAttachmentReferenceText(attachment.path, declaredImageMimeType)}`));
      continue;
    }

    try {
      const bytes = await args.readAttachmentBytes(attachment);
      if (attachment.type === "image") {
        // No type from the sender or the name: the bytes decide, and bytes
        // that are no provider image type stay a path reference.
        const mimeType = declaredImageMimeType ?? sniffImageMimeType(bytes);
        if (!mimeType || !isProviderImageByteMediaType(mimeType)) {
          blocks.push(textBlock(`\n${imageAttachmentReferenceText(attachment.path, mimeType ?? "unknown type")}`));
        } else if (!args.agentSupportsImages || !args.imagePrompt) {
          blocks.push(textBlock(`\nImage attachment omitted: ${attachment.path} (this provider does not support image prompts).`));
        } else {
          // ACP agents may route to an Anthropic model, which rejects an image
          // over 5 MB of base64, so images are fitted before they are inlined.
          const fitted = await fitImageForProviderInline(bytes, mimeType, { provider: "acp" });
          blocks.push(fitted.kind === "omit"
            ? imageNotInlinedHintPart(attachment.path, fitted.reason)
            : args.imagePrompt({
              base64Data: fitted.data.toString("base64"),
              mimeType: fitted.mediaType,
            }));
        }
        continue;
      }

      if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
        blocks.push(inlineAttachmentHintPart(attachment.path, bytes.byteLength, MAX_INLINE_TEXT_BYTES));
      } else if (hasNullByte(bytes)) {
        blocks.push(textBlock(`\nAttachment omitted: ${attachment.path} (binary or unsupported file).`));
      } else {
        blocks.push(textBlock(`\n[File: ${attachment.path}]\n${bytes.toString("utf8")}`));
      }
    } catch {
      blocks.push(attachmentUnavailableText(attachment));
    }
  }

  return blocks;
}
