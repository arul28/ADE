import React from "react";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { SocketButton, SocketMenuRow, SocketOverflow } from "./socketUi";

/** Plugin buttons never crowd out the surface's own; beyond this they fold away. */
const VISIBLE_LIMIT = 2;

/**
 * Contributed toolbar actions, grouped after the surface's own.
 *
 * Two visible, the rest in an overflow menu — the same restraint as row badges
 * and for the same reason: a toolbar is the surface's primary verbs, and a
 * plugin joins that row rather than taking it over.
 *
 * The context defaults to the surface itself, so a toolbar action on Lanes
 * receives `{kind: "surface", surface: "lanes"}` and one invoked from a detail
 * pane receives that pane's entity.
 */
export function PluginToolbarActions({
  surface,
  context,
  active = true,
  style,
}: {
  surface: PluginSurfaceId;
  /** Defaults to the surface-only context. */
  context?: PluginSurfaceContext;
  active?: boolean;
  style?: React.CSSProperties;
}) {
  const resolvedContext = React.useMemo<PluginSurfaceContext>(
    () => context ?? { kind: "surface", surface },
    [context, surface],
  );
  const contributions = useSurfaceContributions(surface, "toolbar-action", {
    active,
    context: resolvedContext,
  });
  const invoke = usePluginSocketInvoke();

  if (contributions.length === 0) return null;

  const visible = contributions.slice(0, VISIBLE_LIMIT);
  const hidden = contributions.slice(VISIBLE_LIMIT);
  const dataTour = `plugin:${surface}.toolbar-action`;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      {visible.map((contribution) => (
        <SocketButton
          key={contributionKey(contribution)}
          dataTour={dataTour}
          label={contribution.payload.label}
          {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
          {...(contribution.payload.disabled ? { disabled: true } : {})}
          onClick={() => invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext)}
        />
      ))}
      {hidden.length > 0 ? (
        <SocketOverflow
          count={hidden.length}
          label={`${hidden.length} more plugin actions`}
          dataTour={`${dataTour}-overflow`}
        >
          {hidden.map((contribution) => (
            <SocketMenuRow
              key={contributionKey(contribution)}
              label={contribution.payload.label}
              {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
              onClick={() => invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext)}
            />
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
