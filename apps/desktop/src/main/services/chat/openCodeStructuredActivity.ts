import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRemoteOrDataUri } from "../../../shared/chatImageUrls";
import type { AgentChatEvent } from "../../../shared/types";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function localImagePath(url: string): string | null {
  if (/^file:/i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(url) || /^[a-z]:[\\/]/i.test(url)) return url;
  return null;
}

/**
 * The one reader of an OpenCode image `file` part: validates the wire shape,
 * claims the shared dedupe id, and hands both mappers the same viewed parts —
 * so a validation fix on one origin can never silently skip the other.
 */
function readOpenCodeImageFile(
  part: unknown,
  emittedPartIds: Set<string>,
): { itemId: string; url: string; filename: string | null } | null {
  const record = readRecord(part);
  if (record?.type !== "file") return null;
  const mime = readString(record.mime);
  if (!mime?.toLowerCase().startsWith("image/")) return null;
  const itemId = readString(record.id);
  const url = readString(record.url);
  if (!itemId || !url || emittedPartIds.has(itemId)) return null;
  emittedPartIds.add(itemId);
  return { itemId, url, filename: readString(record.filename) };
}

/**
 * OpenCode models and tools expose media as `file` parts, and the two origins
 * mean different things:
 *
 * - an assistant-owned `file` part is model output — a generated image;
 * - a tool `attachment` is what a tool RETURNED (the `read` tool on a PNG, a
 *   screenshot tool), which is an image the agent viewed, never one it made.
 *
 * They share the `file` wire shape, so the origin has to come from the caller.
 * Both reuse existing presentation events (whose `codex_` names predate
 * provider parity) so desktop and TUI get the same compact image output.
 */
export function mapOpenCodeImagePart(args: {
  part: unknown;
  turnId: string;
  emittedPartIds: Set<string>;
}): Extract<AgentChatEvent, { type: "codex_image_generation" }> | null {
  const file = readOpenCodeImageFile(args.part, args.emittedPartIds);
  if (!file) return null;
  const savedPath = localImagePath(file.url);
  return {
    type: "codex_image_generation",
    itemId: file.itemId,
    turnId: args.turnId,
    prompt: file.filename ?? "Generated image",
    result: file.url,
    ...(savedPath ? { savedPath } : {}),
    status: "completed",
  };
}

/**
 * Tool names that PRODUCE media rather than return it. Deliberately tight: a
 * false positive stamps "Image generated" on a file the tool merely read, which
 * is the lie this split exists to remove, so anything unrecognized is treated
 * as a view. Covers the `generate_image` / `image_generation` / `draw` style
 * names image-generation MCP and provider tools use.
 */
const OPENCODE_IMAGE_GENERATION_TOOL = /(?:generate|create|make|draw|render)[_-]?(?:image|picture|photo|art)\b|image[_-]?(?:generate|generation|gen)\b/i;

export function isOpenCodeImageGenerationToolName(tool: string | null | undefined): boolean {
  return typeof tool === "string" && OPENCODE_IMAGE_GENERATION_TOOL.test(tool);
}

/**
 * A tool result's image attachment that the tool did not generate — an
 * OpenCode `read` of a pasted screenshot, an image-search hit, a browser
 * capture. It renders as the `codex_image_view` line, NOT as an
 * image-generation card: calling a tool's returned file "Image generated" told
 * the reader the model had created their old screenshot out of thin air.
 * Attachments from an image-generation tool ({@link isOpenCodeImageGenerationToolName})
 * still go through {@link mapOpenCodeImagePart} and keep the generation card.
 */
export function mapOpenCodeImageAttachment(args: {
  part: unknown;
  turnId: string;
  emittedPartIds: Set<string>;
}): Extract<AgentChatEvent, { type: "codex_image_view" }> | null {
  const file = readOpenCodeImageFile(args.part, args.emittedPartIds);
  if (!file) return null;
  const localPath = localImagePath(file.url);
  const remoteUrl = isRemoteOrDataUri(file.url) ? file.url : null;
  const displayName = file.filename ?? (localPath ? path.basename(localPath) : null);
  return {
    type: "codex_image_view",
    itemId: file.itemId,
    turnId: args.turnId,
    ...(displayName ? { title: displayName } : {}),
    ...(localPath ? { path: localPath } : {}),
    ...(remoteUrl ? { url: remoteUrl } : {}),
    status: "completed",
  };
}
