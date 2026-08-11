import React from "react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import type { PluginRegistryMedia } from "../../../shared/plugins/registryIndex";

/**
 * A plugin's screenshots and clips.
 *
 * Plain `<img>` and `<video>` elements, deliberately: this is third-party
 * content on a first-party surface, and the two defences that matter are the
 * ones that do not live in this file. The registry parser has already refused
 * anything that is not an `https` URL, and the renderer's Content-Security
 * -Policy admits a short list of GitHub hosts and nothing else (see
 * `main/rendererCsp.ts`). A lightbox, a carousel or a fetch-then-blob pipeline
 * would add moving parts around bytes that are already constrained by both.
 *
 * Everything here degrades to nothing. An item that fails to load is dropped
 * from the strip rather than left as a broken frame — a gallery is a courtesy,
 * and a plugin whose screenshots have rotted should read as one without them,
 * not as one that is broken.
 */

export function PluginMediaGallery({ media }: { media: readonly PluginRegistryMedia[] }) {
  /* Failures are keyed by src rather than by index: the strip is rebuilt
     whenever the catalogue refreshes, and an index would move a failure onto
     whichever item took that slot next. */
  const [failed, setFailed] = React.useState<ReadonlySet<string>>(() => new Set());
  const shown = media.filter((item) => !failed.has(item.src));
  if (shown.length === 0) return null;

  const markFailed = (src: string) => {
    setFailed((previous) => {
      if (previous.has(src)) return previous;
      const next = new Set(previous);
      next.add(src);
      return next;
    });
  };

  return (
    <section data-tour="plugin:marketplace.media" style={{ display: "grid", gap: 10 }}>
      {/* Horizontal, and scrolled rather than wrapped: the readme below is the
          page's spine, and a gallery that reflowed into three rows would push
          it under the fold on a narrow window. */}
      <div
        style={{
          display: "flex",
          gap: 10,
          overflowX: "auto",
          paddingBottom: 4,
          scrollSnapType: "x proximity",
        }}
      >
        {shown.map((item) => (
          <figure
            key={item.src}
            style={{
              margin: 0,
              display: "grid",
              gap: 6,
              flex: "0 0 auto",
              maxWidth: 420,
              scrollSnapAlign: "start",
            }}
          >
            <span
              style={{
                display: "block",
                overflow: "hidden",
                borderRadius: RADII.md,
                border: `1px solid ${COLORS.borderMuted}`,
                background: COLORS.recessedBg,
              }}
            >
              {item.kind === "video" ? (
                <video
                  src={item.src}
                  controls
                  playsInline
                  preload="none"
                  onError={() => markFailed(item.src)}
                  style={{ display: "block", maxHeight: 240, maxWidth: "100%" }}
                />
              ) : (
                <img
                  src={item.src}
                  alt={item.caption ?? ""}
                  loading="lazy"
                  decoding="async"
                  onError={() => markFailed(item.src)}
                  style={{ display: "block", maxHeight: 240, maxWidth: "100%", objectFit: "contain" }}
                />
              )}
            </span>
            {item.caption ? (
              <figcaption
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: COLORS.textMuted,
                }}
              >
                {item.caption}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
    </section>
  );
}

export default PluginMediaGallery;
