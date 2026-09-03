import React from "react";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { usePluginDeclaredWebviewPress } from "./usePluginDeclaredWebview";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { SocketBoundary } from "./SocketBoundary";
import {
  SOCKET_SHELL_CHEVRON_CLASS,
  SocketButton,
  SocketMenuRow,
  SocketMenuSubRows,
  SocketOverflow,
  SocketSplitGroup,
  SocketSplitMenu,
  socketTintStyle,
  type SocketButtonChrome,
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
 * The same joint in the window header's chrome.
 *
 * `ade-shell-control` owns the radius and the border there, so the seam is made
 * by removing the chevron's left edge rather than by drawing a second box —
 * which is the whole reason the cluster gets a chrome of its own.
 */
const SHELL_SPLIT_CHEVRON_STYLE: React.CSSProperties = {
  borderLeft: "none",
  borderTopLeftRadius: 0,
  borderBottomLeftRadius: 0,
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
  chrome = "default",
}: {
  surface: PluginSurfaceId;
  /** Defaults to the surface-only context. */
  context?: PluginSurfaceContext;
  active?: boolean;
  style?: React.CSSProperties;
  /**
   * The button chrome for this host. `shell` is the window top bar's, where the
   * generic socket pill read as a taller control with a doubled edge beside the
   * 20px shell buttons it sits between — see {@link SOCKET_SHELL_BUTTON_CLASS}.
   */
  chrome?: SocketButtonChrome;
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
  // A toolbar button that DECLARED a page opens it under itself instead of
  // invoking — see `usePluginDeclaredWebviewPress`. One that declared none
  // invokes exactly as it always did.
  const openDeclaredPage = usePluginDeclaredWebviewPress();
  const press = React.useCallback((contribution: {
    pluginId: string;
    payload: { actionId: string; webviewSurfaceId?: string };
  }) => {
    if (openDeclaredPage({
      socket: "toolbar-action",
      pluginId: contribution.pluginId,
      ...(contribution.payload.webviewSurfaceId
        ? { surfaceId: contribution.payload.webviewSurfaceId }
        : {}),
      subject: resolvedContext,
    })) return;
    void invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext);
  }, [invoke, openDeclaredPage, resolvedContext]);
  // The declaring plugin's own artwork. Without it `brand:linear` resolved to
  // the puzzle piece here while the tab rail beside it drew Linear's mark.
  const brandIconsFor = usePluginBrandIcons();

  if (contributions.length === 0) return null;

  const visible = contributions.slice(0, VISIBLE_LIMIT);
  const hidden = contributions.slice(VISIBLE_LIMIT);
  const dataTour = `plugin:${surface}.toolbar-action`;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      {visible.map((contribution) => {
        const menu = contribution.payload.menu ?? [];
        // A toolbar action has no busy state to compete with, so the tint is
        // unconditional here — unlike the composer and chat-header buttons,
        // where the platform's running chrome takes the control back.
        const tint = socketTintStyle(contribution.payload.color);
        const brandIcons = brandIconsFor(contribution.pluginId);
        const button = (
          <SocketButton
            dataTour={dataTour}
            label={contribution.payload.label}
            {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
            {...brandIconsProp(brandIcons)}
            {...(contribution.payload.disabled ? { disabled: true } : {})}
            {...(chrome === "shell" ? { chrome } : {})}
            style={{ ...(menu.length > 0 && chrome !== "shell" ? SPLIT_BUTTON_STYLE : {}), ...tint }}
            onClick={() => press(contribution)}
          />
        );
        return (
          <SocketBoundary key={contributionKey(contribution)}>
            {/* No menu, no wrapper: a plain button renders exactly what it
                rendered before the field existed. */}
            {menu.length === 0 ? button : (
              <SocketSplitGroup>
                {button}
                <SocketSplitMenu
                  items={menu}
                  label={contribution.payload.label}
                  {...brandIconsProp(brandIcons)}
                  dataTour={`${dataTour}-menu`}
                  {...(chrome === "shell"
                    ? { className: SOCKET_SHELL_CHEVRON_CLASS, style: { ...SHELL_SPLIT_CHEVRON_STYLE, ...tint } }
                    : { style: { ...SPLIT_CHEVRON_STYLE, ...tint } })}
                  onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
                />
              </SocketSplitGroup>
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
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                onClick={() => press(contribution)}
              />
              <SocketMenuSubRows
                items={contribution.payload.menu ?? []}
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
              />
            </SocketBoundary>
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
