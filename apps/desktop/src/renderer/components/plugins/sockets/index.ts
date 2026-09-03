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
export { PluginComposerActions, type PluginComposerSendOwner } from "./PluginComposerActions";
export { PluginChatHeaderActions } from "./PluginChatHeaderActions";
export { PluginChatCard } from "./PluginChatCard";
export {
  CHAT_CARD_ACTION_EVENT,
  ensurePluginChatCardActionBridge,
  handlePluginChatCardAction,
} from "./pluginChatCardBridge";
export { runPluginSocketAction } from "./pluginActionDispatch";
export { PluginFilterChips } from "./PluginFilterChips";
export { PluginEmptyStateExtra } from "./PluginEmptyStateExtra";
export { PluginDetailSections } from "./PluginDetailSections";
export { PluginActivityEntries, usePluginActivityEntryCount } from "./PluginActivityEntries";
export {
  PLUGIN_SETTINGS_FALLBACK_TAB,
  PluginSettingsSections,
  resolvePluginSettingsTab,
} from "./PluginSettingsSections";
export {
  PluginSlotPanel,
  usePluginPanelSlots,
  type PluginPanelSlot,
} from "./PluginPanelSlots";
export { PluginWebviewOverlayHost } from "./PluginWebviewOverlayHost";
export { PluginPromptHost } from "./PluginPromptHost";
export { PluginPanelPopoverHost } from "./PluginPanelPopoverHost";
export {
  closePluginPrompt,
  getPluginPrompt,
  openPluginPrompt,
  readPluginPromptAnchor,
  submitPluginPrompt,
  usePluginPrompt,
  type PluginPromptRequest,
} from "./pluginPromptStore";
export {
  closePluginWebviewOverlay,
  openPluginWebviewOverlay,
  usePluginWebviewOverlay,
  type PluginWebviewOverlayRequest,
} from "./pluginWebviewOverlayStore";
export {
  isPluginPanelSlotId,
  parsePluginPanelSlotId,
  pluginPanelSlotId,
} from "./panelSlotId";
export {
  PLUGIN_PALETTE_GROUP,
  usePluginPaletteCommands,
  type PluginPaletteCommand,
} from "./usePluginPaletteCommands";
export { PluginDialogSections } from "./PluginDialogSections";
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
  applyPluginDialogEdit,
  registerPluginDialogTarget,
  reportPluginDialogRefusal,
  unregisterPluginDialogTarget,
  type PluginDialogTarget,
} from "./dialogTarget";
export {
  pluginActionSubject,
  pluginAutomationContext,
  pluginDialogContext,
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
export {
  PLUGIN_SEARCH_GROUP,
  usePluginSearchResults,
  type PluginSearchRow,
} from "./usePluginSearchResults";
export {
  dispatchPluginKeybindingEvent,
  usePluginKeybindings,
} from "./usePluginKeybindings";
