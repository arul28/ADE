import { SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerUseArtifactView } from "../../../shared/types";
import type { ProofCompareBlock } from "../../../shared/proofCitation";
import { proofRecordedBeforeRequestLine, readProofProvenance } from "../../../shared/proofProvenance";
import { cn } from "../ui/cn";
import { ArtifactLightbox, ProofPreviewFailureNotice } from "./ChatComputerUsePanel";
import { DemoChapters } from "./DemoChapters";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import {
  externalArtifactUrl,
  isImageArtifact,
  isVideoArtifact,
  useArtifactPreview,
} from "./useArtifactPreview";

/**
 * What the transcript already knows about proof, so a citation in an answer
 * does not ask the runtime for a record the chat has loaded.
 */
type ProofCitationContextValue = {
  artifactsById: ReadonlyMap<string, ComputerUseArtifactView>;
  allowLocalArtifactProtocol: boolean;
};

const EMPTY_CONTEXT: ProofCitationContextValue = {
  artifactsById: new Map(),
  allowLocalArtifactProtocol: false,
};

const ProofCitationContext = createContext<ProofCitationContextValue>(EMPTY_CONTEXT);

export function ProofCitationProvider({
  artifacts,
  allowLocalArtifactProtocol,
  children,
}: {
  artifacts: readonly ComputerUseArtifactView[];
  allowLocalArtifactProtocol: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo<ProofCitationContextValue>(() => ({
    artifactsById: new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    allowLocalArtifactProtocol,
  }), [allowLocalArtifactProtocol, artifacts]);
  return <ProofCitationContext.Provider value={value}>{children}</ProofCitationContext.Provider>;
}

/**
 * What one lookup by id answered. `ok: false` means the machine could not say
 * (offline, too old, refused): that is not the same as the machine saying the
 * proof is not there, and the citation must not claim it is.
 */
type CitedArtifactLookup =
  | { ok: true; artifact: ComputerUseArtifactView | null }
  | { ok: false };

/**
 * Records fetched by id, per machine. A cited artifact the chat's list does not
 * hold (another chat's proof in the same lane, or a list that has not caught
 * up) is read once through the chat's runtime and kept. A miss or a failed read
 * is not kept, so the next render after the list changes asks again.
 */
type FetchedArtifactRequest = {
  promise: Promise<CitedArtifactLookup>;
  startedOnline: boolean;
  settled: boolean;
};

const fetchedArtifacts = new Map<string, FetchedArtifactRequest>();

type CitedArtifactState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "unreadable"; retry: () => void }
  | { status: "ready"; artifact: ComputerUseArtifactView };

