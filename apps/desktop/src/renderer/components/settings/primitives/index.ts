/**
 * The settings primitive set. Every settings surface builds from these — see
 * `settingsManifest.ts` for how a setting becomes navigable and searchable.
 */
export { ScopeChip } from "./ScopeChip";
export { SettingsCard, SettingsGroup, SavedFlash, useSavedFlash } from "./SettingsCard";
export {
  SettingsToggle,
  SettingsSegmented,
  SettingsNumber,
  SettingsSelect,
  SettingsSlider,
  type SegmentedOption,
} from "./SettingsControls";

// The section shell (icon + title + description header) predates this
// directory and is still the right wrapper for integration-style sections.
export {
  SettingsSectionShell,
  settingsSectionTitleStyle,
  settingsSectionDescriptionStyle,
} from "../settingsSectionUi";
