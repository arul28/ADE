import {
  ArrowSquareOut,
  Cube,
  FileText,
  ImageSquare,
  MagnifyingGlass,
  Play,
  SpinnerGap,
  Trash,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ComputerUseArtifactDeleteResult,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
} from "../../../shared/types";
import {
  proofRecordedBeforeRequestLine,
  readProofProvenance,
} from "../../../shared/proofProvenance";
import { cn } from "../ui/cn";
import { MediaLightbox } from "../ui/MediaLightbox";
import { INPUT_CLASS_NAME } from "../lanes/laneDialogTokens";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  buildProofDrawerGroups,
  EMPTY_PROOF_DRAWER_FILTER,
  proofArtifactPullRequest,
  type ProofDrawerFilter,
  type ProofDrawerItem,
} from "../../../shared/proofDrawerModel";
import { Banner } from "../ui/notice/Banner";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import {
  externalArtifactUrl,
  isBrokenArtifact,
  isImageArtifact,
  isVideoArtifact,
  recoverableArtifactSource,
  useArtifactPreview,
} from "./useArtifactPreview";

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

function assertArtifactDeletionSucceeded(result: ComputerUseArtifactDeleteResult): void {
  if (result.failed.length === 0) return;
  throw new Error(result.failed.map((failure) => failure.reason).join("; "));
}

/**
 * Whether an attached video predates the request: the one provenance fact a
 * proof surface prints. Where the bytes came from is kept in the record and
 * not drawn; the owner found the "Captured by ADE" lines to be noise.
 */
export function ProofProvenanceLines({ artifact, warningClassName }: {
  artifact: ComputerUseArtifactView;
  className?: string;
  warningClassName: string;
}) {
  const older = proofRecordedBeforeRequestLine(readProofProvenance(artifact.metadata));
  if (!older) return null;
  return (
    <div data-proof-recorded-before-request="" className={cn("truncate", warningClassName)} title={older}>
      {older}
    </div>
  );
}

export function ProofPreviewFailureNotice({ failureText }: { failureText: string }) {
  return (
    <Banner
      model={{ id: "proof-preview-failed", tone: "warning", title: failureText }}
      layout="inline"
    />
  );
}

function ArtifactKindIcon({ artifact, size = 14 }: {
  artifact: ComputerUseArtifactView;
  size?: number;
}) {
  if (isImageArtifact(artifact)) return <ImageSquare size={size} weight="duotone" />;
  if (isVideoArtifact(artifact)) return <VideoCamera size={size} weight="duotone" />;
  return <FileText size={size} weight="duotone" />;
}

/**
 * A still of the recording's first frame with a play badge. The small tile
 * never shows native controls or crops the frame. A tall simulator recording
 * and a wide Mac recording both letterbox on black. Clicking opens the
 * lightbox, which plays it at its own size.
 */
function VideoProofPoster({
  artifact,
  preview,
  className,
  badgeSize,
  onOpen,
  onError,
}: {
  artifact: ComputerUseArtifactView;
  preview: string;
  className: string;
  badgeSize: "sm" | "md";
  onOpen: () => void;
  onError: () => void;
}) {
  return (
    <button
      type="button"
      className="relative block w-full overflow-hidden bg-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-violet-300/45"
      aria-label={`Play ${artifact.title}`}
      onClick={onOpen}
    >
      <video
        src={preview}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden
        onError={onError}
        className={cn("pointer-events-none block w-full bg-black object-contain", className)}
      />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-white/[0.16] bg-black/58 text-white/88 shadow-[0_6px_20px_rgba(0,0,0,0.55)] backdrop-blur-sm transition-transform duration-200 group-hover:scale-105 group-hover/tile:scale-105",
            badgeSize === "sm" ? "h-6 w-6" : "h-10 w-10",
          )}
        >
          <Play size={badgeSize === "sm" ? 10 : 15} weight="fill" className="translate-x-px" />
        </span>
      </span>
    </button>
  );
}

