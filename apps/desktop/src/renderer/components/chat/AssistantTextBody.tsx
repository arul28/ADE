import React, { useRef } from "react";

import { isPerfActive } from "../../perf/markers";
import type { WorkspacePathLocation } from "./chatWorkspacePaths";
import { MarkdownBlock, type MosaicRenderContext } from "./chatMarkdownBlock";
import { useRevealedLength, useSplitRevealed } from "./useRevealedText";

/**
 * The assistant text row's markdown, and the only component that re-renders at
 * 60 Hz while a turn streams.
 *
 * Everything above it — the transcript derivations, the row list, sibling rows
 * — is untouched by the reveal: this leaf owns the revealed length, so a frame
 * costs one small subtree render plus a parse of the growing tail.
 *
 * `paced` is true for exactly one row at a time (the trailing streaming
 * assistant text row of a visible main transcript). Every other row renders
 * the full store text on its first paint, exactly as before pacing existed.
 */
export const AssistantTextBody = React.memo(function AssistantTextBody({
  text,
  paced,
  onOpenWorkspacePath,
  mosaic,
  mosaicScopeKey,
}: {
  text: string;
  paced: boolean;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
  mosaic?: MosaicRenderContext;
  mosaicScopeKey?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const revealedLength = useRevealedLength(text, paced, hostRef);
  const { settled, tail } = useSplitRevealed(text, revealedLength);

  return (
    /*
      `data-stream-text-len` exists only while a perf run is active (see
      renderer/perf/streamSmoothness.ts). It reports the REVEALED length — what
      this commit actually puts on screen — so the smoothness sampler measures
      paint rather than store state; on every unpaced row that is the full
      text, and with pacing disabled entirely (`ade.textRevealHorizonMs` <= 0
      or no `Intl.Segmenter`) `useRevealedLength` returns `text.length`, so the
      paint-on-arrival A/B arm still reports a length instead of vanishing from
      the sampler. The sampler reads it from a rAF callback (post-commit, pre-paint),
      so it approximates the paint by at most one frame. In production
      `isPerfActive()` is false, React drops the `undefined` prop, and no
      attribute is written.
    */
    <div
      ref={hostRef}
      className="min-w-0"
      data-assistant-output="true"
      data-stream-text-len={isPerfActive() ? revealedLength : undefined}
    >
      <MarkdownBlock
        markdown={settled}
        tailMarkdown={tail.length > 0 ? tail : undefined}
        onOpenWorkspacePath={onOpenWorkspacePath}
        mosaic={mosaic}
        mosaicScopeKey={mosaicScopeKey}
      />
    </div>
  );
});
