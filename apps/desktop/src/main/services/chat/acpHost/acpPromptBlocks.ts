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

import path from "node:path";
import type { AgentChatFileRef } from "../../../../shared/types/chat";
import { hasNullByte } from "../../shared/utils";
import {
  exceedsProviderInlineLimit,
  inlineAttachmentHintPart,
} from "../attachmentInlineGuard";
import type { AcpImagePromptBehavior } from "./acpHostTypes";
import type { AcpContentBlock } from "./acpProtocolTypes";

export type AcpResolvedAttachment = AgentChatFileRef & {
  _resolvedPath: string;
  _rootPath: string;
};

type AcpTextBlock = Extract<AcpContentBlock, { type: "text" }>;

const MAX_INLINE_TEXT_BYTES = 512 * 1024;

function imageMimeType(filePath: string): string {
  const extension = path.extname(filePath.split(/[?#]/u, 1)[0] ?? "").toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".png":
    default:
      return "image/png";
  }
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

  for (const attachment of args.attachments) {
    if (attachment.type === "image-url") {
      const url = attachment.url?.trim();
      if (!url) {
        blocks.push(attachmentUnavailableText(attachment));
      } else if (args.agentSupportsImages && args.imagePrompt) {
        // ACP peers can resolve a URI without ADE downloading arbitrary user
        // URLs in the main process. The empty data field is required by the
        // protocol schema; the URI is the actual image source.
        blocks.push(args.imagePrompt({
          base64Data: "",
          mimeType: imageMimeType(url),
          uri: url,
        }));
      } else {
        blocks.push(textBlock(`\nImage URL attachment omitted: ${url} (this provider does not support image prompts).`));
      }
      continue;
    }

    try {
      const bytes = await args.readAttachmentBytes(attachment);
      if (attachment.type === "image") {
        if (!args.agentSupportsImages || !args.imagePrompt) {
          blocks.push(textBlock(`\nImage attachment omitted: ${attachment.path} (this provider does not support image prompts).`));
        } else if (exceedsProviderInlineLimit(bytes.byteLength)) {
          blocks.push(inlineAttachmentHintPart(attachment.path, bytes.byteLength));
        } else {
          blocks.push(args.imagePrompt({
            base64Data: bytes.toString("base64"),
            mimeType: imageMimeType(attachment._resolvedPath || attachment.path),
          }));
        }
        continue;
      }

      if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
        blocks.push(inlineAttachmentHintPart(attachment.path, bytes.byteLength));
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
