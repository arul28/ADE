import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerUseArtifactView, ComputerUseOwnerSnapshot } from "../../../shared/types";
import { cn } from "../ui/cn";

function isImageArtifact(artifact: ComputerUseArtifactView): boolean {
  return artifact.kind === "screenshot" || (artifact.mimeType?.startsWith("image/") ?? false);
}

function isVideoArtifact(artifact: ComputerUseArtifactView): boolean {
  return artifact.kind === "video_recording" || (artifact.mimeType?.startsWith("video/") ?? false);
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** Convert an artifact URI to an ade-artifact:// URL that Electron's custom protocol can serve. Remote http(s) URLs return null (no automatic preview / no renderer fetch). */
function toPreviewSrc(uri: string): string | null {
  if (/^https?:\/\//i.test(uri)) return null;
  // Strip file:// prefix if present
  let filePath = uri;
  if (filePath.startsWith("file://")) {
    try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { filePath = filePath.replace(/^file:\/\//i, ""); }
  }
  // For relative paths, we can't resolve here — the protocol handler in main will need the project root.
  // But artifacts stored by the broker are typically absolute or relative to project root.
  const encoded = new URL(filePath, "file://").pathname;
  return `ade-artifact://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

function fileUriToFsPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return uri.replace(/^file:\/\//i, "");
  }
}

function openInSystemPlayer(uri: string) {
  if (/^https?:\/\//i.test(uri)) {
    void window.ade.app.openExternal(uri);
  } else {
    const fsPath = fileUriToFsPath(uri);
    window.ade.app.openPath(fsPath).catch((err: unknown) => {
      console.error("[ChatComputerUsePanel] Failed to open local path:", fsPath, err);
    });
  }
}

function PreviewFallback({
  message,
  actionLabel,
  onOpen,
}: {
  message: string;
  actionLabel: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-md border border-white/[0.06] bg-black/20 px-3 py-4 text-center">
      <div className="text-[11px] text-fg/40">{message}</div>
      <button
        type="button"
        onClick={onOpen}
        className="rounded-md border border-white/[0.08] px-2.5 py-1 text-[11px] text-fg/50 transition-colors hover:bg-white/[0.04] hover:text-fg/70"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function VideoPreview({ artifact, src }: { artifact: ComputerUseArtifactView; src: string | null }) {
  const [canPlay, setCanPlay] = useState(true);
  const stalledTimeoutRef = useRef<number | null>(null);

  const clearStalledTimeout = useCallback(() => {
    if (stalledTimeoutRef.current == null) return;
    window.clearTimeout(stalledTimeoutRef.current);
    stalledTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    setCanPlay(true);
    clearStalledTimeout();
    return clearStalledTimeout;
  }, [clearStalledTimeout, src]);

  const handlePlaybackRecovered = useCallback(() => {
    clearStalledTimeout();
    setCanPlay(true);
  }, [clearStalledTimeout]);

  const handlePlaybackError = useCallback(() => {
    clearStalledTimeout();
    setCanPlay(false);
  }, [clearStalledTimeout]);

  const handleStalled = useCallback(() => {
    clearStalledTimeout();
    stalledTimeoutRef.current = window.setTimeout(() => {
      stalledTimeoutRef.current = null;
      setCanPlay(false);
    }, 3000);
  }, [clearStalledTimeout]);

  if (!src) {
    return (
      <PreviewFallback
        message="Video preview unavailable for this URI."
        actionLabel="Open in system player"
        onOpen={() => artifact.uri && openInSystemPlayer(artifact.uri)}
      />
    );
  }

  if (!canPlay) {
    return (
      <PreviewFallback
        message="Video preview unavailable."
        actionLabel="Open in system player"
        onOpen={() => artifact.uri && openInSystemPlayer(artifact.uri)}
      />
    );
  }

  return (
    <video
      src={src}
      controls
      className="block max-h-[360px] w-full rounded-md border border-white/[0.06] bg-black"
      onCanPlay={handlePlaybackRecovered}
      onPlaying={handlePlaybackRecovered}
      onError={handlePlaybackError}
      onStalled={handleStalled}
    />
  );
}

function ImagePreview({ artifact, src }: { artifact: ComputerUseArtifactView; src: string | null }) {
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [src]);

  if (!src) {
    return (
      <PreviewFallback
        message="Image preview unavailable for this URI."
        actionLabel="Open in system viewer"
        onOpen={() => artifact.uri && openInSystemPlayer(artifact.uri)}
      />
    );
  }

  if (imageError) {
    return (
      <PreviewFallback
        message="Image preview unavailable."
        actionLabel="Open in system viewer"
        onOpen={() => artifact.uri && openInSystemPlayer(artifact.uri)}
      />
    );
  }

  return (
    <img
      src={src}
      alt={artifact.title}
      className="block max-h-[360px] w-full rounded-md border border-white/[0.06] object-contain"
      onError={() => setImageError(true)}
    />
  );
}

function ArtifactPreview({ artifact }: { artifact: ComputerUseArtifactView }) {
  if (!artifact.uri) return null;

  if (/^https?:\/\//i.test(artifact.uri)) {
    return (
      <PreviewFallback
        message="Remote artifact — preview disabled. Open to view in your browser."
        actionLabel="Open"
        onOpen={() => openInSystemPlayer(artifact.uri!)}
      />
    );
  }

  const src = toPreviewSrc(artifact.uri);

  if (isImageArtifact(artifact)) {
    return <ImagePreview artifact={artifact} src={src} />;
  }

  if (isVideoArtifact(artifact)) {
    return <VideoPreview artifact={artifact} src={src} />;
  }

  return null;
}

export function ChatComputerUsePanel({
  sessionId,
  snapshot,
  onRefresh,
}: {
  sessionId: string;
  snapshot: ComputerUseOwnerSnapshot | null;
  onRefresh: () => void | Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const artifacts = useMemo(() => snapshot?.artifacts ?? [], [snapshot]);
  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? artifacts[0] ?? null,
    [selectedId, artifacts],
  );

  useEffect(() => {
    setSelectedId((current) =>
      current && artifacts.some((a) => a.id === current)
        ? current
        : artifacts[0]?.id ?? null,
    );
  }, [artifacts]);

  const handleReveal = useCallback(() => {
    if (!selected?.uri) return;
    if (/^https?:\/\//i.test(selected.uri)) {
      window.ade.app.openExternal(selected.uri).catch((err: unknown) => {
        console.error("[ChatComputerUsePanel] Failed to open external URL:", selected.uri, err);
      });
    } else if (selected.uri.startsWith("file://")) {
      window.ade.app.revealPath(fileUriToFsPath(selected.uri)).catch((err: unknown) => {
        console.error("[ChatComputerUsePanel] Failed to reveal path:", selected.uri, err);
      });
    } else {
      window.ade.app.revealPath(selected.uri).catch((err: unknown) => {
        console.error("[ChatComputerUsePanel] Failed to reveal path:", selected.uri, err);
      });
    }
  }, [selected]);

  const handleAccept = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.ade.computerUse.updateArtifactReview({
        artifactId: selected.id,
        reviewState: "accepted",
        workflowState: "promoted",
      });
      await onRefresh();
    } catch (err) {
      console.error("[ChatComputerUsePanel] Failed to accept artifact review:", selected.id, err);
    } finally {
      setBusy(false);
    }
  }, [selected, onRefresh]);

  const handleDismiss = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.ade.computerUse.updateArtifactReview({
        artifactId: selected.id,
        reviewState: "dismissed",
        workflowState: "dismissed",
      });
      await onRefresh();
    } catch (err) {
      console.error("[ChatComputerUsePanel] Failed to dismiss artifact review:", selected.id, err);
    } finally {
      setBusy(false);
    }
  }, [selected, onRefresh]);

  if (!snapshot || artifacts.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-fg/30">
        No artifacts captured yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-fg/70">Proof</span>
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/[0.08] px-1.5 text-[10px] font-medium tabular-nums text-fg/50">
            {artifacts.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={busy}
          className="rounded px-1.5 py-0.5 text-[10px] text-fg/40 transition-colors hover:bg-white/[0.06] hover:text-fg/60"
        >
          Refresh
        </button>
      </div>

      {/* Thumbnail strip */}
      {artifacts.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setSelectedId(artifact.id)}
              className={cn(
                "shrink-0 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                selected?.id === artifact.id
                  ? "border-sky-400/30 bg-sky-500/10"
                  : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.12]",
              )}
            >
              <div className="text-[10px] font-medium text-fg/60 whitespace-nowrap">
                {kindLabel(artifact.kind)}
              </div>
              <div className="mt-0.5 text-[10px] text-fg/30 whitespace-nowrap">
                {artifact.backendName}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Selected artifact */}
      {selected && (
        <>
          <ArtifactPreview artifact={selected} />

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[11px] text-fg/60">{selected.title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-fg/30">
                <span>{kindLabel(selected.kind)}</span>
                <span className={cn(
                  "rounded px-1 py-px text-[9px] font-medium",
                  selected.reviewState === "accepted" ? "bg-emerald-500/15 text-emerald-300/70" :
                  selected.reviewState === "dismissed" ? "bg-red-500/15 text-red-300/70" :
                  "bg-white/[0.06] text-fg/40",
                )}>
                  {selected.reviewState}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {selected.reviewState === "pending" && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleAccept()}
                    disabled={busy}
                    className="rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300/80 transition-colors hover:bg-emerald-500/20"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDismiss()}
                    disabled={busy}
                    className="rounded-md border border-white/[0.06] px-2 py-1 text-[10px] font-medium text-fg/40 transition-colors hover:bg-white/[0.06] hover:text-fg/60"
                  >
                    Dismiss
                  </button>
                </>
              )}
              {selected.uri && (
                <button
                  type="button"
                  onClick={handleReveal}
                  className="rounded-md border border-white/[0.06] px-2 py-1 text-[10px] font-medium text-fg/40 transition-colors hover:bg-white/[0.06] hover:text-fg/60"
                >
                  Reveal
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
