import path from "node:path";
import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";

const IMAGE_FILE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i;

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_FILE_EXTENSION_RE.test(filePath);
}

export function normalizeOpenableImageTarget(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || /^data:/i.test(target)) return null;
  if (isHttpUrl(target)) return target;
  if (!path.isAbsolute(target)) return null;
  if (!isImageFilePath(target)) return null;
  return target;
}

export function latestOpenableImageTarget(events: AgentChatEventEnvelope[]): string | null {
  const acceptTarget = (candidate: unknown): string | null => (
    typeof candidate === "string" ? normalizeOpenableImageTarget(candidate) : null
  );

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event as Record<string, unknown> | undefined;
    if (!event) continue;
    if (event.type === "codex_image_generation") {
      const savedPath = acceptTarget(event.savedPath);
      if (savedPath) return savedPath;
      const result = acceptTarget(event.result);
      if (result) return result;
    }
    if (event.type === "codex_image_view") {
      const local = acceptTarget(event.path);
      if (local) return local;
      const remote = acceptTarget(event.url);
      if (remote) return remote;
    }
  }

  return null;
}

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
