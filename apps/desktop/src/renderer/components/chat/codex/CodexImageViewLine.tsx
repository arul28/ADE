import { ArrowUpRight } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../../shared/types";
import { isDataUri } from "../../../../shared/chatImageUrls";
import { basenameCrossPlatform } from "../../../../shared/pathDisplay";
import { canOpenInAdeBrowser, openUrlInAdeBrowser } from "../../../lib/openExternal";

type ImageViewEvent = Extract<AgentChatEvent, { type: "codex_image_view" }>;

type CodexImageViewLineProps = {
  event: ImageViewEvent;
};

function deriveDisplayName(event: ImageViewEvent): string {
  if (event.title?.trim()) return event.title.trim();
  if (event.path?.trim()) return basenameCrossPlatform(event.path.trim());
  if (event.url?.trim()) {
    const raw = event.url.trim();
    // A data URI is not a name. Without this the row printed a megabyte of
    // base64 into a truncating span; the image itself renders below.
    if (isDataUri(raw)) return "image";
    try {
      const parsed = new URL(raw);
      const tail = basenameCrossPlatform(parsed.pathname);
      return tail || parsed.hostname;
    } catch {
      return raw;
    }
  }
  return "image";
}

function stripFileUrlPrefix(value: string | null): string | null {
  if (!value) return value;
  if (!/^file:\/\//i.test(value)) return value;
  const raw = value.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function CodexImageViewLine({ event }: CodexImageViewLineProps) {
  const displayName = deriveDisplayName(event);
  // Codex may pass a local path either in `event.path` or as a `file://` URL
  // in `event.url`. Normalize both into a real OS path before handing off to
  // `window.ade.app.openPath` (see plan §B.4).
  const trimmedPath = event.path?.trim() || null;
  const trimmedUrl = event.url?.trim() || null;
  const localPath = stripFileUrlPrefix(trimmedPath)
    ?? (trimmedUrl && /^file:\/\//i.test(trimmedUrl) ? stripFileUrlPrefix(trimmedUrl) : null);
  const url = trimmedUrl
    && !/^file:\/\//i.test(trimmedUrl)
    && canOpenInAdeBrowser(trimmedUrl)
    ? trimmedUrl
    : null;
  const canOpen = Boolean(localPath || url);
  // Only a data URI can be previewed inline: the renderer's CSP pins `img-src`
  // to an explicit host allowlist plus data:/blob:, so a remote URL would paint
  // an empty bordered box (and widening the CSP for this row is not worth an
  // arbitrary-remote-fetch surface). Remote and local sources keep `open`.
  const previewSrc = isDataUri(trimmedUrl) ? trimmedUrl : null;

  const handleOpen = () => {
    if (localPath) {
      void window.ade.app.openPath(localPath).catch(() => undefined);
      return;
    }
    if (url) openUrlInAdeBrowser(url);
  };

  return (
    <div className="flex flex-col gap-2 pl-6 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
      <div className="flex items-center gap-2">
        <span aria-hidden className="select-none text-fg/30">{"↳"}</span>
        <span>Viewing image:</span>
        <span className="min-w-0 truncate font-medium text-fg/80" title={localPath ?? url ?? displayName}>
          {displayName}
        </span>
        {canOpen ? (
          <button
            type="button"
            onClick={handleOpen}
            className="inline-flex items-center gap-0.5 rounded text-fg/45 transition-colors hover:text-fg/85"
            aria-label="Open image"
            title={localPath ? "Open file" : "Open in browser"}
          >
            <ArrowUpRight size={11} weight="bold" />
            <span>open</span>
          </button>
        ) : null}
      </div>
      {previewSrc ? (
        <span className="inline-flex max-w-full rounded-lg border border-white/[0.07] bg-black/25 p-1">
          <img
            src={previewSrc}
            alt={displayName}
            loading="lazy"
            draggable={false}
            className="max-h-60 max-w-full rounded object-contain"
          />
        </span>
      ) : null}
    </div>
  );
}

export default CodexImageViewLine;
