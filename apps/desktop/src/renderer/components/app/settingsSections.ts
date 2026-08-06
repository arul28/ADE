import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Brain, ChartLineUp, FolderSimple, GearSix, HardDrives, Key, Palette, Stack } from "@phosphor-icons/react";

type SettingsSectionDefinition = {
  id: string;
  label: string;
  icon: PhosphorIcon;
  localOnly?: boolean;
};

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: GearSix },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "workspace", label: "Workspace", icon: FolderSimple },
  { id: "ai", label: "AI", icon: Brain },
  { id: "secrets", label: "Secrets", icon: Key },
  { id: "lane-templates", label: "Lane Templates", icon: Stack },
  { id: "storage", label: "Storage", icon: HardDrives },
  { id: "ade-usage", label: "ADE Stats", icon: ChartLineUp },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SectionId = SettingsSection["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

export function getVisibleSettingsSections(showLocalOnlySections: boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) => showLocalOnlySections || !("localOnly" in section && section.localOnly),
  );
}
