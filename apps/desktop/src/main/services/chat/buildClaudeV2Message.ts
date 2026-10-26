import path from "node:path";
import {
  attachmentIsReferenceOnly,
  getImageAttachmentMediaType,
  attachmentPathHint,
  type AgentChatFileRef,
} from "../../../shared/types/chat";
import {
  readAgentAccessibleFileBytes,
  readFileWithinRootSecure,
  type DirtyFileTextLookup,
} from "../shared/utils";
import {
  imageAttachmentReferenceText,
  imageNotInlinedHintPart,
} from "./attachmentInlineGuard";
import { fitImageForProviderInline, PROVIDER_IMAGE_BYTE_MEDIA_TYPES } from "./providerInlineImage";
import { labelAttachments } from "../../../shared/attachmentLabels";
import { basenameCrossPlatform } from "../../../shared/pathDisplay";
import {
  CLAUDE_RETAINED_MEDIA_MAX_BYTES,
  CLAUDE_RETAINED_PDF_MAX_PAGES,
  countPdfPages,
  isPdfBytes,
  remainingInlinePdfFileBytes,
  retainedBytesForInline,
  type ClaudeRetainedMedia,
} from "./claudeInlineDocument";
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

/**
 * Whether this attachment is a PDF Claude may read as a `document` block. Only
 * when the caller passed a budget: without one there is nothing to stop a
 * session collecting more pages than the API accepts.
 */
function isPdfDocumentCandidate(attachment: AgentChatFileRef, budget: ClaudeRetainedMedia | undefined): boolean {
  if (!budget || attachment.type !== "file" || attachmentIsReferenceOnly(attachment)) return false;
  const mimeType = "mimeType" in attachment && typeof attachment.mimeType === "string"
    ? attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  return mimeType === "application/pdf" || inferAttachmentMediaType(attachment) === "application/pdf";
}

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

/** The label of the attachment a block is about, with its trailing space. */
function labelPrefix(token: string | undefined): string {
  return token ? `${token} ` : "";
}

type BuildClaudeV2MessageOptions = {
  baseDir?: string;
  sessionId?: string | null;
  forceUserMessage?: boolean;
  getDirtyFileTextForPath?: DirtyFileTextLookup;
  logger?: Pick<Logger, "info" | "warn">;
  /**
   * What this Claude session already carries. When given, PDFs that fit go as
   * `document` blocks, and every inlined PDF and image is added to it in place.
   * Pass the session's live budget: a PDF is checked and added with no await in
   * between, so concurrent builds cannot both spend the same pages.
   */
  retainedMedia?: ClaudeRetainedMedia;
  /** Also gets what this one message adds, so the caller can restore it if the budget is reset meanwhile. */
  retainedSpent?: ClaudeRetainedMedia;
};

/**
 * Read a PDF for a `document` block, or say why it goes as a path instead.
 * Read at send time, from the machine the chat runs on, so a remote chat reads
 * the copy staged on its own host.
 */
