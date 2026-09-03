import React from "react";

import type { PluginSurfaceOnlyContext } from "../../../../shared/plugins/context";
import { contributionKey } from "./contributionModel";
import { pluginActionSubject } from "./surfaceContexts";
import { rootAppStoreApi, selectActiveProjectStateKey } from "../../../state/appStore";
import { runPluginSocketAction } from "./pluginActionDispatch";
import { usePluginDeclaredWebviewPress } from "./usePluginDeclaredWebview";
import { formatPluginChordForDisplay, usePluginKeybindings } from "./usePluginKeybindings";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `command-palette-action` socket: a plugin's verbs, reachable from ⌘K.
 *
 * The audit called this the highest-leverage single socket, and the reason is
 * that it is the only placement a plugin can rely on. Every other seam requires
 * the user to be looking at the right tab, the right row, or the right drawer;
 * the palette is open from anywhere, so a plugin that contributes one entry here
 * is reachable from the whole product. It is also the cheapest to build against
 * — the same `{label, actionId}` a toolbar button already declares.
 *
 * A hook rather than a component because the palette does not render a list of
 * components: it filters, groups, and keyboard-navigates a flat `Command[]` that
 * it owns. Handing it rows to fold into that array keeps plugin entries subject
 * to the same search, the same grouping and the same selection model as ADE's
 * own commands, which is the entire point of being in the palette.
 */

/**
 * One palette row, shaped for `CommandPalette`'s own `Command` type.
 *
 * Deliberately structural rather than an import of that type: the palette is a
 * page component and this is plugin plumbing, and coupling them would mean the
 * socket layer could not be tested without mounting a 3000-line dialog.
 */
export type PluginPaletteCommand = {
  id: string;
  title: string;
  hint: string;
  keywords: string[];
  /**
   * The chord this row also answers to, formatted for the reader's platform.
   *
   * Present only when the plugin's declaration actually SURVIVED the collision
   * matrix. A refused binding leaves this undefined and the row draws no chip,
   * because a chip is a promise that pressing those keys does this — and the
   * palette is the only attributed surface the desktop has for saying so.
   */
  shortcut?: string;
  run: () => void;
};

/** The group contributed rows sit under, after the product's own groups. */
export const PLUGIN_PALETTE_GROUP = "Plugins";

const PALETTE_CONTEXT: PluginSurfaceOnlyContext = { kind: "surface", surface: "app" };

/**
 * Contributed palette rows.
 *
 * `active` should be the palette's own open state. Nothing is read until it is
 * true, so a closed palette costs nothing — the palette is mounted for the
 * whole life of the app, which is exactly the case the store's reveal-gating
 * exists for.
 */
export function usePluginPaletteCommands(active: boolean): PluginPaletteCommand[] {
  const contributions = useSurfaceContributions("app", "command-palette-action", {
    active,
    context: PALETTE_CONTEXT,
  });
  const { identities } = usePluginSurfaceContributions("app", active);
  // Resolved chords, keyed the way a contribution names its verb. Built from the
  // matrix's OUTPUT, never from the manifest declarations, so a plugin that
  // asked for ⌘K and lost gets no chip — see `PluginPaletteCommand.shortcut`.
  const { bindings } = usePluginKeybindings();
  // A palette row that DECLARED a page opens it as a focused overlay instead of
  // invoking — the palette belongs to no place on screen, so there is nothing
  // to anchor a card to. A row that declared none invokes as it always did.
  const openDeclaredPage = usePluginDeclaredWebviewPress();
  const shortcuts = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of bindings) {
      const display = formatPluginChordForDisplay(binding.binding);
      if (display) map.set(`${binding.pluginId}::${binding.action}`, display);
    }
    return map;
  }, [bindings]);

  return React.useMemo(
    () => contributions
      // A disabled palette entry has nowhere to be disabled. Every other host
      // for this payload draws a dimmed control that says "not now"; a list
      // optimized for typing four letters and pressing Enter has no such state,
      // so the honest rendering of `disabled` here is absence.
      .filter((contribution) => !contribution.payload.disabled)
      .map((contribution) => {
        const identity = identities.get(contribution.pluginId);
        const name = identity?.displayName ?? contribution.pluginId;
        const shortcut = shortcuts.get(`${contribution.pluginId}::${contribution.payload.actionId}`);
        return {
          id: `plugin-action-${contributionKey(contribution)}`,
          title: contribution.payload.label,
          // The palette renders the hint, so this is the attribution: two
          // plugins may both contribute "Refresh" and the row has to say whose.
          hint: `${name} plugin`,
          // Keywords never render; they widen what the palette's filter matches
          // on, so typing a plugin's name finds everything it contributes.
          keywords: ["plugin", contribution.pluginId, name],
          // Absent rather than `undefined`, so a row with no working chord is
          // shaped identically to one from a plugin that declared none — the
          // palette then has one thing to check instead of two.
          ...(shortcut ? { shortcut } : {}),
          run: () => {
            // The subject rides BESIDE the context, never instead of it: the
            // context is what selects which contributions the palette shows,
            // and pointing it at a chat would quietly change the list. Read at
            // press time off the live store, because the rows were built when
            // the palette opened and the reader may have moved since.
            const subject = pluginActionSubject(readPaletteSubjectInput());
            if (openDeclaredPage({
              socket: "command-palette-action",
              pluginId: contribution.pluginId,
              ...(contribution.payload.webviewSurfaceId
                ? { surfaceId: contribution.payload.webviewSurfaceId }
                : {}),
              // The same subject the invoke would have carried, so a page
              // opened from ⌘K knows which chat or lane the reader was on.
              // `{kind: "none"}` is the palette's way of saying there was
              // nothing to be on, which a page reads as a null subject — the
              // same thing a full tab webview gets.
              subject: subject.kind === "none" ? null : subject,
            })) return;
            void runPluginSocketAction(
              contribution.pluginId,
              contribution.payload.actionId,
              PALETTE_CONTEXT,
              {
                socket: "command-palette-action",
                args: { subject },
                label: contribution.payload.label,
              },
            );
          },
        };
      }),
    [contributions, identities, openDeclaredPage, shortcuts],
  );
}

/**
 * The chat and lane the palette was opened over, off the live store.
 *
 * Read the way the palette's own thread rows are read — the Work tab's
 * per-project session cache and that project's active item — rather than from
 * the root `focusedSessionId`, so the subject is the conversation the reader
 * can actually see rather than the last one any window focused.
 *
 * Every miss is a null and never a throw: a projectless window, a cache the
 * Work tab has not filled yet, an active item that is a terminal rather than a
 * chat. The subject is then the lane, or `{kind: "none"}`.
 */
function readPaletteSubjectInput(): Parameters<typeof pluginActionSubject>[0] {
  const state = rootAppStoreApi.getState();
  const key = selectActiveProjectStateKey(state);
  const sessions = key ? state.sessionsCacheByProject[key] ?? [] : [];
  const activeItemId = key ? state.workViewByProject[key]?.activeItemId ?? null : null;
  const session = activeItemId
    ? sessions.find((entry) => entry.id === activeItemId) ?? null
    : null;
  const lane = state.selectedLaneId
    ? state.lanes.find((entry) => entry.id === state.selectedLaneId) ?? null
    : null;
  return { session, lane };
}
