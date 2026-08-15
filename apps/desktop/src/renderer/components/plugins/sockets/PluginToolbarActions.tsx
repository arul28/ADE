import React from "react";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";
import {
  SocketButton,
  SocketMenuRow,
  SocketMenuSubRows,
  SocketOverflow,
  SocketSplitMenu,
} from "./socketUi";
import { COLORS, RADII } from "../../lanes/laneDesignTokens";

/** Plugin buttons never crowd out the surface's own; beyond this they fold away. */
const VISIBLE_LIMIT = 2;

/**
 * The chevron, wearing `SocketButton`'s chrome minus its left edge.
 *
 * Butted against the button rather than spaced from it, so the pair reads as one
 * control with two halves — which is what a split button is, and what the user
 * who asked for "a small arrow on the drink button" was describing.
 */
const SPLIT_CHEVRON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
  width: 18,
  color: COLORS.textSecondary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.borderMuted}`,
  borderLeft: "none",
  borderRadius: `0 ${RADII.sm} ${RADII.sm} 0`,
  cursor: "pointer",
};

/** The button half loses its right radius when a chevron is butted against it. */
const SPLIT_BUTTON_STYLE: React.CSSProperties = {
  borderRadius: `${RADII.sm} 0 0 ${RADII.sm}`,
};

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
  // The OTHER side of the rule on `useSurfaceContributions`, and the reason that
  // rule needs stating: this kind's default context is surface-only, so it takes
  // the surface fallback and reads `{entityKind: "surface"}` rows — filed
  // against the tab. The chat-header and composer kinds make the same-shaped
  // call with an ENTITY context and are filed against the chat instead. Copying
  // this call for one of those files the contribution in the wrong place.
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
      {visible.map((contribution) => {
        const menu = contribution.payload.menu ?? [];
        const button = (
          <SocketButton
            dataTour={dataTour}
            label={contribution.payload.label}
            {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
            {...(contribution.payload.disabled ? { disabled: true } : {})}
            {...(menu.length > 0 ? { style: SPLIT_BUTTON_STYLE } : {})}
            onClick={() => invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext)}
          />
        );
        return (
          <SocketBoundary key={contributionKey(contribution)}>
            {/* No menu, no wrapper: a plain button renders exactly what it
                rendered before the field existed. */}
            {menu.length === 0 ? button : (
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                {button}
                <SocketSplitMenu
                  items={menu}
                  label={contribution.payload.label}
                  dataTour={`${dataTour}-menu`}
                  style={SPLIT_CHEVRON_STYLE}
                  onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
                />
              </span>
            )}
          </SocketBoundary>
        );
      })}
      {hidden.length > 0 ? (
        <SocketOverflow
          count={hidden.length}
          label={`${hidden.length} more plugin actions`}
          dataTour={`${dataTour}-overflow`}
        >
          {hidden.map((contribution) => (
            <SocketBoundary key={contributionKey(contribution)}>
              <SocketMenuRow
                label={contribution.payload.label}
                {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                onClick={() => invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext)}
              />
              <SocketMenuSubRows
                items={contribution.payload.menu ?? []}
                onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
              />
            </SocketBoundary>
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
