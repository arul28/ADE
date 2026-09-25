import { SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ComputerUseArtifactView } from "../../../shared/types";
import type { ProofCompareBlock } from "../../../shared/proofCitation";
import { proofRecordedBeforeRequestLine, readProofProvenance } from "../../../shared/proofProvenance";
import { cn } from "../ui/cn";
import { ArtifactLightbox, ProofPreviewFailureNotice } from "./ChatComputerUsePanel";
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
 * Records fetched by id, per machine. A cited artifact the chat's list does not
 * hold (another chat's proof in the same lane, or a list that has not caught
 * up) is read once through the chat's runtime and kept. A miss is not kept, so
 * the next render after the list changes asks again.
 */
const fetchedArtifacts = new Map<string, Promise<ComputerUseArtifactView | null>>();

type CitedArtifactState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; artifact: ComputerUseArtifactView };

function useCitedProofArtifact(artifactId: string): CitedArtifactState {
  const { artifactsById } = useContext(ProofCitationContext);
  const scope = useChatRuntimeScope();
  const known = artifactsById.get(artifactId) ?? null;
  const [fetched, setFetched] = useState<{ key: string; artifact: ComputerUseArtifactView | null } | null>(null);
  const machineKey = `${JSON.stringify(scope.pin ?? null)}:${scope.rootPath ?? ""}`;
  const key = `${machineKey}|${artifactId}`;

  useEffect(() => {
    if (known) return;
    let cancelled = false;
    let pending = fetchedArtifacts.get(key);
    if (!pending) {
      pending = window.ade.computerUse
        .listArtifacts({ artifactId, limit: 1 }, scope.pin)
        .then((rows) => rows.find((row) => row.id === artifactId) ?? null)
        .catch(() => null);
      fetchedArtifacts.set(key, pending);
    }
    void pending.then((artifact) => {
      if (!artifact) fetchedArtifacts.delete(key);
      if (!cancelled) setFetched({ key, artifact });
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId, key, known, scope.pin]);

  if (known) return { status: "ready", artifact: known };
  if (!fetched || fetched.key !== key) return { status: "loading" };
  return fetched.artifact ? { status: "ready", artifact: fetched.artifact } : { status: "missing" };
}

function CitationPlaceholder({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <span
      className={cn(
        "my-2 flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 font-sans text-[length:calc(var(--chat-font-size)*11/14)] not-italic",
        tone === "warning"
          ? "border-amber-300/[0.14] bg-amber-400/[0.05] text-amber-100/70"
          : "border-white/[0.06] bg-white/[0.025] text-muted-fg/50",
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
}: {
  artifact: ComputerUseArtifactView;
  caption: string | null;
  compact?: boolean;
}) {
  const { allowLocalArtifactProtocol } = useContext(ProofCitationContext);
  const { containerRef, preview, loading, failed, explanation, onMediaError } = useArtifactPreview(
    artifact,
    allowLocalArtifactProtocol,
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const image = isImageArtifact(artifact);
  const video = isVideoArtifact(artifact);
  const externalUrl = externalArtifactUrl(artifact.uri);
  const failureText = externalUrl ? "This proof lives at its source." : explanation;
  const text = caption?.trim() || artifact.description?.trim() || artifact.title;
  const olderLine = proofRecordedBeforeRequestLine(readProofProvenance(artifact.metadata));
  const mediaHeight = compact ? "max-h-[300px]" : "max-h-[440px]";

  return (
    <span
      ref={containerRef as unknown as React.RefObject<HTMLSpanElement>}
      data-proof-citation={artifact.id}
      className="block min-w-0"
    >
      {loading ? (
        <span className="flex min-h-40 items-center justify-center rounded-xl border border-white/[0.06] bg-black/20 text-muted-fg/35">
          <SpinnerGap size={18} className="animate-spin" aria-label="Loading proof" />
        </span>
      ) : failed ? (
        <span className="block"><ProofPreviewFailureNotice failureText={failureText} /></span>
      ) : preview && image ? (
        <button
          type="button"
          className="block max-w-full overflow-hidden rounded-xl border border-white/[0.07] bg-black/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
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
          src={preview}
          controls
          playsInline
          preload="metadata"
          onError={onMediaError}
          aria-label={text}
          className={cn("m-0 block h-auto max-w-full rounded-xl border border-white/[0.07] bg-black", mediaHeight)}
        />
      ) : !image && !video ? (
        <CitationPlaceholder>{`${text} (${artifact.kind.replace(/_/g, " ")}) cannot show inline. It is in the proof drawer.`}</CitationPlaceholder>
      ) : null}
      <span className="mt-1.5 block min-w-0 font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] not-italic leading-5 text-fg/70">
        {text}
      </span>
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

function CitedProofSlot({ artifactId, caption, compact }: {
  artifactId: string;
  caption: string | null;
  compact?: boolean;
}) {
  const state = useCitedProofArtifact(artifactId);
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
  return <CitedProofMedia artifact={state.artifact} caption={caption} compact={compact} />;
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
