import React from "react";
import type { DevToolsPartSize } from "./useDevToolsStorage";

/**
 * One bar for what developer tools take on a disk, split by kind, with the
 * sizes under it. The one bold element on the device pages: everything around
 * it is quiet rows.
 *
 * The bar never claims a size it does not have: a part still measuring is a
 * soft striped stub, one that could not be measured says so in the legend.
 */
export type SpaceSegment = {
  key: string;
  label: string;
  size: DevToolsPartSize;
  /** Theme-aware category hue (`useDevToolHues`). */
  hue: string;
  /** Jump to the list this part sums. */
  onSelect?: () => void;
};

const STATE_WORDS: Record<Exclude<DevToolsPartSize["state"], "ready">, string> = {
  measuring: "Measuring…",
  unmeasured: "Not measured",
  failed: "Couldn't measure",
};

export function DevToolsSpaceBar({
  segments,
  format,
  headline,
  footnote,
}: {
  segments: readonly SpaceSegment[];
  format: (bytes: number) => string;
  /** The sentence above the bar, e.g. "Simulators and Xcode use 46 GB on this Mac". */
  headline: React.ReactNode;
  /** A quiet line under the legend, e.g. free space on the disk. */
  footnote?: React.ReactNode;
}) {
  const known = segments.reduce((sum, segment) => sum + (segment.size.state === "ready" ? segment.size.bytes ?? 0 : 0), 0);
  const measuring = segments.some((segment) => segment.size.state === "measuring");
  const sizeWord = (segment: SpaceSegment) => (segment.size.state === "ready" && segment.size.bytes != null ? format(segment.size.bytes) : STATE_WORDS[segment.size.state === "ready" ? "failed" : segment.size.state]);
  return (
    <div className="ade-dev-space" aria-busy={measuring || undefined}>
      <div className="ade-dev-space-headline">{headline}</div>
      <div className="ade-dev-space-bar" role="img" aria-label={segments.map((segment) => `${segment.label}: ${sizeWord(segment)}`).join(", ")}>
        {segments.map((segment) => {
          if (segment.size.state === "measuring") {
            return <span key={segment.key} className="ade-dev-space-seg" data-measuring="true" style={{ flexGrow: 0, flexBasis: 28, ["--seg-hue" as string]: segment.hue }} />;
          }
          const share = known > 0 && segment.size.state === "ready" && segment.size.bytes ? segment.size.bytes / known : 0;
          if (share <= 0) return null;
          return <span key={segment.key} className="ade-dev-space-seg" style={{ flexGrow: share, ["--seg-hue" as string]: segment.hue }} />;
        })}
      </div>
      <ul className="ade-dev-space-legend">
        {segments.map((segment) => {
          const body = (
            <>
              <span className="ade-dev-space-swatch" style={{ ["--seg-hue" as string]: segment.hue }} aria-hidden />
              <span>{segment.label}</span>
              <span className="ade-dev-space-size" data-state={segment.size.state}>{sizeWord(segment)}</span>
            </>
          );
          return (
            <li key={segment.key}>
              {segment.onSelect ? (
                <button type="button" className="ade-dev-space-key" onClick={segment.onSelect}>{body}</button>
              ) : (
                <span className="ade-dev-space-key" data-static="true">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {footnote ? <div className="ade-dev-space-foot">{footnote}</div> : null}
    </div>
  );
}

/** Every part sized: the total. Otherwise null, and the caller says what is still missing. */
export function readyTotal(segments: readonly SpaceSegment[]): number | null {
  if (!segments.every((segment) => segment.size.state === "ready")) return null;
  return segments.reduce((sum, segment) => sum + (segment.size.bytes ?? 0), 0);
}
