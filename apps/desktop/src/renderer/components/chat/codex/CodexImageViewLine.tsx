import { ArrowUpRight } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../../shared/types";
import { openExternalUrl } from "../../../lib/openExternal";

type ImageViewEvent = Extract<AgentChatEvent, { type: "codex_image_view" }>;

type CodexImageViewLineProps = {
  event: ImageViewEvent;
};

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const m = trimmed.match(/[^\\/]+$/);
  return m ? m[0] : trimmed;
}

function deriveDisplayName(event: ImageViewEvent): string {
  if (event.title?.trim()) return event.title.trim();
  if (event.path?.trim()) return basename(event.path.trim());
  if (event.url?.trim()) {
    try {
      const parsed = new URL(event.url.trim());
      const tail = basename(parsed.pathname);
      return tail || parsed.hostname;
    } catch {
      return event.url.trim();
    }
  }
  return "image";
}

function stripFileUrlPrefix(value: string | null): string | null {
  if (!value) return value;
  if (!/^file:\/\//i.test(value)) return value;
  return value.replace(/^file:\/\//i, "");
}

export function CodexImageViewLine({ event }: CodexImageViewLineProps) {
  const displayName = deriveDisplayName(event);
  // Codex may pass a local path either in `event.path` or as a `file://` URL
  // in `event.url`. Normalize both into a real OS path before handing off to
  // `window.ade.app.openPath` (see plan §B.4).
  const localPath = stripFileUrlPrefix(event.path?.trim() || null)
    ?? (event.url && /^file:\/\//i.test(event.url) ? stripFileUrlPrefix(event.url.trim()) : null);
  const url = event.url?.trim() && !/^file:\/\//i.test(event.url.trim()) ? event.url.trim() : null;
  const canOpen = Boolean(localPath || url);

  const handleOpen = () => {
    if (localPath) {
      void window.ade.app.openPath(localPath).catch(() => undefined);
      return;
    }
    if (url) openExternalUrl(url);
  };

  return (
    <div className="flex items-center gap-2 pl-6 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
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
  );
}

export default CodexImageViewLine;
