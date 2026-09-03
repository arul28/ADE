/**
 * `@ade-dev/ui` — ADE's design-system primitives for plugin pages.
 *
 * The desktop app consumes the same modules through `file:../../packages/ui`
 * and re-export shims at the old paths, so a plugin page and the app it runs
 * inside cannot drift.
 *
 * This barrel deliberately does NOT re-export the icon set or the markdown
 * stack. Both are large graphs that most callers never draw, and pulling them
 * in here made one design-token import cost the web client several megabytes.
 * They have their own entry points instead:
 *
 *   import { COLORS, SPACING } from "@ade-dev/ui/tokens";     // no React at all
 *   import { applyAdeTheme } from "@ade-dev/ui/theme";
 *   import { BranchIcon } from "@ade-dev/ui/icons";           // pulls phosphor
 *   import { Markdown } from "@ade-dev/ui/markdown";          // pulls remark/rehype
 *
 * Import the narrowest path that covers what you need.
 */

export {
  ADE_TOKENS,
  APP_FONT_STACK,
  COLORS,
  FONT_SIZES,
  LABEL_STYLE,
  MONO_FONT,
  RADII,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  SPACING,
  adeVar,
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
  tokens,
} from "./tokens";
export { CARD_STYLE, INPUT_CLS, INPUT_STYLE } from "./primitives/inputStyles";
export type { AdeColorScheme, AdeTheme, AdeToken } from "./tokens";

export {
  ADE_STYLE_ID,
  AdeStyles,
  adeCss,
  applyAdeTheme,
  createTheme,
  darkTheme,
  injectAdeStyles,
  lightTheme,
  themeForScheme,
  themeToCss,
} from "./theme/index";

export { cn } from "./primitives/cn";
export { Button } from "./primitives/Button";
export { Chip } from "./primitives/Chip";
export { EmptyState } from "./primitives/EmptyState";
export { PaneHeader } from "./primitives/PaneHeader";
export {
  ConsentToggleSection,
  SettingsSectionShell,
  SettingsToggle,
  settingsSectionDescriptionStyle,
  settingsSectionTitleStyle,
} from "./primitives/SettingsSectionShell";

export {
  LINEAR_BRAND,
  LINEAR_LOGO_PATH,
  LinearMark,
  LinearPriorityIcon,
  LinearStateIcon,
} from "./linear/linearBrand";
export { LinearProjectIcon, resolveLinearProjectIcon } from "./linear/linearProjectIcon";
export {
  branchExistsForLinearIssue,
  formatRelativeTime,
  issueProjectLabel,
  issueUpdatedLabel,
  linearPriorityLabel,
} from "./linear/linearIssueDisplay";
export type {
  LinearBranchOption,
  LinearIssuePriorityFields,
  LinearIssueProjectFields,
  LinearIssueUpdatedFields,
} from "./linear/linearIssueDisplay";
