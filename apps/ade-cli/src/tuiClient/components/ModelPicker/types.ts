export type SettingKind =
  | "provider"
  | "model"
  | "reasoning"
  | "thinkingBudget"
  | "verbosity"
  | "apply";

export interface SettingDescriptor {
  kind: SettingKind;
  label: string;
  value: string;
  hint?: string;
  active?: boolean;
}
