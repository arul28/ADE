/**
 * The closed list of gateable compiled surfaces, and the four facts about each
 * one that are true before anything is parsed, drawn or installed: its id, its
 * polarity, whether the phone ships a page for it, and which official package
 * owns it.
 *
 * ## Why this is its own module
 *
 * These constants have three consumers that sit at different heights in the
 * import graph, and until this module existed the tallest of them owned the
 * facts:
 *
 * - `manifest.ts` validates `surfaces[].builtin` and `credentialHandoff`
 *   against the id list, and refuses the `builtin` field on a `"supersedes"`
 *   surface.
 * - `builtinSurfaces.ts` hangs the rich owner table — routes, titles, gated
 *   action domains and action names — off the same ids.
 * - `urlMatchers.ts` needs OWNERSHIP alone, to decide whether an official
 *   package may claim a core smart-link host.
 *
 * `manifest.ts` imports `urlMatchers.ts` (the manifest parser validates the
 * matcher language), so `urlMatchers.ts` could not import back for the one map
 * it wanted, and kept a hand-written mirror of the owner names pinned by a
 * test. This module has NO imports at all — it is deliberately a leaf, and must
 * stay one — so every layer above can read the same table instead of copying
 * it. Add nothing here that needs to import: parsing belongs in `manifest.ts`,
 * and anything with a route, a title or an action name belongs in
 * `builtinSurfaces.ts`.
 *
 * `manifest.ts` re-exports the id list, the type, the predicate and both
 * keyed tables, so the ~20 call sites that already import them from there keep
 * working. New code should import from this module directly.
 */

/**
 * Tabs that ship compiled into the app and can be *gated* by a plugin rather
 * than rendered by one.
 *
 * Some of ADE's own tabs cannot be expressed as vocabulary — the Graph is an
 * interactive canvas, not a list of rows — but they are still optional weight
 * in the rail. A surface with `builtin` set does not draw anything: it says
 * "this plugin owns the existing tab named here", and the client renders its
 * own compiled page in place of a plugin panel. Uninstalling the plugin takes
 * every entry point for that compiled surface out of the product. Routes and
 * deeplinks must fail closed too; a hidden rail item is not an access control.
 *
 * Graph, Review and History used to sit on this `builtin` field. They
 * SUPERSEDE now: the plugins draw their own panels, and ADE's compiled pages
 * step aside. The `builtin` field remains for the surfaces that still only
 * exist while a gating plugin is installed (iOS Simulator, Electron Control).
 *
 * The list is CLOSED and lives here rather than in the renderer because every
 * client validates against it: a name outside it is a manifest typo, and
 * honouring it would produce a rail item that navigates nowhere.
 */
export const PLUGIN_BUILTIN_SURFACE_IDS = [
  "graph",
  "review",
  "history",
  "linear",
  "ios",
  "app-control",
  "cursor-cloud",
] as const;

export type PluginBuiltinSurfaceId = (typeof PLUGIN_BUILTIN_SURFACE_IDS)[number];

export function isPluginBuiltinSurfaceId(value: unknown): value is PluginBuiltinSurfaceId {
  return PLUGIN_BUILTIN_SURFACE_IDS.some((id) => id === value);
}

/**
 * Which way round the owner plugin and the compiled surface relate.
 *
 * Two opposite relationships share this one table, and a single boolean cannot
 * carry both:
 *
 * - `"enables"` — the plugin is the only reason the surface exists. ADE draws
 *   the compiled page only while the owner is installed and enabled. Every
 *   unknown hides it, so there is no state in which a surface appears because
 *   ADE was unsure. This is what the iOS Simulator pane and Electron Control
 *   do: ADE never shipped those compiled as default-on surfaces, so there is
 *   nothing to hand back when the plugin leaves.
 * - `"supersedes"` — the plugin REPLACES a surface ADE already ships compiled.
 *   ADE draws the compiled page only while the owner is ABSENT. Every unknown
 *   SHOWS it, because the built-in is what the product has always done and a
 *   machine without the plugin must behave exactly as it did before the plugin
 *   existed. Hiding on an unknown would delete a shipped feature every time the
 *   registry had not resolved yet. This is what Graph, Cursor Cloud, Linear,
 *   Review and History do: ADE shipped those compiled long before the plugins
 *   existed, and an install with no owner must still be the product it was.
 *
 * The polarity also decides what the manifest may say. A `"supersedes"` surface
 * is never named by a `surfaces[].builtin` field: that field means "ADE draws
 * this compiled page in my place", and a plugin that supersedes a surface draws
 * its own panels instead. See `parseSurfaces` in `manifest.ts`, which refuses
 * the combination rather than producing a rail item that navigates nowhere.
 *
 * Keyed by the closed id list above, so adding a gateable surface without
 * deciding this question does not compile.
 */