function useCitedProofArtifact(artifactId: string): CitedArtifactState {
  const { artifactsById } = useContext(ProofCitationContext);
  const scope = useChatRuntimeScope();
  const known = artifactsById.get(artifactId) ?? null;
  const [fetched, setFetched] = useState<{ key: string; lookup: CitedArtifactLookup } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const machineKey = `${JSON.stringify(scope.pin ?? null)}:${scope.rootPath ?? ""}`;
  const key = `${machineKey}|${artifactId}`;
  // A failed lookup is not kept, so the pinned machine coming back asks again
  // instead of leaving the card on "couldn't load" until a remount.
  const online = scope.online;
  // Retry asks again through this same effect, with no remount.
  const retry = () => {
    setFetched(null);
    setAttempt((count) => count + 1);
  };

  useEffect(() => {
    if (known) return;
    let cancelled = false;
    const cached = fetchedArtifacts.get(key);
    // A lookup begun while the machine was offline may still be pending when it
    // comes back. Its failure would stick, so ask again rather than wait on it.
    const reusable = cached && !(online && !cached.startedOnline && !cached.settled);
    let pending = reusable ? cached.promise : null;
    if (!pending) {
      pending = window.ade.computerUse
        .listArtifacts({ artifactId, limit: 1 }, scope.pin)
        .then((rows): CitedArtifactLookup => ({ ok: true, artifact: rows.find((row) => row.id === artifactId) ?? null }))
        .catch((): CitedArtifactLookup => ({ ok: false }));
      fetchedArtifacts.set(key, { promise: pending, startedOnline: online, settled: false });
    }
    const request = pending;
    void request.then((lookup) => {
      const current = fetchedArtifacts.get(key);
      if (current?.promise === request) {
        current.settled = true;
        if (!lookup.ok || !lookup.artifact) fetchedArtifacts.delete(key);
      }
      if (!cancelled) setFetched({ key, lookup });
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId, attempt, key, known, online, scope.pin]);

  if (known) return { status: "ready", artifact: known };
  if (!fetched || fetched.key !== key) return { status: "loading" };
  if (!fetched.lookup.ok) return { status: "unreadable", retry };
  return fetched.lookup.artifact ? { status: "ready", artifact: fetched.lookup.artifact } : { status: "missing" };
}

function CitationPlaceholder({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <span
      className={cn(
        "my-2 flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 font-sans text-[length:calc(var(--chat-font-size)*11/14)] not-italic",
        tone === "warning"
          ? "border-amber-300/[0.14] bg-amber-400/[0.05] text-amber-100/70"
          : "border-fg/[0.06] bg-fg/[0.025] text-muted-fg/50",
      )}
    >
      {children}
    </span>
  );
}

/**
 * One cited artifact: the picture or the video at a readable size, the
 * caption under it, and where it came from. Everything is a span, because a
 * markdown image sits inside a paragraph and a div there is invalid HTML.
 */
function CitedProofMedia({
  artifact,
  caption,
  compact = false,
  fallback,
}: {
  artifact: ComputerUseArtifactView;
  caption: string | null;
  compact?: boolean;
  /** Shown in place of the failure notice when this machine cannot load the file. */
  fallback?: React.ReactNode;
}) {
  const { allowLocalArtifactProtocol } = useContext(ProofCitationContext);
  const { containerRef, preview, loading, failed, explanation, onMediaError, retry } = useArtifactPreview<HTMLSpanElement>(
    artifact,
    allowLocalArtifactProtocol,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);
  const externalUrl = externalArtifactUrl(artifact.uri);
  const failureText = externalUrl ? "This proof lives at its source." : explanation;
  const text = caption?.trim() || artifact.description?.trim() || artifact.title;
  const olderLine = proofRecordedBeforeRequestLine(readProofProvenance(artifact.metadata));
  const mediaHeight = compact ? "max-h-[300px]" : "max-h-[440px]";

  if (failed && fallback != null) return <>{fallback}</>;
  return (
    <span
      ref={containerRef}
      data-proof-citation={artifact.id}
      className="block min-w-0"
    >
      {loading ? (
        <span className="flex min-h-40 items-center justify-center rounded-xl border border-fg/[0.06] bg-black/20 text-muted-fg/35">
          <SpinnerGap size={18} className="animate-spin" aria-label="Loading proof" />
        </span>
      ) : failed ? (
        <span className="block"><ProofPreviewFailureNotice failureText={failureText} onRetry={retry} /></span>
      ) : preview && image ? (
        <button
          type="button"
          className="block max-w-full overflow-hidden rounded-xl border border-fg/[0.07] bg-black/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
          aria-label={`Enlarge ${text}`}
          onClick={() => setLightboxOpen(true)}
        >
          <img
            src={preview}
            alt={text}
            onError={onMediaError}
            className={cn("m-0 block h-auto max-w-full object-contain", mediaHeight)}
          />
        </button>
      ) : preview && video ? (
        <video
          ref={videoRef}
          src={preview}
          controls
          playsInline
          preload="metadata"
          onError={onMediaError}
          aria-label={text}
          className={cn("m-0 block h-auto max-w-full rounded-xl border border-fg/[0.07] bg-black", mediaHeight)}
        />
      ) : !image && !video ? (
        <CitationPlaceholder>{`${text} (${artifact.kind.replace(/_/g, " ")}) cannot show inline. It is in the proof drawer.`}</CitationPlaceholder>
      ) : null}
      {preview && video ? (
        <DemoChapters metadata={artifact.metadata} videoRef={videoRef}>
          <span className="block min-w-0 font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] not-italic leading-5 text-fg/70">
            {text}
          </span>
        </DemoChapters>
      ) : (
        <span className="mt-1.5 block min-w-0 font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] not-italic leading-5 text-fg/70">
          {text}
        </span>
      )}
      {/* The one provenance fact worth a line in an answer: a video older than the request. */}
      {olderLine ? (
        <span className="block font-sans text-[length:calc(var(--chat-font-size)*10/14)] not-italic text-amber-200/65">
          {olderLine}
        </span>
      ) : null}
      {lightboxOpen && preview ? (
        <ArtifactLightbox
          artifact={artifact}
          preview={preview}
          failed={failed}
          failureText={failureText}
          onMediaError={onMediaError}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
    </span>
  );
}

/**
 * One cited artifact. `fallback` is another copy of the same proof (a pull
 * request's uploaded picture): it shows while the record is read and when this
 * machine does not hold the record or its file, instead of the spinner and
 * the failure notes.
 */
export function CitedProofSlot({ artifactId, caption, compact, fallback }: {
  artifactId: string;
  caption: string | null;
  compact?: boolean;
  fallback?: React.ReactNode;
}) {
  const state = useCitedProofArtifact(artifactId);
  const scope = useChatRuntimeScope();
  if (fallback != null && state.status !== "ready") return <>{fallback}</>;
  if (state.status === "loading") {
    return (
      <CitationPlaceholder>
        <SpinnerGap size={14} className="animate-spin" aria-hidden />
        {caption?.trim() || "Loading proof"}
      </CitationPlaceholder>
    );
  }
  if (state.status === "missing") {
    return (
      <CitationPlaceholder tone="warning">
        <WarningCircle size={14} aria-hidden />
        {`ADE has no proof with the id ${artifactId}.${caption?.trim() ? ` It was cited as "${caption.trim()}".` : ""}`}
      </CitationPlaceholder>
    );
  }
  if (state.status === "unreadable") {
    return (
      <CitationPlaceholder tone="warning">
        <WarningCircle size={14} aria-hidden />
        <span className="min-w-0">
          {`Couldn't load this proof from ${scope.isRemote ? scope.machineName : "this computer"}.${caption?.trim() ? ` It was cited as "${caption.trim()}".` : ""}`}
        </span>
        <button
          type="button"
          onClick={state.retry}
          className="ml-auto shrink-0 rounded-md border border-amber-200/[0.22] px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-amber-100/85 hover:bg-amber-200/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-200/60"
        >
          Retry
        </button>
      </CitationPlaceholder>
    );
  }
  return <CitedProofMedia artifact={state.artifact} caption={caption} compact={compact} fallback={fallback} />;
}

/** `![caption](ade-proof://<id>)` in an answer. */
export function ProofCitationFigure({ artifactId, caption }: { artifactId: string; caption: string | null }) {
  return (
    <span data-proof-citation-figure="" className="my-3 block max-w-[720px]">
      <CitedProofSlot artifactId={artifactId} caption={caption} />
    </span>
  );
}

/** A ```proof-compare block: before and after, side by side. */
export function ProofCompareFigure({ block }: { block: ProofCompareBlock }) {
  return (
    <div data-proof-compare="" className="my-4 max-w-[960px]">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {([
          ["Before", block.before],
          ["After", block.after],
        ] as const).map(([side, entry]) => (
          <div key={side} className="min-w-0">
            <div className="mb-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-semibold uppercase tracking-[0.06em] text-muted-fg/50">
              {side}
            </div>
            <CitedProofSlot artifactId={entry.artifactId} caption={entry.label} compact />
          </div>
        ))}
      </div>
      {block.caption ? (
        <p className="mb-0 mt-2 font-sans text-[length:calc(var(--chat-font-size)*12/14)] leading-5 text-fg/74">
          {block.caption}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The small picture under a "Filed proof" action row. A click opens it full
 * size in place, as the proof drawer would, without going through the drawer.
 * It draws nothing until the record loads, and nothing for a record that is
 * gone or cannot show a picture: the row's words already say what was filed.
 */
export function ProofActionThumbnail({ artifactId, height }: { artifactId: string; height: number }) {
  const state = useCitedProofArtifact(artifactId);
  if (state.status !== "ready") return null;
  return <ProofActionThumbnailMedia artifact={state.artifact} height={height} />;
}

function ProofActionThumbnailMedia({ artifact, height }: { artifact: ComputerUseArtifactView; height: number }) {
  const { allowLocalArtifactProtocol } = useContext(ProofCitationContext);
  const { containerRef, preview, failed, explanation, onMediaError } = useArtifactPreview<HTMLSpanElement>(
    artifact,
    allowLocalArtifactProtocol,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);
  const text = artifact.description?.trim() || artifact.title;
  if (!image && !video) return null;
  return (
    <span ref={containerRef} data-proof-action-thumbnail={artifact.id} className="block" style={{ height }}>
      {preview && !failed ? (
        <button
          type="button"
          className="block h-full overflow-hidden rounded-md border border-fg/[0.08] bg-black/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
          aria-label={`Enlarge ${text}`}
          onClick={() => setLightboxOpen(true)}
        >
          {image ? (
            <img src={preview} alt={text} onError={onMediaError} className="m-0 block h-full w-auto object-contain" />
          ) : (
            <video src={preview} muted playsInline preload="metadata" onError={onMediaError} aria-label={text} className="m-0 block h-full w-auto object-contain" />
          )}
        </button>
      ) : null}
      {lightboxOpen && preview ? (
        <ArtifactLightbox
          artifact={artifact}
          preview={preview}
          failed={failed}
          failureText={externalArtifactUrl(artifact.uri) ? "This proof lives at its source." : explanation}
          onMediaError={onMediaError}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
    </span>
  );
}
