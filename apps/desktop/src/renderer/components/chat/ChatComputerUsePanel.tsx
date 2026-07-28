import {
  ArrowSquareOut,
  Cube,
  FileText,
  ImageSquare,
  SpinnerGap,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function externalArtifactUrl(uri: string): string | null {
  return /^https?:\/\//i.test(uri) ? uri : null;
}

function localArtifactUrl(uri: string): string | null {
  return /^ade-artifact:\/\/project(?:\/|$)/i.test(uri) ? uri : null;
}

function ArtifactKindIcon({ artifact, size = 14 }: {
  artifact: ComputerUseArtifactView;
  size?: number;
}) {
  if (isImageArtifact(artifact)) return <ImageSquare size={size} weight="duotone" />;
  if (isVideoArtifact(artifact)) return <VideoCamera size={size} weight="duotone" />;
  return <FileText size={size} weight="duotone" />;
}

function useVisibleArtifactPreview(
  artifact: ComputerUseArtifactView,
  allowLocalArtifactProtocol: boolean,
): {
  containerRef: React.RefObject<HTMLDivElement>;
  preview: string | null;
  loading: boolean;
  loaded: boolean;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "220px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    setPreview(null);
    setLoaded(false);
    setLoading(false);
  }, [artifact.id, artifact.uri]);

  useEffect(() => {
    if (
      !visible
      || loaded
      || !artifact.uri
      || (!isImageArtifact(artifact) && !isVideoArtifact(artifact))
    ) return;
    const directPreview = allowLocalArtifactProtocol
      ? localArtifactUrl(artifact.uri)
      : null;
    if (directPreview) {
      setPreview(directPreview);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.ade.computerUse.readArtifactPreview({ uri: artifact.uri })
      .then((dataUrl) => {
        if (cancelled) return;
        setPreview(dataUrl);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setLoaded(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowLocalArtifactProtocol, artifact, loaded, visible]);

  return { containerRef, preview, loading, loaded };
}

function ArtifactLightbox({
  artifact,
  preview,
  onClose,
}: {
  artifact: ComputerUseArtifactView;
  preview: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/82 p-5 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${artifact.title}`}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0d0d11] shadow-[0_32px_120px_rgba(0,0,0,0.75)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-sans text-[12px] font-semibold text-fg/88">{artifact.title}</div>
            <div className="mt-0.5 font-mono text-[9.5px] text-muted-fg/42">
              {kindLabel(artifact.kind)} · {relativeTime(artifact.createdAt)}
            </div>
          </div>
          <button
            type="button"
            autoFocus
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-fg/55 transition-colors hover:bg-white/[0.07] hover:text-fg/85"
            aria-label="Close proof preview"
            onClick={onClose}
          >
            <X size={15} weight="bold" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-black/30 p-3">
          <img
            src={preview}
            alt={artifact.title}
            className="mx-auto block max-h-[calc(100vh-9rem)] max-w-full rounded-xl object-contain"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ChatProofArtifactCard({
  artifact,
  variant = "timeline",
  allowLocalArtifactProtocol = false,
}: {
  artifact: ComputerUseArtifactView;
  variant?: "timeline" | "drawer";
  allowLocalArtifactProtocol?: boolean;
}) {
  const { containerRef, preview, loading, loaded } = useVisibleArtifactPreview(
    artifact,
    allowLocalArtifactProtocol,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const externalUrl = externalArtifactUrl(artifact.uri);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);

  useEffect(() => {
    setMediaFailed(false);
  }, [artifact.id, artifact.uri, preview]);

  const openExternal = useCallback(() => {
    if (!externalUrl) return;
    void window.ade.app.openExternal(externalUrl);
  }, [externalUrl]);

  return (
    <article
      ref={containerRef}
      data-chat-proof-artifact={artifact.id}
      className={cn(
        "group min-w-0 overflow-hidden rounded-2xl border border-white/[0.075] bg-white/[0.028] shadow-[0_16px_44px_-34px_rgba(0,0,0,0.9)]",
        "transition-[border-color,background-color,transform] duration-200 hover:border-white/[0.12] hover:bg-white/[0.04]",
        "w-full",
      )}
    >
      <div className="flex items-start gap-3 px-3.5 pb-2.5 pt-3">
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-violet-300/[0.1] bg-violet-400/[0.075] text-violet-200/70">
          <ArtifactKindIcon artifact={artifact} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] font-semibold text-fg/82">
            {artifact.title}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-muted-fg/38">
            <span className="truncate">{kindLabel(artifact.kind)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{relativeTime(artifact.createdAt)}</span>
          </div>
        </div>
        {externalUrl ? (
          <button
            type="button"
            onClick={openExternal}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 font-sans text-[10px] font-medium text-muted-fg/42 transition-colors hover:bg-white/[0.055] hover:text-fg/75"
          >
            Open
            <ArrowSquareOut size={11} />
          </button>
        ) : null}
      </div>

      <div className={cn("px-2.5", variant === "timeline" ? "pb-2.5" : "pb-3")}>
        {loading ? (
          <div className="flex min-h-36 items-center justify-center rounded-xl border border-white/[0.055] bg-black/18 text-muted-fg/35">
            <SpinnerGap size={18} className="animate-spin" aria-label="Loading proof preview" />
          </div>
        ) : mediaFailed || (loaded && !preview && (image || video)) ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-white/[0.055] bg-black/16 px-4 text-center">
            <WarningCircle size={17} className="text-muted-fg/28" />
            <span className="font-sans text-[10px] leading-4 text-muted-fg/40">
              Preview unavailable{externalUrl ? " here. Open the source to view it." : " from the connected runtime."}
            </span>
          </div>
        ) : preview && image ? (
          <button
            type="button"
            className="block w-full overflow-hidden rounded-xl border border-white/[0.06] bg-black/22 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
            aria-label={`Enlarge ${artifact.title}`}
            onClick={() => setLightboxOpen(true)}
          >
            <img
              src={preview}
              alt={artifact.title}
              onError={() => setMediaFailed(true)}
              className={cn(
                "block w-full object-contain transition-transform duration-300 group-hover:scale-[1.006]",
                variant === "timeline" ? "max-h-[320px]" : "max-h-[240px]",
              )}
            />
          </button>
        ) : preview && video ? (
          <video
            src={preview}
            controls
            preload="metadata"
            onError={() => setMediaFailed(true)}
            className={cn(
              "block w-full rounded-xl border border-white/[0.06] bg-black",
              variant === "timeline" ? "max-h-[320px]" : "max-h-[240px]",
            )}
          />
        ) : !image && !video ? (
          <div className="flex min-h-20 items-center gap-3 rounded-xl border border-white/[0.05] bg-black/14 px-3.5 py-3">
            <FileText size={18} weight="duotone" className="shrink-0 text-muted-fg/30" />
            <div className="min-w-0 font-sans text-[10.5px] leading-4 text-muted-fg/44">
              {artifact.description?.trim() || "Supporting artifact collected with this chat."}
            </div>
          </div>
        ) : null}

        {artifact.description?.trim() && (image || video) ? (
          <p className="mt-2 px-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] leading-4 text-muted-fg/46">
            {artifact.description.trim()}
          </p>
        ) : null}
      </div>

      {lightboxOpen && preview && image ? (
        <ArtifactLightbox
          artifact={artifact}
          preview={preview}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
    </article>
  );
}

export function ChatProofTimeline({
  artifacts,
  onOpenDrawer,
  allowLocalArtifactProtocol = false,
}: {
  artifacts: ComputerUseArtifactView[];
  onOpenDrawer?: () => void;
  allowLocalArtifactProtocol?: boolean;
}) {
  const visibleArtifacts = useMemo(
    () => [...artifacts]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-6),
    [artifacts],
  );
  if (!visibleArtifacts.length) return null;
  const hiddenCount = Math.max(0, artifacts.length - visibleArtifacts.length);

  return (
    <section data-chat-proof-timeline="" className="mt-5 min-w-0 pb-1">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="h-px flex-1 bg-white/[0.055]" />
        <div className="inline-flex items-center gap-1.5 px-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-muted-fg/44">
          <Cube size={11} weight="duotone" />
          Proof collected in this chat
          <span className="rounded-full bg-white/[0.055] px-1.5 font-mono text-[8.5px] tabular-nums text-fg/52">
            {artifacts.length}
          </span>
        </div>
        <span className="h-px flex-1 bg-white/[0.055]" />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2.5">
        {visibleArtifacts.map((artifact) => (
          <ChatProofArtifactCard
            key={artifact.id}
            artifact={artifact}
            variant="timeline"
            allowLocalArtifactProtocol={allowLocalArtifactProtocol}
          />
        ))}
      </div>
      {hiddenCount > 0 && onOpenDrawer ? (
        <button
          type="button"
          className="mt-2.5 w-full rounded-xl border border-white/[0.055] bg-white/[0.018] py-2 font-sans text-[10.5px] text-muted-fg/46 transition-colors hover:border-white/[0.1] hover:bg-white/[0.04] hover:text-fg/68"
          onClick={onOpenDrawer}
        >
          View {hiddenCount} earlier proof item{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </section>
  );
}

export function ChatComputerUsePanel({
  snapshot,
  onRefresh,
  allowLocalArtifactProtocol = false,
}: {
  snapshot: ComputerUseOwnerSnapshot | null;
  onRefresh: () => void | Promise<void>;
  allowLocalArtifactProtocol?: boolean;
}) {
  const artifacts = snapshot?.artifacts ?? [];

  if (!snapshot || artifacts.length === 0) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center px-5 py-8 text-center">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.025] text-muted-fg/25">
          <Cube size={18} weight="duotone" />
        </div>
        <div className="mt-3 font-sans text-[12px] font-medium text-fg/55">No proof collected yet</div>
        <div className="mt-1 max-w-64 font-sans text-[10.5px] leading-4 text-muted-fg/38">
          Screenshots, recordings, browser captures, and other intentional proof attached to this chat will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="font-sans text-[10.5px] text-muted-fg/42">
          {artifacts.length} item{artifacts.length === 1 ? "" : "s"} collected
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="rounded-lg px-2 py-1 font-sans text-[10px] text-muted-fg/42 transition-colors hover:bg-white/[0.05] hover:text-fg/68"
        >
          Refresh
        </button>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2.5">
        {artifacts.map((artifact) => (
          <ChatProofArtifactCard
            key={artifact.id}
            artifact={artifact}
            variant="drawer"
            allowLocalArtifactProtocol={allowLocalArtifactProtocol}
          />
        ))}
      </div>
    </div>
  );
}