/**
 * A proof picture or video opened full size, in ADE's one media viewer. Copy
 * and download read the bytes through the chat's runtime, so they work for
 * proof on this computer, on a paired one and in the web client.
 */
export function ArtifactLightbox({
  artifact,
  preview,
  onMediaError,
  onClose,
}: {
  artifact: ComputerUseArtifactView;
  preview: string;
  onMediaError: () => void;
  onClose: () => void;
}) {
  const scope = useChatRuntimeScope();
  const readDataUrl = useCallback(
    () => window.ade.computerUse.readArtifactPreview({ uri: artifact.uri }, scope.pin),
    [artifact.uri, scope.pin],
  );
  return (
    <MediaLightbox
      src={preview}
      kind={isImageArtifact(artifact) ? "image" : "video"}
      title={artifact.description?.trim() || artifact.title}
      readDataUrl={externalArtifactUrl(artifact.uri) ? undefined : readDataUrl}
      onMediaError={onMediaError}
      onClose={onClose}
    />
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
  const {
    containerRef,
    preview,
    loading,
    failed,
    explanation,
    onMediaError,
  } = useArtifactPreview(artifact, allowLocalArtifactProtocol);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const externalUrl = externalArtifactUrl(artifact.uri);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);
  const failureText = externalUrl ? "This proof lives at its source. Open it to view." : explanation;

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
          <ProofProvenanceLines
            artifact={artifact}
            className="mt-0.5 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-muted-fg/40"
            warningClassName="mt-0.5 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-200/60"
          />
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
        ) : failed ? (
          // Broken proof shrinks. A full-height empty box wastes the most
          // valuable space in a 322px rail to say nothing.
          <ProofPreviewFailureNotice failureText={failureText} />
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
              onError={onMediaError}
              className={cn(
                "block w-full object-contain transition-transform duration-300 group-hover:scale-[1.006]",
                variant === "timeline" ? "max-h-[320px]" : "max-h-[240px]",
              )}
            />
          </button>
        ) : preview && video ? (
          <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-black">
            <VideoProofPoster
              artifact={artifact}
              preview={preview}
              badgeSize="md"
              className={variant === "timeline" ? "h-[320px]" : "h-[240px]"}
              onOpen={() => setLightboxOpen(true)}
              onError={onMediaError}
            />
          </div>
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

      {lightboxOpen && preview && (image || video) ? (
        <ArtifactLightbox
          artifact={artifact}
          preview={preview}
          onMediaError={onMediaError}
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

/**
 * A drawer tile. The rail is ~322px wide, so this is a two-up thumbnail with
 * the label underneath rather than the full timeline card at reduced height —
 * that layout truncated every title to "ADE Activity…" and collapsed the
 * metadata line to "screens… · 7h ago".
 */
function DrawerProofTile({
  artifact,
  allowLocalArtifactProtocol,
  busy,
  onDelete,
  onRecover,
}: {
  artifact: ComputerUseArtifactView;
  allowLocalArtifactProtocol: boolean;
  busy: boolean;
  onDelete: (artifact: ComputerUseArtifactView) => void;
  onRecover: (artifact: ComputerUseArtifactView) => void;
}) {
  const {
    containerRef,
    preview,
    loading,
    failed,
    explanation,
    onMediaError,
  } = useArtifactPreview(artifact, allowLocalArtifactProtocol);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);
  const externalUrl = externalArtifactUrl(artifact.uri);
  const storedFileMissing = isBrokenArtifact(artifact);
  const hasPreviewProblem = storedFileMissing || failed;
  const failureText = externalUrl ? "Stored at its source." : explanation;
  const recoverable = recoverableArtifactSource(artifact) !== null;
  const pullRequest = proofArtifactPullRequest(artifact);

  return (
    <div
      ref={containerRef}
      data-chat-proof-artifact={artifact.id}
      className={cn(
        "group/tile relative flex min-w-0 flex-col gap-1.5",
        busy && "pointer-events-none opacity-45",
      )}
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border bg-black/22",
          hasPreviewProblem
            ? "border-amber-200/[0.11] bg-amber-300/[0.03]"
            : "border-white/[0.07]",
        )}
      >
        {hasPreviewProblem ? (
          // Missing or unpreviewable items shrink to a short strip instead of
          // wasting the drawer rail on an empty thumbnail.
          <div className="flex h-14 items-center justify-center px-2">
            <WarningCircle size={15} weight="duotone" className="text-amber-200/45" />
          </div>
        ) : loading ? (
          <div className="flex h-[74px] items-center justify-center text-muted-fg/30">
            <SpinnerGap size={15} className="animate-spin" aria-label="Loading proof preview" />
          </div>
        ) : preview && image ? (
          <button
            type="button"
            className="block w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
            aria-label={`Enlarge ${artifact.title}`}
            onClick={() => setLightboxOpen(true)}
          >
            <img
              src={preview}
              alt={artifact.title}
              onError={onMediaError}
              className="block h-[74px] w-full object-cover"
            />
          </button>
        ) : preview && video ? (
          <VideoProofPoster
            artifact={artifact}
            preview={preview}
            badgeSize="sm"
            className="h-[74px]"
            onOpen={() => setLightboxOpen(true)}
            onError={onMediaError}
          />
        ) : (
          <div className="flex h-[74px] items-center justify-center text-muted-fg/28">
            <ArtifactKindIcon artifact={artifact} size={17} />
          </div>
        )}

        <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover/tile:opacity-100 focus-within:opacity-100">
          {externalUrl ? (
            <button
              type="button"
              aria-label={`Open ${artifact.title} at its source`}
              onClick={() => void window.ade.app.openExternal(externalUrl)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-black/62 text-fg/60 backdrop-blur-sm transition-colors hover:text-fg/95"
            >
              <ArrowSquareOut size={10} weight="bold" />
            </button>
          ) : null}
          {storedFileMissing && recoverable ? (
            <button
              type="button"
              aria-label={`Locate ${artifact.title} in its lane`}
              onClick={() => onRecover(artifact)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-black/62 text-fg/60 backdrop-blur-sm transition-colors hover:text-fg/95"
            >
              <MagnifyingGlass size={10} weight="bold" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Delete ${artifact.title}`}
            onClick={() => onDelete(artifact)}
            className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-black/62 text-fg/60 backdrop-blur-sm transition-colors hover:bg-red-500/70 hover:text-white"
          >
            <Trash size={10} weight="bold" />
          </button>
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1 truncate font-sans text-[10.5px] font-medium leading-[14px] text-fg/74" title={artifact.title}>
            {artifact.title}
          </div>
          {pullRequest ? (
            <button
              type="button"
              title={`Posted to ${pullRequest.label}`}
              onClick={() => void window.ade.app.openExternal(pullRequest.url)}
              className="shrink-0 rounded-full border border-emerald-300/[0.16] bg-emerald-400/[0.07] px-1.5 font-mono text-[8.5px] leading-[14px] text-emerald-200/75 transition-colors hover:text-emerald-100"
            >
              {pullRequest.label}
            </button>
          ) : null}
        </div>
        <div className="truncate font-mono text-[8.5px] leading-[13px] text-muted-fg/34">
          {relativeTime(artifact.createdAt)}
        </div>
        <ProofProvenanceLines
          artifact={artifact}
          className="font-sans text-[9px] leading-[13px] text-muted-fg/38"
          warningClassName="font-sans text-[9px] leading-[13px] text-amber-200/55"
        />
        {hasPreviewProblem ? (
          <div className="mt-1 font-sans text-[9px] leading-[13px] text-amber-200/40">
            {failureText}
          </div>
        ) : null}
      </div>

      {lightboxOpen && preview && (image || video) ? (
        <ArtifactLightbox
          artifact={artifact}
          preview={preview}
          onMediaError={onMediaError}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
    </div>
  );
}

const EMPTY_EVENTS: readonly AgentChatEventEnvelope[] = [];

const MEDIA_FILTERS: ReadonlyArray<{ value: ProofDrawerFilter["media"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "pictures", label: "Pictures" },
  { value: "videos", label: "Videos" },
];

function DrawerSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="col-span-2 font-sans text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-fg/40">
      {children}
    </div>
  );
}

function DrawerItems({
  items,
  tileProps,
}: {
  items: ProofDrawerItem[];
  tileProps: Omit<React.ComponentProps<typeof DrawerProofTile>, "artifact" | "busy"> & { busyIds: ReadonlySet<string> };
}) {
  const { busyIds, ...rest } = tileProps;
  return (
    <>
      {items.map((item) => item.kind === "pair" ? (
        <div key={`${item.before.id}:${item.after.id}`} data-proof-drawer-pair="" className="col-span-2 flex min-w-0 flex-col gap-1.5">
          <div className="grid min-w-0 grid-cols-2 gap-x-2">
            {([["Before", item.before], ["After", item.after]] as const).map(([side, artifact]) => (
              <div key={side} className="min-w-0">
                <div className="mb-1 font-sans text-[8.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/40">{side}</div>
                <DrawerProofTile {...rest} artifact={artifact} busy={busyIds.has(artifact.id)} />
              </div>
            ))}
          </div>
          {item.caption ? (
            <div className="font-sans text-[10px] leading-[14px] text-fg/60">{item.caption}</div>
          ) : null}
        </div>
      ) : (
        <DrawerProofTile key={item.artifact.id} {...rest} artifact={item.artifact} busy={busyIds.has(item.artifact.id)} />
      ))}
    </>
  );
}

export function ChatComputerUsePanel({
  snapshot,
  events = EMPTY_EVENTS,
  onRefresh,
  allowLocalArtifactProtocol = false,
}: {
  snapshot: ComputerUseOwnerSnapshot | null;
  /** The chat's transcript, which says what each turn's answer showed. */
  events?: readonly AgentChatEventEnvelope[];
  onRefresh: () => void | Promise<void>;
  allowLocalArtifactProtocol?: boolean;
}) {
  const scope = useChatRuntimeScope();
  // Stable identity: `?? []` would hand every memo below a fresh array each
  // render and defeat them.
  const artifacts = useMemo(() => snapshot?.artifacts ?? [], [snapshot]);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<ProofDrawerFilter>(EMPTY_PROOF_DRAWER_FILTER);
  const groups = useMemo(
    () => buildProofDrawerGroups(artifacts, events, filter),
    [artifacts, events, filter],
  );
  const filtered = filter.query.trim() !== "" || filter.media !== "all" || filter.inAnswerOnly;

  const brokenCount = useMemo(
    () => artifacts.filter((artifact) => isBrokenArtifact(artifact)).length,
    [artifacts],
  );

  const withBusy = useCallback(
    async (ids: string[], run: () => Promise<unknown>) => {
      setError(null);
      setBusyIds((current) => new Set([...current, ...ids]));
      try {
        await run();
        await onRefresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyIds((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [onRefresh],
  );

  const handleDelete = useCallback(
    (artifact: ComputerUseArtifactView) => {
      void withBusy([artifact.id], async () => {
        const result = await window.ade.computerUse.deleteArtifacts({ artifactId: artifact.id }, scope.pin);
        assertArtifactDeletionSucceeded(result);
      });
    },
    [scope.pin, withBusy],
  );

  const handleRecover = useCallback(
    (artifact: ComputerUseArtifactView) => {
      void withBusy([artifact.id], () =>
        window.ade.computerUse.recoverArtifact({ artifactId: artifact.id }, scope.pin),
      );
    },
    [scope.pin, withBusy],
  );

  const handlePruneBroken = useCallback(() => {
    const ids = artifacts.filter((artifact) => isBrokenArtifact(artifact)).map((artifact) => artifact.id);
    if (!ids.length) return;
    void withBusy(ids, async () => {
      const result = await window.ade.computerUse.deleteArtifacts({ artifactIds: ids }, scope.pin);
      assertArtifactDeletionSucceeded(result);
    });
  }, [artifacts, scope.pin, withBusy]);

  if (!snapshot || artifacts.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="font-sans text-[10.5px] text-muted-fg/42">
          {artifacts.length} item{artifacts.length === 1 ? "" : "s"}
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="rounded-lg px-2 py-1 font-sans text-[10px] text-muted-fg/42 transition-colors hover:bg-white/[0.05] hover:text-fg/68"
        >
          Refresh
        </button>
      </div>

      {brokenCount > 0 ? (
        <Banner
          model={{
            id: "proof-artifacts-missing-files",
            tone: "warning",
            title: `${brokenCount} item${brokenCount === 1 ? " has" : "s have"} no stored file.`,
            actions: [{ label: `Remove ${brokenCount === 1 ? "it" : "them"}`, onClick: handlePruneBroken }],
          }}
          layout="inline"
        />
      ) : null}

      {error ? (
        <Banner model={{ id: "proof-artifact-error", tone: "error", title: error }} layout="inline" />
      ) : null}

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="relative">
          <MagnifyingGlass
            size={12}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/50"
          />
          <input
            value={filter.query}
            onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
            placeholder="Search proof"
            aria-label="Search proof"
            className={cn(INPUT_CLASS_NAME, "mt-0 h-7 pl-7 text-[11px]")}
          />
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {MEDIA_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter.media === option.value}
              onClick={() => setFilter((current) => ({ ...current, media: option.value }))}
              className={cn(
                "rounded-md px-2 py-0.5 font-sans text-[10px] transition-colors",
                filter.media === option.value
                  ? "bg-white/[0.09] text-fg/85"
                  : "text-muted-fg/50 hover:bg-white/[0.05] hover:text-fg/70",
              )}
            >
              {option.label}
            </button>
          ))}
          <span className="mx-0.5 h-3 w-px bg-white/[0.08]" aria-hidden />
          <button
            type="button"
            aria-pressed={filter.inAnswerOnly}
            onClick={() => setFilter((current) => ({ ...current, inAnswerOnly: !current.inAnswerOnly }))}
            className={cn(
              "rounded-md px-2 py-0.5 font-sans text-[10px] transition-colors",
              filter.inAnswerOnly
                ? "bg-white/[0.09] text-fg/85"
                : "text-muted-fg/50 hover:bg-white/[0.05] hover:text-fg/70",
            )}
          >
            In answers
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="px-0.5 py-3 font-sans text-[11px] text-muted-fg/50">
          {filtered ? "No proof matches." : "No proof yet."}
        </div>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} data-proof-drawer-turn={group.turnId ?? "earlier"} className="flex min-w-0 flex-col gap-2 pt-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <div
              className="line-clamp-2 min-w-0 flex-1 font-sans text-[11px] font-medium leading-[15px] text-fg/78"
              title={group.prompt ?? undefined}
            >
              {group.turnId ? group.prompt ?? "A turn" : "Earlier in this chat"}
            </div>
            <div className="shrink-0 font-mono text-[8.5px] text-muted-fg/34">{relativeTime(group.at)}</div>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-3">
            {group.inAnswer.length > 0 && group.other.length > 0 ? <DrawerSectionLabel>In the answer</DrawerSectionLabel> : null}
            <DrawerItems
              items={group.inAnswer}
              tileProps={{ allowLocalArtifactProtocol, busyIds, onDelete: handleDelete, onRecover: handleRecover }}
            />
            {group.other.length > 0 ? (
              <DrawerSectionLabel>{group.inAnswer.length > 0 ? "Also filed" : "Not in an answer"}</DrawerSectionLabel>
            ) : null}
            <DrawerItems
              items={group.other}
              tileProps={{ allowLocalArtifactProtocol, busyIds, onDelete: handleDelete, onRecover: handleRecover }}
            />
          </div>
        </section>
      ))}
    </div>
  );
}
