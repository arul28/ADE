import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Brain, Database, DesktopTower, DeviceMobile, FolderSimple, GearSix, Lightning, Palette, Plugs, Stack } from "@phosphor-icons/react";

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
  { id: "sync", label: "Sync", icon: DesktopTower },
  { id: "mobile-push", label: "Mobile Push", icon: DeviceMobile, localOnly: true },
  { id: "integrations", label: "Integrations", icon: Plugs },
  { id: "memory", label: "Memory", icon: Database },
  { id: "lane-templates", label: "Lane Templates", icon: Stack },
  { id: "usage", label: "Usage", icon: Lightning },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SectionId = SettingsSection["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

const TAB_ALIASES: Record<string, SectionId> = {
  project: "workspace",
  context: "workspace",
  providers: "ai",
  devices: "sync",
  "multi-device": "sync",
  github: "integrations",
  linear: "integrations",
  proof: "integrations",
  keybindings: "general",
  onboarding: "general",
  help: "general",
  tours: "general",
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
