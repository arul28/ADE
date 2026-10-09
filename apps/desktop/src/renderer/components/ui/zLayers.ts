/**
 * The app's stacking scale. Pick a named layer instead of inventing a z-index:
 * a new overlay that guesses a number either hides under something it should
 * cover or covers something that must stay on top (a dialog, the capture HUD).
 *
 * Ordered low to high. Most values are the numbers the existing surfaces
 * already used, so adopting a name does not change what renders above what.
 * One layer moved on purpose: `toast` sits above `dialog` (it was 95, under
 * everything), so a toast raised from inside a dialog (a cleanup result, a
 * batch launch) is visible instead of hidden behind the scrim. The viewport
 * lives inside `<main>`, which creates no stacking context, so this value
 * competes directly with the body-portaled dialogs.
 */
export const Z_LAYERS = {
  /**
   * A submenu panel floating off its host menu row.
   *
   * Relative, not absolute: the panel is a child of the host menu, so it is
   * ordered inside that menu's stacking context. The host's own layer (a
   * context menu, a dialog popover, a sheet) is what decides which app
   * surfaces the whole menu covers; this only has to beat its siblings.
   */
  menuPanel: 60,
  /** Draft chrome while a new chat opens, beneath the first-message handoff. */
  chatDraftDeparture: 79,
  /** The first-message handoff animation above the departing draft chrome. */
  chatFirstMessageHandoff: 80,
  /** Anchored popovers and menus: the model picker, the reasoning-effort picker. */
  popover: 100,
  /** The app sidebar and anchored popovers share their existing content layer. */
  sidebar: 100,
  /** Top-bar dropdown sheets (Connections, usage, activity). */
  sheet: 120,
  /** The command palette's backdrop; it shares the sheets' level. */
  commandPalette: 120,
  /** Floating top-center banners. */
  floatingBanner: 140,
  /**
   * A full-viewport app surface (the Mac Desktop fullscreen view). Below
   * dialogs and toasts so a confirm or picker raised from inside it works.
   */
  fullscreenTakeover: 150,
  /** Modal dialogs and their scrim. */
  dialog: 200,
  /**
   * A menu or popover anchored inside a dialog (a row's "More" menu). The
   * app's `popover` layer sits under the dialog scrim, and `nestedDialog` is
   * for modal confirms, which a menu must stay beneath.
   */
  dialogPopover: 205,
  /** A confirm/prompt raised from inside another dialog. */
  nestedDialog: 210,
  /** Bottom-right toast viewport; above dialogs so a dialog's own result toast shows. */
  toast: 250,
  /** Tooltips and hover cards; above dialogs so a dialog's tooltips work. */
  tooltip: 300,
  /** A right-click / row context menu and its click-away layer, above every app surface. */
  contextMenu: 9999,
  /** A lane's private macOS screen. Above context menus so the screen covers the app. */
  macDesktop: 40000,
  /** A confirm or picker opened over that screen. */
  macDesktopDialog: 40100,
  /** The global capture gesture notice: above everything, including context menus. */
  capture: 2147483000,
} as const;

export type ZLayer = keyof typeof Z_LAYERS;
