import React from "react";

/**
 * One bar for what developer tools take on a disk, split by kind, with the
 * sizes under it. The one bold element on the device pages: everything around
 * it is quiet rows.
 *
 * A part still measuring is drawn as a soft striped stub and named "Measuring…"
 * in the legend, so the bar never claims a size it does not have.
 */
export type SpaceSegment = {
  key: string;
  label: string;
  bytes: number | null;
  measuring?: boolean;
  /** Theme-independent category hue, as Storage's own segments use. */
  hue: string;
  /** Jump to the list this part sums. */
  onSelect?: () => void;
};

export function DevToolsSpaceBar({
  segments,
  format,
  headline,
  footnote,
}: {
  segments: readonly SpaceSegment[];
  format: (bytes: number) => string;
  /** The sentence above the bar, e.g. "Xcode and simulators use 46 GB on Mac Studio". */
  headline: React.ReactNode;
  /** A quiet line under the legend, e.g. free space on the disk. */
  footnote?: React.ReactNode;
}) {
  const known = segments.reduce((sum, segment) => sum + (segment.bytes ?? 0), 0);
  const anyMeasuring = segments.some((segment) => segment.measuring || segment.bytes == null);
  return (
    <div className="ade-dev-space" aria-busy={anyMeasuring || undefined}>
      <div className="ade-dev-space-headline">{headline}</div>
      <div className="ade-dev-space-bar" role="img" aria-label={segments.map((segment) => `${segment.label}: ${segment.bytes != null ? format(segment.bytes) : "measuring"}`).join(", ")}>
        {segments.map((segment) => {
          const share = known > 0 && segment.bytes != null ? segment.bytes / known : 0;
          if (segment.bytes == null || segment.measuring) {
            return <span key={segment.key} className="ade-dev-space-seg" data-measuring="true" style={{ flexGrow: 0, flexBasis: 28, ["--seg-hue" as string]: segment.hue }} />;
          }
          if (share <= 0) return null;
          return (
            <span
              key={segment.key}
              className="ade-dev-space-seg"
              style={{ flexGrow: share, ["--seg-hue" as string]: segment.hue }}
            />
          );
        })}
        {known === 0 && !anyMeasuring ? <span className="ade-dev-space-seg" data-empty="true" style={{ flexGrow: 1 }} /> : null}
      </div>
      <ul className="ade-dev-space-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            {segment.onSelect ? (
              <button type="button" className="ade-dev-space-key" onClick={segment.onSelect}>
                <LegendBody segment={segment} format={format} />
              </button>
            ) : (
              <span className="ade-dev-space-key" data-static="true">
                <LegendBody segment={segment} format={format} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {footnote ? <div className="ade-dev-space-foot">{footnote}</div> : null}
    </div>
  );
}

function LegendBody({ segment, format }: { segment: SpaceSegment; format: (bytes: number) => string }) {
  return (
    <>
      <span className="ade-dev-space-swatch" style={{ ["--seg-hue" as string]: segment.hue }} aria-hidden />
      <span className="ade-dev-space-label">{segment.label}</span>
      <span className="ade-dev-space-size">{segment.bytes != null && !segment.measuring ? format(segment.bytes) : "Measuring…"}</span>
    </>
  );
}
