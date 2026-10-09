import path from "node:path";
import {
  attachmentIsReferenceOnly,
  getImageAttachmentMediaType,
  attachmentPathHint,
  type AgentChatFileRef,
} from "../../../shared/types/chat";
import {
  readAgentAccessibleFileBytes,
  type DirtyFileTextLookup,
} from "../shared/utils";
import { imageNotInlinedHintPart } from "./attachmentInlineGuard";
import { fitImageForProviderInline } from "./providerInlineImage";
import type { Logger } from "../logging/logger";

type ResolvedAgentChatFileRef = AgentChatFileRef & {
  _resolvedPath?: string;
  _rootPath?: string;
};

/**
 * Whether this attachment goes to Claude as image bytes. Everything else —
 * a file, or an image the caller marked reference-only with `hydrate: false`
 * — goes as a `[File attached: …]` hint, and its bytes are never read.
 */
function sendsImageBytes(attachment: AgentChatFileRef): boolean {
  return attachment.type === "image" && !attachmentIsReferenceOnly(attachment);
}

/** MIME types the Anthropic API accepts for inline image content blocks. */
export const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Non-image extension-to-MIME lookup used by inferAttachmentMediaType. */
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".c": "text/x-c",
  ".cc": "text/x-c++src",
  ".cpp": "text/x-c++src",
  ".css": "text/css",
  ".csv": "text/csv",
  ".go": "text/x-go",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/jsx",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rustsrc",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/** Infer the MIME type of an attachment from its file extension. */
export function inferAttachmentMediaType(attachment: AgentChatFileRef): string {
  const ext = path.extname(attachment.path).toLowerCase();
  return getImageAttachmentMediaType(attachment.path)
    ?? ATTACHMENT_MEDIA_TYPES[ext]
    ?? (attachment.type === "image" ? "image/png" : "application/octet-stream");
}

/**
 * The return type mirrors what the Claude Agent SDK expects:
 * a plain string for text-only messages, or a partial SDKUserMessage
 * object with image content blocks for multimodal input.
 */
export type SDKUserMessagePartial = {
  type: "user";
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: "user";
    content: Array<Record<string, unknown>>;
  };
};

type BuildClaudeV2MessageOptions = {
  baseDir?: string;
  sessionId?: string | null;
  forceUserMessage?: boolean;
  getDirtyFileTextForPath?: DirtyFileTextLookup;
  logger?: Pick<Logger, "info" | "warn">;
};

export async function buildClaudeV2MessageAsync(
  promptText: string,
  attachments: ResolvedAgentChatFileRef[],
  options: BuildClaudeV2MessageOptions = {},
): Promise<string | SDKUserMessagePartial> {
  const wrapAsUserMessage = (text: string): SDKUserMessagePartial => ({
    type: "user",
    session_id: options.sessionId?.trim() ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
  });

  const imageAttachments = attachments.filter(sendsImageBytes);
  if (!imageAttachments.length) {
    const text = attachments.length
      ? `${promptText}\n\n${attachments.map(attachmentPathHint).join("\n")}`
      : promptText;
    return options.forceUserMessage ? wrapAsUserMessage(text) : text;
  }

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: promptText },
  ];

  for (const attachment of attachments) {
    if (!sendsImageBytes(attachment)) {
      content.push({ type: "text", text: `\n${attachmentPathHint(attachment)}` });
      continue;
    }

    try {
      const mediaType = inferAttachmentMediaType(attachment);
      if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(mediaType)) {
        content.push({ type: "text", text: `\n[Image attached (${mediaType}): ${attachment.path}]` });
        continue;
      }
      const secureRoot = attachment._rootPath ?? options.baseDir;
      const resolvedPath = attachment._resolvedPath ?? attachment.path;
      if (!secureRoot) {
        content.push({ type: "text", text: `\n[Image unavailable: ${attachment.path}]` });
        continue;
      }
      const data = await readAgentAccessibleFileBytes({
        rootPath: secureRoot,
        resolvedPath,
        getDirtyFileTextForPath: options.getDirtyFileTextForPath,
      });
      // Claude Code ends the whole turn (`terminal_reason: "image_error"`) on
      // an image over 5 MB of base64 or past the pixel limits, so every image
      // is fitted first. One that cannot be fitted becomes a path hint and the
      // turn still runs. Normal sends and mid-turn steers both land here.
      const fitted = await fitImageForProviderInline(data, mediaType, {
        provider: "claude",
        logger: options.logger,
      });
      if (fitted.kind === "omit") {
        content.push(imageNotInlinedHintPart(attachment.path, fitted.reason));
        continue;
      }
      content.push({
        type: "image",
        source: { type: "base64", media_type: fitted.mediaType, data: fitted.data.toString("base64") },
      });
    } catch (error) {
      content.push({
        type: "text",
        text: `\n[Image unavailable: ${attachment.path}${error instanceof Error ? ` (${error.message})` : ""}]`,
      });
    }
  }

  return {
    type: "user",
    session_id: options.sessionId?.trim() ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}
