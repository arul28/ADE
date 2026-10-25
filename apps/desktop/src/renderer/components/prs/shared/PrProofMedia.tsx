import { useEffect, useState, type ReactNode } from "react";
import { ArrowSquareOut, ChatTeardropText } from "@phosphor-icons/react";

import type { PrCompareFigure, PrCompareSide } from "../../../../shared/prBodyProof";
import { CitedProofSlot, ProofCitationProvider } from "../../chat/ChatProofCitation";
import { useChatRuntimeScope } from "../../chat/ChatRuntimeScope";
import { COLORS } from "../../lanes/laneDesignTokens";
import { useAppStore } from "../../../state/appStore";
import { useGithubMediaSrc } from "./useGithubMediaSrc";

/**
 * Proof in a pull request's text.
 *
 * A picture or a video the author uploaded with `ade prs create` carries its
 * proof id. The machine that holds the proof shows its own copy (the same
 * figure a chat answer shows: a video plays with its chapters); every other
 * reader gets the copy GitHub holds. A picture with no proof id is GitHub's
 * copy only.
 */

function openExternal(url: string | null | undefined) {
  if (url) void window.ade.app.openExternal(url);
}

/**
 * GitHub's copy. An attachment's URL does not say what it is, so one kind is
 * tried and then the other: a picture first, or a video first for an
 * attachment GitHub stores as a bare link (`likely="video"`). A copy that loads
 * as neither is asked for again as a signed copy from the machine that owns
 * the PR (a private repository; see useGithubMediaSrc), and only when that
 * fails too (no access, an older machine, a host the content policy does not
 * name) becomes a link that opens it on GitHub.
 */
export function PrRemoteMedia({
  url,
  alt,
  maxHeight = 520,
  likely = "image",
}: {
  url: string;
  alt: string;
  maxHeight?: number;
  likely?: "image" | "video";
}) {
  const [failed, setFailed] = useState<{ image: boolean; video: boolean }>({ image: false, video: false });
  useEffect(() => setFailed({ image: false, video: false }), [url]);
  const media = useGithubMediaSrc(url);
  const order = likely === "video" ? (["video", "image"] as const) : (["image", "video"] as const);
  // A signed copy says what it is; the original URL does not.
  const kind = media.phase === "resolved"
    ? media.kind
    : media.phase === "failed"
      ? null
      : order.find((entry) => !failed[entry]) ?? null;
  const onError = (entry: "image" | "video") => () => {
    if (media.reportError()) return;
    if (media.phase === "original") setFailed((current) => ({ ...current, [entry]: true }));
  };
  if (media.phase === "resolving") {
    // Same footprint as the link it may become, so nothing jumps.
    return (
      <span
        data-testid="pr-remote-media-pending"
        className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[12px]"
        style={{ borderColor: COLORS.border, color: COLORS.textMuted }}
      >
        <span className="min-w-0 truncate">{alt || "Attachment"}</span>
      </span>
    );
  }
  if (kind === null) {
    return (
      <button
        type="button"
        data-testid="pr-remote-media-link"
        onClick={() => openExternal(url)}
        className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-[6px] border px-2 py-1 text-left text-[12px] hover:underline"
        style={{ borderColor: COLORS.border, color: COLORS.textSecondary, background: "transparent", cursor: "pointer" }}
      >
        <ArrowSquareOut size={12} style={{ flexShrink: 0 }} />
        <span className="min-w-0 truncate">{alt || "Attachment"}</span>
        <span className="shrink-0" style={{ color: COLORS.textMuted }}>· open on GitHub</span>
      </button>
    );
  }
  if (kind === "video") {
    return (
      <video
        data-testid="pr-remote-video"
        src={media.src}
        controls
        playsInline
        // Metadata only: a thread can hold several videos, and none may start
        // to download in full before the reader presses play.
        preload="metadata"
        aria-label={alt || "Video"}
        onError={onError("video")}
        className="my-2 block max-w-full rounded-[8px] border"
        style={{ borderColor: COLORS.border, maxHeight, background: "#000" }}
      />
    );
  }
  return (
    <img
      src={media.src}
      alt={alt}
      loading="lazy"
      // GitHub's image hosts refuse a request that carries a referrer from
      // another origin; see PrImage.
      referrerPolicy="no-referrer"
      onError={onError("image")}
      onClick={(event) => {
        event.preventDefault();
        openExternal(url);
      }}
      className="my-2 block max-w-full cursor-zoom-in rounded-[8px] border"
      style={{ borderColor: COLORS.border, maxHeight }}
    />
  );
}

