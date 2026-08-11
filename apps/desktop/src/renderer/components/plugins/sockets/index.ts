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
export { PluginFilterChips } from "./PluginFilterChips";
export { PluginEmptyStateExtra } from "./PluginEmptyStateExtra";
export { PluginDetailSections, usePluginDetailSectionCount } from "./PluginDetailSections";
export { usePluginMenuEntries, type PluginMenuEntry } from "./usePluginMenuEntries";
export { useExtendSurfaceEntry, extendSurfaceRoute } from "./useExtendSurfaceEntry";
export {
  usePluginFileViewers,
  usePluginSocketInvoke,
  usePluginSurfaceContributions,
  useSurfaceContributions,
} from "./useSurfaceContributions";
export {
  pluginFileContext,
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
