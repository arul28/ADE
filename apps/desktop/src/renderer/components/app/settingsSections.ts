import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Brain, ChartLineUp, FolderSimple, GearSix, Palette, Plugs, Stack } from "@phosphor-icons/react";

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
  { id: "integrations", label: "Integrations", icon: Plugs },
  { id: "lane-templates", label: "Lane Templates", icon: Stack },
  { id: "ade-usage", label: "Stats", icon: ChartLineUp },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SectionId = SettingsSection["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

const TAB_ALIASES: Record<string, SectionId> = {
  project: "workspace",
  context: "workspace",
  providers: "ai",
  sync: "workspace",
  devices: "workspace",
  "multi-device": "workspace",
  github: "integrations",
  linear: "integrations",
  proof: "integrations",
  keybindings: "general",
  onboarding: "general",
  help: "general",
  tours: "general",
  usage: "ade-usage",
  stats: "ade-usage",
};

export function getVisibleSettingsSections(showLocalOnlySections: boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) => showLocalOnlySections || !("localOnly" in section && section.localOnly),
  );
}

export function resolveSettingsSectionFromTab(
  tabParam: string | null,
  showLocalOnlySections: boolean,
): SectionId | null {
  if (!tabParam) return null;

  const visibleSections = getVisibleSettingsSections(showLocalOnlySections);
  const visibleIds = new Set<string>(visibleSections.map((section) => section.id));

  if (visibleIds.has(tabParam)) {
    return tabParam as SectionId;
  }

  const alias = TAB_ALIASES[tabParam];
  if (alias && visibleIds.has(alias)) {
    return alias;
  }

  return null;
}
