/**
 * The socket taxonomy, as the six core surfaces consume it.
 *
 * One import per surface, so wiring a socket is adding a component next to the
 * core content rather than learning where the plugin plumbing lives. Everything
 * exported here is inert on a build with no plugin support and renders nothing
 * when no plugin contributes.
 */

export { PluginRowBadges } from "./PluginRowBadges";
export { PluginToolbarActions } from "./PluginToolbarActions";
export { PluginComposerActions } from "./PluginComposerActions";
export { PluginFilterChips } from "./PluginFilterChips";
export { PluginEmptyStateExtra } from "./PluginEmptyStateExtra";
export { PluginDetailSections } from "./PluginDetailSections";
export { usePluginMenuEntries, type PluginMenuEntry } from "./usePluginMenuEntries";
export { pluginContextMenuItems, PLUGIN_MENU_SECTION_LABEL } from "./pluginContextMenuItems";
export { useExtendSurfaceEntry, extendSurfaceRoute } from "./useExtendSurfaceEntry";
export { SocketBoundary } from "./SocketBoundary";
export {
  usePluginFileViewers,
  usePluginSocketInvoke,
  usePluginSurfaceContributions,
  useSurfaceContributions,
} from "./useSurfaceContributions";
export {
  registerPluginComposerTarget,
  unregisterPluginComposerTarget,
  type PluginComposerTarget,
} from "./composerTarget";
export {
  pluginAutomationContext,
  pluginLaneContext,
  pluginPrContext,
  pluginSessionContext,
} from "./surfaceContexts";
export {
  contributionKey,
  entityMatchesPluginFilters,
  matchPluginViewer,
  parsePluginViewerKind,
  pluginViewerKind,
  pluginViewerRegistrations,
  type PluginViewerRegistration,
  type SurfaceContributionSet,
} from "./contributionModel";
