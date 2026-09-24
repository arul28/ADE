/**
 * The app's stacking scale. Pick a named layer instead of inventing a z-index:
 * a new overlay that guesses a number either hides under something it should
 * cover or covers something that must stay on top (a dialog, the capture HUD).
 *
 * Ordered low to high. Values match what the existing surfaces already used, so
 * adopting a name never changes what renders above what.
 */
export const Z_LAYERS = {
  /** Bottom-right toast viewport inside the main content area. */
  toast: 95,
  /** Top-bar dropdown sheets (Connections, usage, activity). */
  sheet: 120,
  /** Floating top-center banners. */
  floatingBanner: 140,
  /** Modal dialogs and their scrim. */
  dialog: 200,
  /** A confirm/prompt raised from inside another dialog. */
  nestedDialog: 210,
  /** Tooltips and hover cards; above dialogs so a dialog's tooltips work. */
  tooltip: 300,
} as const;

export type ZLayer = keyof typeof Z_LAYERS;