function readPdfDocumentBlock(
  attachment: ResolvedAgentChatFileRef,
  budget: ClaudeRetainedMedia,
  spent: ClaudeRetainedMedia | undefined,
  baseDir: string | undefined,
  logger: BuildClaudeV2MessageOptions["logger"],
): Record<string, unknown> | null {
  const secureRoot = attachment._rootPath ?? baseDir;
  const resolvedPath = attachment._resolvedPath ?? attachment.path;
  const skip = (reason: string, extra: Record<string, unknown> = {}): null => {
    logger?.info("agent_chat.claude_pdf_sent_as_path", { reason, ...extra });
    return null;
  };
  if (!secureRoot) return skip("no_root");
  const remainingPages = CLAUDE_RETAINED_PDF_MAX_PAGES - budget.pages;
  const maxBytes = remainingInlinePdfFileBytes(budget);
  if (remainingPages <= 0) return skip("page_budget_spent", { pages: budget.pages });
  if (maxBytes <= 0) return skip("byte_budget_spent", { bytes: budget.bytes });
  let bytes: Buffer;
  try {
    bytes = readFileWithinRootSecure(secureRoot, resolvedPath, { maxBytes });
  } catch (error) {
    return skip("unreadable_or_too_large", {
      maxBytes,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isPdfBytes(bytes)) return skip("not_a_pdf");
  const pages = countPdfPages(bytes);
  if (pages == null) return skip("pages_unknown", { byteLength: bytes.length });
  if (pages > remainingPages) return skip("over_page_budget", { pages, remainingPages });
  const retainedBytes = retainedBytesForInline(bytes.length);
  if (budget.bytes + retainedBytes > CLAUDE_RETAINED_MEDIA_MAX_BYTES) {
    return skip("over_byte_budget", { retainedBytes, bytes: budget.bytes });
  }
  for (const total of spent ? [budget, spent] : [budget]) {
    total.pages += pages;
    total.bytes += retainedBytes;
  }
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
    title: basenameCrossPlatform(attachment.path),
  };
}

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

  const budget = options.retainedMedia;
  const pdfCandidates = attachments.map((attachment) => isPdfDocumentCandidate(attachment, budget));
  const labels = labelAttachments(attachments);
  if (!attachments.some(sendsImageBytes) && !pdfCandidates.some(Boolean)) {
    const text = attachments.length
      ? `${promptText}\n\n${attachments.map((a, index) => `${labelPrefix(labels[index]?.token)}${attachmentPathHint(a)}`).join("\n")}`
      : promptText;
    return options.forceUserMessage ? wrapAsUserMessage(text) : text;
  }

  // Images first: they are always inlined, so a PDF only gets the budget the
  // images in the same message leave, wherever it sits in the list.
  const parts = new Map<number, Array<Record<string, unknown>>>();
  for (const [index, attachment] of attachments.entries()) {
    if (!sendsImageBytes(attachment)) continue;
    parts.set(index, await buildImageParts(attachment, labels[index]?.token, options));
  }
  for (const [index, attachment] of attachments.entries()) {
    if (!pdfCandidates[index] || !budget) continue;
    const token = labels[index]?.token;
    const document = readPdfDocumentBlock(attachment, budget, options.retainedSpent, options.baseDir, options.logger);
    // A PDF that does not fit goes as the same path hint every file gets, so
    // Claude can still read it with its own tools.
    if (!document) continue;
    parts.set(index, [
      ...(token ? [{ type: "text", text: `\n${token}` }] : []),
      document,
    ]);
  }

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: promptText },
  ];
  for (const [index, attachment] of attachments.entries()) {
    const built = parts.get(index);
    if (built) {
      content.push(...built);
      continue;
    }
    content.push({ type: "text", text: `\n${labelPrefix(labels[index]?.token)}${attachmentPathHint(attachment)}` });
  }

  return {
    type: "user",
    session_id: options.sessionId?.trim() ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

/** The content parts for one image attachment: its label and bytes, or a hint. */
async function buildImageParts(
  attachment: ResolvedAgentChatFileRef,
  token: string | undefined,
  options: BuildClaudeV2MessageOptions,
): Promise<Array<Record<string, unknown>>> {
  try {
    const mediaType = inferAttachmentMediaType(attachment);
    if (!PROVIDER_IMAGE_BYTE_MEDIA_TYPES.has(mediaType)) {
      return [{
        type: "text",
        text: `\n${labelPrefix(token)}${imageAttachmentReferenceText(attachment.path, mediaType)}`,
      }];
    }
    const secureRoot = attachment._rootPath ?? options.baseDir;
    const resolvedPath = attachment._resolvedPath ?? attachment.path;
    if (!secureRoot) {
      return [{ type: "text", text: `\n${labelPrefix(token)}[Image unavailable: ${attachment.path}]` }];
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
    const label = token ? [{ type: "text", text: `\n${token}` }] : [];
    if (fitted.kind === "omit") {
      return [...label, imageNotInlinedHintPart(attachment.path, fitted.reason)];
    }
    if (options.retainedMedia) {
      const retainedBytes = retainedBytesForInline(fitted.data.length);
      options.retainedMedia.bytes += retainedBytes;
      if (options.retainedSpent) options.retainedSpent.bytes += retainedBytes;
    }
    // The label goes right before the image block, so `[Image #2]` in the
    // prompt points the model at this exact image.
    return [...label, {
      type: "image",
      source: { type: "base64", media_type: fitted.mediaType, data: fitted.data.toString("base64") },
    }];
  } catch (error) {
    return [{
      type: "text",
      text: `\n${labelPrefix(token)}[Image unavailable: ${attachment.path}${error instanceof Error ? ` (${error.message})` : ""}]`,
    }];
  }
}
