import type { SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectGroup } from "@agentclientprotocol/sdk";
import type { AgentChatCursorConfigOption } from "../../../shared/types";

type SessionConfigSelectOptionState = Extract<SessionConfigOption, { type: "select" }>;

export type CursorAcpConfigSnapshot = {
  modeConfigId: string | null;
  currentModeId: string | null;
  availableModeIds: string[];
  modelConfigId: string | null;
  currentModelId: string | null;
  availableModelIds: string[];
  configOptions: AgentChatCursorConfigOption[];
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function optionLooksLikeCategory(option: SessionConfigOption, category: "mode" | "model"): boolean {
  if (option.category === category) return true;
  const id = normalizeText(option.id).toLowerCase();
  const name = normalizeText(option.name).toLowerCase();
  if (category === "mode") {
    return /\bmode\b/.test(id) || /\bmode\b/.test(name);
  }
  return /\bmodels?\b/.test(id) || /\bmodels?\b/.test(name);
}

function listSelectOptionValues(
  option: SessionConfigSelectOptionState | null | undefined,
): string[] {
  if (!option || option.type !== "select") return [];
  const out: string[] = [];
  const append = (entry: SessionConfigSelectOption) => {
    const value = normalizeText(entry.value);
    if (value.length) out.push(value);
  };
  for (const entry of option.options) {
    if (!entry) continue;
    if (Array.isArray((entry as SessionConfigSelectGroup).options)) {
      for (const nested of (entry as SessionConfigSelectGroup).options) {
        append(nested);
      }
      continue;
    }
    append(entry as SessionConfigSelectOption);
  }
  return out;
}

function normalizeSelectCurrentValue(
  option: SessionConfigSelectOptionState | null | undefined,
): string | null {
  if (!option || option.type !== "select") return null;
  const currentValue = normalizeText(option.currentValue);
  if (!currentValue.length) return null;
  const allowedValues = listSelectOptionValues(option);
  if (allowedValues.length === 0) return currentValue;
  return allowedValues.includes(currentValue) ? currentValue : null;
}

function normalizeOptionCategory(option: SessionConfigOption): string | null {
  const category = normalizeText(option.category);
  return category.length ? category : null;
}

function normalizeConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined,
): AgentChatCursorConfigOption[] {
  if (!configOptions?.length) return [];
  const normalized: AgentChatCursorConfigOption[] = [];

  for (const option of configOptions) {
    const id = normalizeText(option.id);
    const name = normalizeText(option.name);
    if (!id.length || !name.length) continue;

    const description = normalizeText(option.description);
    const category = normalizeOptionCategory(option);

    if (option.type === "boolean") {
      normalized.push({
        id,
        name,
        ...(description.length ? { description } : {}),
        ...(category ? { category } : {}),
        type: "boolean",
        currentValue: option.currentValue,
      });
      continue;
    }

    if (option.type !== "select") continue;

    const selectOptions = option.options.flatMap((entry) => {
      if (!entry) return [];
      if (Array.isArray((entry as SessionConfigSelectGroup).options)) {
        const group = entry as SessionConfigSelectGroup;
        const groupId = normalizeText(group.group);
        const groupLabel = normalizeText(group.name);
        return group.options.map((nested) => ({
          value: normalizeText(nested.value),
          label: normalizeText(nested.name),
          description: normalizeText(nested.description) || null,
          groupId: groupId || null,
          groupLabel: groupLabel || null,
        }));
      }

      const single = entry as SessionConfigSelectOption;
      return [{
        value: normalizeText(single.value),
        label: normalizeText(single.name),
        description: normalizeText(single.description) || null,
        groupId: null,
        groupLabel: null,
      }];
    }).filter((entry) => entry.value.length > 0 && entry.label.length > 0);

    normalized.push({
      id,
      name,
      ...(description.length ? { description } : {}),
      ...(category ? { category } : {}),
      type: "select",
      currentValue: normalizeSelectCurrentValue(option),
      options: selectOptions,
    });
  }

  return normalized;
}

function findSelectOption(
  configOptions: SessionConfigOption[] | null | undefined,
  category: "mode" | "model",
): SessionConfigSelectOptionState | null {
  if (!configOptions?.length) return null;
  for (const option of configOptions) {
    if (option.type !== "select") continue;
    if (optionLooksLikeCategory(option, category)) {
      return option as SessionConfigSelectOptionState;
    }
  }
  return null;
}

export function readCursorAcpConfigSnapshot(
  configOptions: SessionConfigOption[] | null | undefined,
): CursorAcpConfigSnapshot {
  const modeOption = findSelectOption(configOptions, "mode");
  const modelOption = findSelectOption(configOptions, "model");

  return {
    modeConfigId: modeOption ? normalizeText(modeOption.id) || null : null,
    currentModeId: normalizeSelectCurrentValue(modeOption),
    availableModeIds: listSelectOptionValues(modeOption),
    modelConfigId: modelOption ? normalizeText(modelOption.id) || null : null,
    currentModelId: normalizeSelectCurrentValue(modelOption),
    availableModelIds: listSelectOptionValues(modelOption),
    configOptions: normalizeConfigOptions(configOptions),
  };
}
