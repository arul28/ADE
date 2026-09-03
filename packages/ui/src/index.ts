/**
 * `@ade-dev/ui` — ADE's design-system primitives for plugin pages.
 *
 * The desktop app consumes the same modules through `file:../../packages/ui`
 * and re-export shims at the old paths, so a plugin page and the app it runs
 * inside cannot drift.
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
export type { AdeColorScheme, AdeTheme, AdeToken } from "./tokens";

export {
  applyAdeTheme,
  createTheme,
  darkTheme,
  lightTheme,
  themeForScheme,
  themeToCss,
} from "./theme/createTheme";
export { ADE_STYLE_ID, adeCss, injectAdeStyles } from "./theme/styles";
export { AdeStyles } from "./theme/AdeStyles";

export { cn } from "./primitives/cn";
export { Button } from "./primitives/Button";
export { Chip } from "./primitives/Chip";
export { EmptyState } from "./primitives/EmptyState";
export { PaneHeader } from "./primitives/PaneHeader";
export { BranchIcon, LaneIcon } from "./primitives/vcsIcons";
export { CARD_STYLE, INPUT_CLS, INPUT_STYLE } from "./primitives/inputStyles";
export {
  ConsentToggleSection,
  SettingsSectionShell,
  SettingsToggle,
  settingsSectionDescriptionStyle,
  settingsSectionTitleStyle,
} from "./primitives/SettingsSectionShell";
export {
  Markdown,
  SAFE_PREVIEW_SCHEMA,
  buildMarkdownComponents,
  isWindowsAbsolutePath,
  markdownUrlTransform,
} from "./primitives/Markdown";
export type { MarkdownProps } from "./primitives/Markdown";

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