/** The frame the chat's proof figure needs: its font variable and its context. */
function ProofFrame({ children }: { children: ReactNode }) {
  const scope = useChatRuntimeScope();
  const tabBinding = useAppStore((state) => state.projectBinding);
  // Outside a chat the scope has no binding, and the tab's own says where the
  // proof files are. Only a machine that holds them may read them by path.
  const remote = (scope.binding ?? tabBinding)?.kind === "remote";
  return (
    <ProofCitationProvider artifacts={NO_ARTIFACTS} allowLocalArtifactProtocol={!remote}>
      <span className="block min-w-0" style={{ ["--chat-font-size" as string]: "13.5px" }}>{children}</span>
    </ProofCitationProvider>
  );
}
const NO_ARTIFACTS: never[] = [];

function Missing({ label }: { label: string | null }) {
  return (
    <span
      className="my-2 flex min-h-24 items-center justify-center rounded-[8px] border px-3 text-center text-[11.5px]"
      style={{ borderColor: COLORS.border, color: COLORS.textMuted, background: COLORS.recessedBg }}
    >
      {label ? `${label} — ` : ""}this proof is on the machine that made it and was not uploaded.
    </span>
  );
}

/** One proof item: this machine's copy when it has one, else GitHub's. */
export function PrProofMedia({
  artifactId,
  url,
  alt,
  compact = false,
}: {
  artifactId: string | null;
  /** Null for a citation that was never uploaded. */
  url: string | null;
  alt: string;
  compact?: boolean;
}) {
  const remote = url ? <PrRemoteMedia url={url} alt={alt} maxHeight={compact ? 320 : 520} /> : <Missing label={alt || null} />;
  if (!artifactId) return remote;
  return (
    <ProofFrame>
      <CitedProofSlot artifactId={artifactId} caption={alt || null} compact={compact} fallback={remote} />
    </ProofFrame>
  );
}

function CompareSide({ side }: { side: PrCompareSide }) {
  return (
    <div className="min-w-0" data-pr-compare-side={side.title}>
      <div className="mb-1 text-[12.5px] font-semibold" style={{ color: COLORS.textSecondary }}>
        {side.title}
      </div>
      <PrProofMedia artifactId={side.artifactId} url={side.url} alt={side.label ?? side.title} compact />
    </div>
  );
}

/** Before and after, side by side; stacked when the pane is narrow. */
export function PrCompare({ figure, onAddToChat }: { figure: PrCompareFigure; onAddToChat?: () => void }) {
  return (
    <figure
      data-testid="pr-compare"
      className="group/compare relative my-4"
    >
      <div
        className="grid min-w-0 gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${figure.sides.length > 2 ? 200 : 260}px), 1fr))` }}
      >
        {figure.sides.map((side, index) => <CompareSide key={`${side.title}:${index}`} side={side} />)}
      </div>
      {figure.caption ? (
        <figcaption className="mt-2 text-[12.5px] leading-[1.5]" style={{ color: COLORS.textSecondary }}>
          {figure.caption}
        </figcaption>
      ) : null}
      {onAddToChat ? <PrAddToChatButton onClick={onAddToChat} className="absolute right-0 top-0 opacity-0 group-hover/compare:opacity-100 focus-visible:opacity-100" /> : null}
    </figure>
  );
}

/** The small "Add to chat" control every quotable PR item shows on hover. */
export function PrAddToChatButton({ onClick, className = "", label = "Add to chat" }: { onClick: () => void; className?: string; label?: string }) {
  return (
    <button
      type="button"
      data-testid="pr-add-to-chat"
      title="Quote this in the chat that works on this pull request"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-opacity ${className}`}
      style={{
        color: COLORS.accent,
        background: `color-mix(in srgb, ${COLORS.accent} 16%, ${COLORS.prSurface})`,
        border: `1px solid color-mix(in srgb, ${COLORS.accent} 30%, transparent)`,
        cursor: "pointer",
      }}
    >
      <ChatTeardropText size={11} weight="fill" />
      {label}
    </button>
  );
}
