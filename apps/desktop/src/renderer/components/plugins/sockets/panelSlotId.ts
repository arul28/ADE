/**
 * The id a contributed pane or tab is persisted under.
 *
 * Pure string grammar, no React and no host calls, because the two stores that
 * hold a selected slot — the app store's `workSidebarTab` and the per-chat
 * companion state's `chatActionsTab` — are plain state modules that must not
 * pull a component tree in to normalize a string they read from localStorage.
 *
 * The grammar is `plugin:<pluginId>:<panelId>`, identical to `pluginViewerKind`
 * in `contributionModel`, which encodes the same fact for a persisted file
 * viewer. They are separate functions because they are read by different stores
 * with different lifetimes, and `contributionModel` is not importable from the
 * app store; `panelSlotId.test.ts` holds the two to each other so the pair
 * cannot drift into disagreeing about a plugin id that contains a colon.
 */

const SLOT_PREFIX = "plugin:";

/** Encode a slot id. Never parsed by a plugin — this is host-side identity. */
export function pluginPanelSlotId(pluginId: string, panelId: string): `plugin:${string}` {
  return `${SLOT_PREFIX}${pluginId}:${panelId}`;
}

/**
 * Decode a slot id, or `null` for anything that is not one.
 *
 * Splits on the FIRST colon after the prefix, so a panel id containing a colon
 * survives and a plugin id containing one does not — which matches the id
 * grammars the manifest parser enforces, and matches `parsePluginViewerKind`.
 */
export function parsePluginPanelSlotId(
  value: string,
): { pluginId: string; panelId: string } | null {
  if (!value.startsWith(SLOT_PREFIX)) return null;
  const rest = value.slice(SLOT_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { pluginId: rest.slice(0, separator), panelId: rest.slice(separator + 1) };
}

/** Whether a persisted tab id names a plugin slot rather than a built-in one. */
export function isPluginPanelSlotId(value: string): boolean {
  return parsePluginPanelSlotId(value) !== null;
}
