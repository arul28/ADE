import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * OpenCode models and tools expose generated media as `file` parts. Reuse the
 * existing image-generation presentation event (whose name predates provider
 * parity) so desktop and TUI get the same compact image output immediately.
 */
export function mapOpenCodeImagePart(args: {
  part: unknown;
  turnId: string;
  emittedPartIds: Set<string>;
}): Extract<AgentChatEvent, { type: "codex_image_generation" }> | null {
  const part = readRecord(args.part);
  if (part?.type !== "file") return null;
  const mime = readString(part.mime);
  if (!mime?.toLowerCase().startsWith("image/")) return null;
  const itemId = readString(part.id);
  const url = readString(part.url);
  if (!itemId || !url || args.emittedPartIds.has(itemId)) return null;
  args.emittedPartIds.add(itemId);
  const filename = readString(part.filename);
  const savedPath = localImagePath(url);
  return {
    type: "codex_image_generation",
    itemId,
    turnId: args.turnId,
    prompt: filename ?? "Generated image",
    result: url,
    ...(savedPath ? { savedPath } : {}),
    status: "completed",
  };
}
