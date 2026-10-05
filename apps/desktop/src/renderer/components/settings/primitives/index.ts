/**
 * The settings primitive set. Every settings surface builds from these — see
 * `settingsManifest.ts` for how a setting becomes navigable and searchable.
 */
export { SettingsCard, SettingsGroup, SavedFlash, useSavedFlash } from "./SettingsCard";
export { SettingsDisclosure } from "./SettingsDisclosure";
export { SettingsSectionRail, type SettingsRailEntry } from "./SettingsSectionRail";
export {
  SettingsColumn,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSectionAction,
  SettingsSplit,
  SETTINGS_TONES,
  type SettingsTone,
} from "./SettingsRows";

// The other two page templates. A settings page is a preference page (cards in
// groups, above), a manager page (toolbar + table), or a dashboard (read-only)
// — and nothing else, so no section file draws its own layout again.
export {
  SettingsManagerPage,
  SettingsManagerTable,
  SettingsManagerRow,
  SettingsManagerEmpty,
  type SettingsManagerColumn,
} from "./SettingsManagerPage";
export { SettingsDashboardPage, SettingsDashboardStat } from "./SettingsDashboardPage";
export {
  SettingsToggle,
  SettingsSegmented,
  SettingsNumber,
  SettingsSelect,
  SettingsSlider,
  SettingsTextField,
  type SegmentedOption,
} from "./SettingsControls";

// The section shell (icon + title + description header) predates this
// directory and is still the right wrapper for integration-style sections.
export {
  SettingsSectionShell,
  settingsSectionTitleStyle,
  settingsSectionDescriptionStyle,
} from "../settingsSectionUi";
