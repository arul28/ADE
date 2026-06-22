import React, { useEffect, useState } from "react";
import { ArrowSquareOut, MusicNotes, VideoCamera } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { streamFileBytes } from "../streamBytes";
import type { ViewerProps } from "./types";

const MAX_MEDIA_STREAM_BYTES = 250 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaViewer({ workspaceId, rootPath, tab, content, kind }: ViewerProps & { kind: "audio" | "video" }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Icon = kind === "video" ? VideoCamera : MusicNotes;
  const mimeType = content.mimeType ?? (kind === "video" ? "video/mp4" : "audio/mpeg");

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    if (content.size > MAX_MEDIA_STREAM_BYTES) {
      setError(`File is too large for inline playback (${formatBytes(content.size)}).`);
      return;
    }
    (async () => {
      try {
        const bytes = await streamFileBytes(workspaceId, tab.path, {
          isCancelled: () => cancelled,
          maxBytes: MAX_MEDIA_STREAM_BYTES,
        });
        if (cancelled) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, tab.path, content.size, mimeType]);

  const openExternally = () => {
    void window.ade.app.openPathInEditor?.({ rootPath, relativePath: tab.path, target: "finder" }).catch(() => {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs" style={{ borderColor: COLORS.border }}>
        <Icon size={15} color={COLORS.accent} />
        <span className="truncate" style={{ color: COLORS.textMuted }}>{mimeType}</span>
        <span className="ml-auto" style={{ color: COLORS.textDim }}>{formatBytes(content.size)}</span>
        <button type="button" onClick={openExternally} title="Reveal in Finder" className="rounded p-1 hover:bg-white/5" style={{ color: COLORS.textMuted }}>
          <ArrowSquareOut size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {error ? (
          <div className="max-w-md text-center text-sm" style={{ color: COLORS.textDim }}>{error}</div>
        ) : src && kind === "video" ? (
          <video src={src} controls preload="metadata" className="max-h-full max-w-full" onError={() => setError("This video codec is not supported by Chromium playback.")} />
        ) : src ? (
          <audio src={src} controls preload="metadata" className="w-full max-w-xl" onError={() => setError("This audio codec is not supported by Chromium playback.")} />
        ) : (
          <div className="text-sm" style={{ color: COLORS.textDim }}>Loading {kind}...</div>
        )}
      </div>
    </div>
  );
}
