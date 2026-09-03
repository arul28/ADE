/**
 * Moved to `@ade-dev/ui`.
 *
 * Every colour now resolves as `var(--ade-x, var(--color-x))`. Inside the app
 * nothing defines `--ade-*`, so each token collapses to the exact `--color-*`
 * reference this module has always emitted and `index.css` still owns the
 * palette. A plugin page has no `index.css`, so it sets `--ade-*` instead.
 */
export {
  APP_FONT_STACK,
  COLORS,
  FONT_SIZES,
  LABEL_STYLE,
  MONO_FONT,
  RADII,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  SPACING,
  cardStyle,
  dangerButton,
  floatingPane,
  formatTimestamp,
  healthColor,
  inlineBadge,
  laneRailTint,
  laneSurfaceTint,
  outlineButton,
  primaryButton,
  recessedStyle,
} from "@ade-dev/ui";
