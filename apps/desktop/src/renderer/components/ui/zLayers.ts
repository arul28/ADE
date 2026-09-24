/**
 * The app's stacking scale. Pick a named layer instead of inventing a z-index:
 * a new overlay that guesses a number either hides under something it should
 * cover or covers something that must stay on top (a dialog, the capture HUD).
 *
 * Ordered low to high. Most values are the numbers the existing surfaces
 * already used, so adopting a name does not change what renders above what.
 * Two layers moved on purpose:
 * - `toast` sits above `dialog` (it was 95, under everything), so a toast
 *   raised from inside a dialog (a cleanup result, a batch launch) is visible
 *   instead of hidden behind the scrim. The viewport lives inside `<main>`,
 *   which creates no stacking context, so this value competes directly with
 *   the body-portaled dialogs.
 * - `hud` sits above `sheet` (the CTO call HUD was 112), so the call's End
 *   button stays clickable while a top-bar sheet's click-away layer is open.
 */
export const Z_LAYERS = {
  /** Anchored popovers and menus: the model picker, the reasoning-effort picker. */
  popover: 100,
  /** Top-bar dropdown sheets (Connections, usage, activity). */
  sheet: 120,
  /** The CTO voice-call HUD; above sheets so End call is always reachable. */
  hud: 130,
  /** Floating top-center banners. */
  floatingBanner: 140,
  /** Modal dialogs and their scrim. */
  dialog: 200,
  /** A confirm/prompt raised from inside another dialog. */
  nestedDialog: 210,
  /** Bottom-right toast viewport; above dialogs so a dialog's own result toast shows. */
  toast: 250,
  /** Tooltips and hover cards; above dialogs so a dialog's tooltips work. */
  tooltip: 300,
  /** A right-click / row context menu and its click-away layer, above every app surface. */
  contextMenu: 9999,
  /** The global capture gesture notice: above everything, including context menus. */
  capture: 2147483000,
} as const;

export type ZLayer = keyof typeof Z_LAYERS;
