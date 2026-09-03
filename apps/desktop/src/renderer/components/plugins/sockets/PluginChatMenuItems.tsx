import React from "react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import type {
  PluginChatMenuSubmenu,
  PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import { useRootAppStore } from "../../../state/appStore";
import { supportsPluginWebviews } from "../PluginWebviewHost";
import { contributionKey } from "./contributionModel";
import { openPluginActionWebview, runPluginSocketAction } from "./pluginActionDispatch";
import { resolvePluginDeclaredWebview } from "./pluginDeclaredWebview";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";

/**
 * Contributed rows nested under one of the chat's NAMED submenus.
 *
 * `issue-context` is the only one today: ADE's own "Attach issue context" list,
 * which ships with a Linear row and a GitHub row in it. A plugin joins that
 * list after them — the placement rule at the top of `sockets.ts`, unchanged.
 *
 * Two exports rather than one, because the caller needs both halves and needs
 * them at different moments. The HOOK is what the composer counts to decide
 * whether the submenu exists at all: with no Linear and no GitHub repo the
 * entry and its popover are gated away entirely, and a plugin row has to be
 * able to open the submenu on its own or it declares a row nobody can reach.
 * The COMPONENT is what draws inside the popover once it is open.
 */

/**
 * The submenu the popover paints itself into.
 *
 * A page opened from one of these rows anchors HERE rather than to the row that
 * was pressed. The submenu deliberately stays mounted behind the page — the row
 * would unmount with it and take its rect along — and anchoring to the list
 * rather than to one row inside it also keeps the card still if the list
 * re-renders under the open page.
 */
const SUBMENU_ANCHOR_SELECTOR = "[data-issue-context-menu]";

function readSubmenuAnchor(): { x: number; y: number; width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const menu = document.querySelector<HTMLElement>(SUBMENU_ANCHOR_SELECTOR);
  if (!menu) return null;
  const rect = menu.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** One contributed submenu row, ready for the caller's JSX. */
export type PluginChatMenuRow = {
  /** `contributionKey` — stable across renders, unique across plugins. */
  key: string;
  pluginId: string;
  label: string;
  icon?: string;
  /** The plugin's manifest accent, for the row's icon square. Null is fine. */
  accent: string | null;
  onSelect: () => void;
};

export function usePluginChatMenuItems({
  submenu,
  surface = "work",
  sessionId,
  projectKey = null,
  projectRoot = null,
  laneId = null,
  readContext,
  active = true,
}: {
  /** Which core submenu to read rows for. */
  submenu: PluginChatMenuSubmenu;
  surface?: PluginSurfaceId;
  sessionId: string | null;
  projectKey?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /** The live composer context, read on press rather than at render. */
  readContext: () => PluginComposerContext;
  active?: boolean;
}): PluginChatMenuRow[] {
  const identity = React.useMemo<PluginComposerContext>(
    () => ({
      kind: "composer",
      sessionId,
      projectKey,
      projectRoot,
      laneId,
      draft: "",
      cursor: null,
    }),
    [laneId, projectKey, projectRoot, sessionId],
  );
  const contributions = useSurfaceContributions(surface, "chat-menu-item", {
    active,
    context: identity,
  });
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const supported = supportsPluginWebviews();

  return React.useMemo(() => contributions
    // The payload's `submenu` is REQUIRED and parsed against a closed list, so
    // a row that reaches here names a submenu this build draws. Filtering is
    // still the caller's only way to ask for one list rather than all of them.
    .filter((contribution) => contribution.payload.submenu === submenu)
    .map((contribution) => {
      const plugin = installedPlugins.find((entry) => entry.pluginId === contribution.pluginId);
      return {
        key: contributionKey(contribution),
        pluginId: contribution.pluginId,
        label: contribution.payload.label,
        ...(contribution.payload.icon ? { icon: contribution.payload.icon } : {}),
        accent: plugin?.accent ?? null,
        onSelect: () => {
          const page = resolvePluginDeclaredWebview({
            pluginId: contribution.pluginId,
            surfaceId: contribution.payload.webviewSurfaceId,
            installed: installedPlugins,
            supported,
          });
          if (page) {
            // Opened directly rather than through `usePluginDeclaredWebviewPress`
            // for the anchor alone: that hook reads the focused element, which
            // here is the row, and the row is the one element in this popover
            // that will not survive the list re-rendering under it.
            openPluginActionWebview({
              pluginId: contribution.pluginId,
              surfaceId: page.surfaceId,
              placement: "popover",
              subject: identity,
              anchor: readSubmenuAnchor(),
            });
            return;
          }
          void runPluginSocketAction(
            contribution.pluginId,
            contribution.payload.actionId,
            readContext(),
            { socket: "chat-menu-item", label: contribution.payload.label },
          );
        },
      } satisfies PluginChatMenuRow;
    }), [contributions, identity, installedPlugins, readContext, submenu, supported]);
}

/**
 * The rows, drawn in the submenu's own shape.
 *
 * Deliberately the SAME markup ADE's Linear and GitHub rows use — one plain
 * button, a 6×6 tinted icon square, one bold label line — because a contributed
 * row that looked different would read as a different KIND of thing in a list
 * of three otherwise identical choices. The only thing a plugin varies is the
 * glyph and the tint, which come off its own manifest.
 */
export function PluginChatMenuRows({
  rows,
}: {
  rows: readonly PluginChatMenuRow[];
}) {
  const brandIconsFor = usePluginBrandIcons();
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <SocketBoundary key={row.key}>
          <button
            type="button"
            data-plugin-chat-menu-item={row.key}
            className="ade-chat-drawer-row flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/75"
            onClick={row.onSelect}
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
              style={{
                // `color-mix` against the plugin's own accent, so the square
                // reads at the same weight as Linear's and GitHub's without
                // each plugin having to ship a second "surface" colour. No
                // accent falls back to the neutral wash the drawer already uses.
                background: row.accent
                  ? `color-mix(in srgb, ${row.accent} 16%, transparent)`
                  : "rgba(255,255,255,0.06)",
                ...(row.accent ? { color: row.accent } : {}),
              }}
            >
              <SocketIcon
                name={row.icon}
                size={12}
                {...brandIconsProp(brandIconsFor(row.pluginId))}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{row.label}</span>
            </span>
          </button>
        </SocketBoundary>
      ))}
    </>
  );
}
