import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";
import { SocketButton } from "./socketUi";

/**
 * What plugins add to an empty surface.
 *
 * Mounted as the `children` of the shared `EmptyState`, i.e. under the
 * product's own explanation of why the surface is empty — never instead of it.
 * An empty Lanes tab still means "you have no lanes"; a plugin may offer a way
 * to get some, and that is all this socket is for.
 */
export function PluginEmptyStateExtra({
  surface,
  active = true,
}: {
  surface: PluginSurfaceId;
  active?: boolean;
}) {
  const context = React.useMemo<PluginSurfaceContext>(
    () => ({ kind: "surface", surface }),
    [surface],
  );
  const contributions = useSurfaceContributions(surface, "empty-state", { active, context });
  const invoke = usePluginSocketInvoke();

  if (contributions.length === 0) return null;

  return (
    <div
      data-tour={`plugin:${surface}.empty-state`}
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: 8,
        marginTop: 16,
      }}
    >
      {contributions.map((contribution) => (
        <SocketBoundary key={contributionKey(contribution)}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              maxWidth: 280,
              padding: 12,
              background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: RADII.md,
            }}
          >
            <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>
              {contribution.payload.title}
            </span>
            {contribution.payload.body ? (
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: COLORS.textMuted,
                  textAlign: "center",
                }}
              >
                {contribution.payload.body}
              </span>
            ) : null}
            {contribution.payload.actionId ? (
              <SocketButton
                label={contribution.payload.actionLabel ?? contribution.payload.title}
                onClick={() => invoke(contribution.pluginId, contribution.payload.actionId!, context)}
              />
            ) : null}
          </div>
        </SocketBoundary>
      ))}
    </div>
  );
}
