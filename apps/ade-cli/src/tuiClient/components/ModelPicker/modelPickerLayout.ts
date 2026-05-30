import type { SettingDescriptor } from "./types";

export interface ModelRowLayout {
  id: string;
  label: string;
  description: string;
  badge?: string;
  selected: boolean;
  available: boolean;
}

export interface SettingsRowLayout {
  settings: SettingDescriptor[];
  selectedIndex: number;
}

export interface ModelPickerLayout {
  rows: ModelRowLayout[];
  settings: SettingsRowLayout;
  showSettings: boolean;
}

const FALLBACK_DESCRIPTION = "Adaptive reasoning";

export interface ModelPickerComputeInput {
  models: Array<{
    id: string;
    label?: string;
    description?: string;
    badge?: string;
    provider?: string;
    available?: boolean;
    recommended?: boolean;
  }>;
  selectedId?: string;
  query?: string;
  settings: SettingDescriptor[];
  settingsSelectedIndex: number;
  showSettings: boolean;
}

export function computeModelPickerLayout(
  input: ModelPickerComputeInput,
): ModelPickerLayout {
  const query = (input.query ?? "").trim().toLowerCase();
  const rows: ModelRowLayout[] = input.models
    .filter((m) => {
      if (!query) return true;
      const haystack =
        `${m.label ?? m.id} ${m.description ?? ""} ${m.provider ?? ""}`.toLowerCase();
      return haystack.includes(query);
    })
    .map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      description: m.description ?? FALLBACK_DESCRIPTION,
      badge: m.badge,
      selected: m.id === input.selectedId,
      available: m.available !== false,
    }));

  return {
    rows,
    settings: {
      settings: input.settings,
      selectedIndex: input.settingsSelectedIndex,
    },
    showSettings: input.showSettings,
  };
}
