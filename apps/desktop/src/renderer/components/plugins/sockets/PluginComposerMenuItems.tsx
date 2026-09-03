import React from "react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { ComposerOverflowItem } from "../../chat/AgentChatComposer";
import { contributionKey } from "./contributionModel";
import { usePluginDeclaredWebviewPress } from "./usePluginDeclaredWebview";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { SocketIcon } from "./socketUi";

/**
 * Contributed rows in the composer's three-dot menu.
 *
 * A HOOK rather than a component, for the same reason `usePluginMenuEntries`
 * is one: the menu it joins is an ARRAY the composer builds, not a place in the
 * tree a component could be dropped into. `ComposerOverflowMenu` reads
 * `items.length` to decide whether it is a menu at all — it collapses to a bare
 * inline button at one item and renders nothing at zero — so a component that
 * appended rows from inside the popover would be invisible to that decision and
 * the menu would draw a "⋯" over a single core row with a plugin row hiding
 * behind it.
 *
 * The array is the placement contract too: the caller spreads this AFTER every
 * core entry, so a plugin never reorders `issue-context` or `app-control`.
 *
 * The live draft is read at PRESS time through `readContext`, never captured at
 * render. A composer's draft changes on every keystroke, and a context built
 * during render would either be stale by the time the row was pressed or force
 * the whole composer to re-render on every character typed.
 */

/** Namespaced so a contributed row can never collide with a core entry's id. */
export const PLUGIN_COMPOSER_MENU_ITEM_ID_PREFIX = "plugin:";

export function usePluginComposerMenuItems({
  surface = "work",
  sessionId,
  projectKey = null,
  projectRoot = null,
  laneId = null,
  readContext,
  active = true,
}: {
  /** The core surface the composer lives on. Only Work has one today. */
  surface?: PluginSurfaceId;
  /** Null on a composer that has not started a chat yet. */
  sessionId: string | null;
  projectKey?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /**
   * The whole composer context as it reads right now — draft, caret, model.
   * Must be stable; it is called on press, not on render.
   */
  readContext: () => PluginComposerContext;
  active?: boolean;
}): ComposerOverflowItem[] {
  /**
   * The identity half of the context, with the draft left empty.
   *
   * This is what selects contributions (which only ever reads the session) and
   * what a declared page is opened against — a picker is opened to CHOOSE
   * something, and the draft it will write into is read when the page answers.
   */
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
  // Filed per SESSION, exactly like `composer-action`: the composer context
  // resolves to a `{entityKind: "session"}` key and skips the surface fallback,
  // so a plugin can publish a per-chat row. See `useSurfaceContributions`.
  const contributions = useSurfaceContributions(surface, "composer-menu-item", {
    active,
    context: identity,
  });
  const invoke = usePluginSocketInvoke();
  const brandIconsFor = usePluginBrandIcons();
  const openDeclaredPage = usePluginDeclaredWebviewPress();

  return React.useMemo(() => contributions.map((contribution) => {
    const key = contributionKey(contribution);
    const brandIcons = brandIconsFor(contribution.pluginId);
    return {
      id: `${PLUGIN_COMPOSER_MENU_ITEM_ID_PREFIX}${key}`,
      label: contribution.payload.label,
      icon: (
        <SocketIcon
          name={contribution.payload.icon}
          size={14}
          {...brandIconsProp(brandIcons)}
        />
      ),
      onSelect: () => {
        // A row that DECLARED a page opens it instead of invoking — the rule
        // `usePluginDeclaredWebviewPress` documents. It opens as a picker over
        // the composer rather than a popover under the row, because the row
        // unmounts with the menu the press just closed and there would be no
        // element left to anchor to.
        if (openDeclaredPage({
          socket: "composer-menu-item",
          pluginId: contribution.pluginId,
          ...(contribution.payload.webviewSurfaceId
            ? { surfaceId: contribution.payload.webviewSurfaceId }
            : {}),
          subject: identity,
        })) return;
        void invoke(
          contribution.pluginId,
          contribution.payload.actionId,
          readContext(),
          { socket: "composer-menu-item" },
        );
      },
    } satisfies ComposerOverflowItem;
  }), [brandIconsFor, contributions, identity, invoke, openDeclaredPage, readContext]);
}
