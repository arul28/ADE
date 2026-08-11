import React from "react";

import { splitPluginRowBadges, type PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";
import { SocketBadge, SocketOverflow } from "./socketUi";

/**
 * Plugin badges for one row.
 *
 * Placement is the host's, always after the row's own metadata, and capped at
 * two visible with the rest behind "+N". The cap is not cosmetic: a Lanes or PRs
 * row has a fixed width it already spends on the branch, the state and the
 * timestamp, and an uncapped socket would let one plugin push the product's own
 * information off the row.
 *
 * Renders nothing at all — not an empty flex container — when no plugin
 * contributes here, so an install-free machine pays no layout cost.
 */
export function PluginRowBadges({
  surface,
  context,
  active = true,
  className,
  style,
}: {
  surface: PluginSurfaceId;
  context: PluginSurfaceContext;
  /** False while the hosting surface is mounted but not visible. */
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const contributions = useSurfaceContributions(surface, "row-badge", { active, context });
  if (contributions.length === 0) return null;

  const { visible, overflowCount } = splitPluginRowBadges(contributions);
  const hidden = contributions.slice(visible.length);
  const dataTour = `plugin:${surface}.row-badge`;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}
    >
      {visible.map((contribution) => (
        // Real identity, never the array index: these render inside
        // virtualized lists whose rows are re-keyed as you scroll.
        <SocketBoundary key={contributionKey(contribution)}>
          <SocketBadge
            dataTour={dataTour}
            text={contribution.payload.text}
            tone={contribution.payload.tone}
            {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
            {...(contribution.payload.tooltip ? { tooltip: contribution.payload.tooltip } : {})}
          />
        </SocketBoundary>
      ))}
      {overflowCount > 0 ? (
        <SocketOverflow
          count={overflowCount}
          label={`${overflowCount} more from plugins`}
          dataTour={`plugin:${surface}.row-badge-overflow`}
        >
          {hidden.map((contribution) => (
            <SocketBoundary key={contributionKey(contribution)}>
              <SocketBadge
                text={contribution.payload.text}
                tone={contribution.payload.tone}
                {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                {...(contribution.payload.tooltip ? { tooltip: contribution.payload.tooltip } : {})}
              />
            </SocketBoundary>
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
