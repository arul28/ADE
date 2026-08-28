import React from "react";
import { COLORS, SANS_FONT, recessedStyle } from "../../lanes/laneDesignTokens";

/**
 * The settings disclosure: a native `<details>` in a recessed card, for
 * rarely-needed fields that should stay out of the way but still be findable
 * (native `<details>` keeps keyboard and find-in-page behaviour for free).
 *
 * `defaultOpen` is uncontrolled on purpose — pass `true` when the block already
 * holds a value so an existing config never hides itself.
 */
export function SettingsDisclosure({
  summary,
  defaultOpen,
  gap = 20,
  children,
}: {
  summary: string;
  defaultOpen?: boolean;
  /** Vertical gap between the children stacked inside the body. */
  gap?: number;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      style={{
        ...recessedStyle({ padding: 0, borderRadius: 10 }),
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "10px 12px",
          fontSize: 11,
          fontWeight: 600,
          fontFamily: SANS_FONT,
          color: COLORS.textSecondary,
        }}
      >
        {summary}
      </summary>
      <div
        style={{
          padding: 12,
          borderTop: `1px solid ${COLORS.borderMuted}`,
          display: "flex",
          flexDirection: "column",
          gap,
        }}
      >
        {children}
      </div>
    </details>
  );
}
