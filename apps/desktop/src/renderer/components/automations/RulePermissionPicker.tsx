import { PermissionModePicker, type PermissionModePickerOption } from "../shared/PermissionModePicker";
import { toPermissionPickerOption } from "../shared/permissionModePickerOptions";
import { patchPermissionConfig, permissionControlsForModel, selectedPermissionMode } from "./permissionControls";

type AutomationPermissionConfig = Parameters<typeof patchPermissionConfig>[0];

/** The empty value: the step keeps whatever its automation rule says. */
const RULE_DEFAULT_OPTION: PermissionModePickerOption = {
  value: "",
  label: "Rule default",
  detail: "Use the permission set on the automation rule.",
  tone: "slate",
  icon: "config",
};

/**
 * Permission choice for an automation step or agent rule: the app's shared
 * permission pill, with "Rule default" ahead of the model's modes.
 */
export function RulePermissionPicker({
  modelId,
  permissionConfig,
  onChange,
  disabled = false,
}: {
  modelId: string;
  permissionConfig: AutomationPermissionConfig | undefined;
  onChange: (next: AutomationPermissionConfig | undefined) => void;
  disabled?: boolean;
}) {
  const meta = permissionControlsForModel(modelId);
  const options: PermissionModePickerOption[] = [
    RULE_DEFAULT_OPTION,
    ...(meta?.options ?? []).map(toPermissionPickerOption),
  ];
  return (
    <PermissionModePicker
      ariaLabel="Permissions"
      selectedValue={meta ? selectedPermissionMode(permissionConfig, modelId) : ""}
      options={options}
      disabled={disabled || !meta}
      onSelect={(value) => onChange(patchPermissionConfig(permissionConfig, modelId, value))}
    />
  );
}