export const PLUGIN_BUILTIN_SURFACE_PRESENCE: Readonly<
  Record<PluginBuiltinSurfaceId, "enables" | "supersedes">
> = {
  graph: "supersedes",
  review: "supersedes",
  history: "supersedes",
  linear: "supersedes",
  ios: "enables",
  "app-control": "enables",
  "cursor-cloud": "supersedes",
};

/**
 * Which gated built-ins the phone has a page for.
 *
 * A `builtin` surface renders compiled code, not a panel schema, so "does it
 * appear on mobile" is a fact about what the iOS app SHIPS — not something a
 * manifest can decide. The phone ships a Linear pane and a Cursor Cloud screen;
 * the Graph canvas, the simulator pane and Electron Control are not ported as
 * compiled screens, and declaring `mobile: true` on one of them would put a
 * rail entry in front of a renderer that does not exist. Review, History and
 * Graph compiled pages are desktop-only too (`false` here); `ade-review`,
 * `ade-history` and `ade-graph` draw their own panels on the phone instead. So
 * the table is the ceiling for COMPILED screens and the manifest may only
 * narrow it.
 *
 * Keyed by the closed id list above, so adding a gateable surface without
 * deciding this question does not compile.
 *
 * `linear` and `cursor-cloud` both record `true` because the phone really does
 * ship those screens, which is the question this table asks. Nothing reads
 * either entry today, and that is now true of EVERY `true` in the table: the
 * ceiling only ever applies to a surface a manifest named with `builtin`, a
 * `"supersedes"` surface may not be named that way at all, and both of the
 * phone's screens supersede — see {@link PLUGIN_BUILTIN_SURFACE_PRESENCE}. So
 * the only rule that runs today is the clamp on a built-in the phone cannot
 * draw. The honest answer is still the one to record, so a later change that
 * does consult it does not read a lie.
 */
export const PLUGIN_BUILTIN_SURFACE_MOBILE: Readonly<Record<PluginBuiltinSurfaceId, boolean>> = {
  graph: false,
  review: false,
  history: false,
  linear: true,
  ios: false,
  "app-control": false,
  "cursor-cloud": true,
};

/**
 * The official plugin that owns each compiled surface — the single source of
 * truth for ownership, and the whole reason this module is a leaf.
 *
 * Held in a table rather than discovered from whichever installed plugin
 * happens to declare `builtin`, so a plugin cannot take over a core surface by
 * naming it: the manifest field says "I gate the surface I am registered for",
 * and this table is the registration. Ownership also survives BOTH polarities,
 * which the `builtin` field does not — a `"supersedes"` plugin may not name its
 * surface at all (see {@link PLUGIN_BUILTIN_SURFACE_PRESENCE}), so anything
 * keyed on the manifest field loses `ade-linear` entirely.
 *
 * `builtinSurfaces.ts` reads these names into `BUILTIN_SURFACE_OWNERS`, where
 * each one gains a route, a title and the action domains and names it gates;
 * `urlMatchers.ts` reads them bare, to decide whether an official package may
 * claim a core smart-link host. Neither spells an owner id of its own.
 *
 * Keyed by the closed id list above, so adding a gateable surface without
 * naming its owner does not compile.
 */
export const PLUGIN_BUILTIN_SURFACE_OWNER_IDS: Readonly<
  Record<PluginBuiltinSurfaceId, string>
> = {
  graph: "ade-graph",
  review: "ade-review",
  history: "ade-history",
  linear: "ade-linear",
  ios: "ade-ios-sim",
  "app-control": "ade-app-control",
  "cursor-cloud": "ade-cursor-cloud",
};
