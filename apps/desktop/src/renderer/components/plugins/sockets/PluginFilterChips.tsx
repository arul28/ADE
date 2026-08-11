import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import { contributionKey } from "./contributionModel";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { SocketIcon } from "./socketUi";

/**
 * Contributed filter chips, rendered after the surface's own.
 *
 * Selection is owned by the surface, not by this component, and a surface that
 * cannot apply the selection does not mount it. A chip that highlights and
 * filters nothing is a worse outcome than a plugin having no chip: it reads as a
 * broken product feature rather than a missing plugin one.
 */
export function PluginFilterChips({
  surface,
  selected,
  onToggle,
  active = true,
  style,
}: {
  surface: PluginSurfaceId;
  selected: readonly string[];
  onToggle: (filterKey: string) => void;
  active?: boolean;
  style?: React.CSSProperties;
}) {
  const contributions = useSurfaceContributions(surface, "filter-chip", { active });
  if (contributions.length === 0) return null;

  return (
    <>
      {contributions.map((contribution) => {
        const isSelected = selected.includes(contribution.payload.filterKey);
        return (
          <button
            key={contributionKey(contribution)}
            type="button"
            data-tour={`plugin:${surface}.filter-chip`}
            aria-pressed={isSelected}
            onClick={() => onToggle(contribution.payload.filterKey)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 24,
              padding: "0 8px",
              fontSize: 11,
              fontWeight: 500,
              fontFamily: SANS_FONT,
              color: isSelected ? COLORS.accent : COLORS.textMuted,
              background: isSelected
                ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                : "color-mix(in srgb, var(--color-fg) 4%, transparent)",
              border: `1px solid ${isSelected ? COLORS.accentBorder : COLORS.borderMuted}`,
              borderRadius: RADII.sm,
              cursor: "pointer",
              whiteSpace: "nowrap",
              ...style,
            }}
          >
            <SocketIcon name={undefined} size={11} />
            {contribution.payload.label}
            {typeof contribution.payload.count === "number" ? (
              <span style={{ color: COLORS.textDim }}>{contribution.payload.count}</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}
