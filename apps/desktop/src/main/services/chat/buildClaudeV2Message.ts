import fs from "node:fs";
import path from "node:path";
import type { AgentChatFileRef } from "../../../shared/types/chat";

/** MIME types the Anthropic API accepts for inline image content blocks. */
export const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Extension-to-MIME lookup used by inferAttachmentMediaType. */
const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".c": "text/x-c",
  ".cc": "text/x-c++src",
  ".cpp": "text/x-c++src",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/jsx",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rustsrc",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/** Infer the MIME type of an attachment from its file extension. */
export function inferAttachmentMediaType(attachment: AgentChatFileRef): string {
  const ext = path.extname(attachment.path).toLowerCase();
  return ATTACHMENT_MEDIA_TYPES[ext]
    ?? (attachment.type === "image" ? "image/png" : "application/octet-stream");
}

/**
 * The return type mirrors what the Claude Agent SDK expects:
 * a plain string for text-only messages, or a partial SDKUserMessage
 * object with image content blocks for multimodal input.
 */
export type SDKUserMessagePartial = {
  type: "user";
  message: {
    role: "user";
    content: Array<Record<string, unknown>>;
  };
};

/**
 * Build the message payload for a Claude V2 session turn.
 * When image attachments are present, returns a streaming-input-format
 * SDKUserMessage with image content blocks (per Agent SDK docs).
 * Otherwise returns a plain string.
 */
export function buildClaudeV2Message(
  promptText: string,
  attachments: AgentChatFileRef[],
  options: { baseDir?: string } = {},
): string | SDKUserMessagePartial {
  const imageAttachments = attachments.filter((a) => a.type === "image");
  if (!imageAttachments.length) {
    // No images -- include file paths as text hints, return plain string
    if (!attachments.length) return promptText;
    const hints = attachments.map((a) => `[File attached: ${a.path}]`).join("\n");
    return `${promptText}\n\n${hints}`;
  }

  // Build content blocks following the Agent SDK streaming input format:
  // https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: promptText },
  ];

  for (const attachment of attachments) {
    if (attachment.type !== "image") {
      content.push({ type: "text", text: `\n[File attached: ${attachment.path}]` });
      continue;
    }

    try {
      const resolvedPath = options.baseDir
        ? path.resolve(options.baseDir, attachment.path)
        : path.resolve(attachment.path);
      const mediaType = inferAttachmentMediaType(attachment);
      if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(mediaType)) {
        content.push({ type: "text", text: `\n[Image attached (${mediaType}): ${attachment.path}]` });
        continue;
      }
      const data = fs.readFileSync(resolvedPath);
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
      });
    } catch (error) {
      content.push({
        type: "text",
        text: `\n[Image unavailable: ${attachment.path}${error instanceof Error ? ` (${error.message})` : ""}]`,
      });
    }
  }

  // Match the streaming input format from the SDK docs -- minimal fields,
  // let the SDK fill in session_id, parent_tool_use_id, etc.
  return {
    type: "user",
    message: { role: "user", content },
  };
}
