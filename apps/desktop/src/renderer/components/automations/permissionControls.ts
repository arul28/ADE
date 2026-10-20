import { cursorPermissionFromMisfiledOpenCode } from "../../../shared/cursorModes";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import type { AgentChatPermissionMode, AutomationRuleDraft } from "../../../shared/types";
import { familyToPermissionKey, getPermissionOptions } from "../shared/permissionOptions";
import type { PermissionModePickerOption } from "../shared/PermissionModePicker";
import { genericPermissionPickerOptions } from "../../lib/modelPermissionOptions";

type AutomationPermissionConfig = NonNullable<AutomationRuleDraft["permissionConfig"]>;

export function permissionControlsForModel(modelId: string) {
  const descriptor = resolveModelDescriptor(modelId);
  if (!descriptor) return null;
  const key = familyToPermissionKey(descriptor.family, descriptor.isCliWrapped);
  return {
    key,
    // A model that is not CLI-wrapped gets ADE's API option list, whose words
    // are not its provider's native modes; they wear the generic tones.
    presentationProvider: descriptor.isCliWrapped ? key : null,
    options: getPermissionOptions({
      family: descriptor.family,
      isCliWrapped: descriptor.isCliWrapped,
    }),
  };
}

/**
 * The permission menu's rows for an automation form: "Rule default" (no
 * override, stored as an empty value) and then the model's modes, wearing the
 * composer's tones. `ruleDefaultDetail` says what the empty value falls back to.
 */
export function permissionPickerOptionsForModel(
  meta: ReturnType<typeof permissionControlsForModel>,
  ruleDefaultDetail: string,
): Array<PermissionModePickerOption<string>> {
  return [
    { value: "", label: "Rule default", detail: ruleDefaultDetail, tone: "slate", icon: "config" },
    ...(meta ? genericPermissionPickerOptions<string>(meta.presentationProvider, meta.options) : []),
  ];
}

function codexSandboxForMode(mode: AgentChatPermissionMode) {
  if (mode === "full-auto") return "danger-full-access";
  if (mode === "plan") return "read-only";
  return "workspace-write";
}

/** The mode the picker should show. Cursor SDK saves used to land on `opencode`. */
export function selectedPermissionMode(
  permissionConfig: AutomationPermissionConfig | undefined,
  modelId: string,
): string {
  const meta = permissionControlsForModel(modelId);
  if (!meta) return "";
  const providers = permissionConfig?.providers;
  const stored = providers ? (providers as Record<string, unknown>)[meta.key] : undefined;
  const direct = typeof stored === "string" ? stored : "";
  // "inherit" is an explicit Rule default. It must not fall through to a legacy OpenCode value.
  if (direct === "inherit") return "";
  if (direct) return direct;
  if (meta.key !== "cursor") return "";
  return cursorPermissionFromMisfiledOpenCode(providers?.opencode) ?? "";
}

export function patchPermissionConfig(
  permissionConfig: AutomationPermissionConfig | undefined,
  modelId: string,
  rawMode: string,
): AutomationPermissionConfig | undefined {
  const meta = permissionControlsForModel(modelId);
  if (!meta) return permissionConfig;
  const providers: Record<string, unknown> = { ...(permissionConfig?.providers ?? {}) };
  if (!rawMode) {
    const cursorValue = typeof providers.cursor === "string" ? providers.cursor : "";
    const hadExplicitCursor = meta.key === "cursor" && cursorValue.length > 0 && cursorValue !== "inherit";
    const legacyCursor = meta.key === "cursor" && !hadExplicitCursor
      ? cursorPermissionFromMisfiledOpenCode(typeof providers.opencode === "string" ? providers.opencode : null)
      : null;
    if (hadExplicitCursor) providers.cursor = "inherit";
    else delete providers[meta.key];
    if (meta.key === "codex") delete providers.codexSandbox;
    if (legacyCursor) delete providers.opencode;
    return { ...(permissionConfig ?? {}), providers: providers as AutomationPermissionConfig["providers"] };
  }
  const mode = rawMode as AgentChatPermissionMode;
  return {
    ...(permissionConfig ?? {}),
    providers: {
      ...(providers as AutomationPermissionConfig["providers"]),
      [meta.key]: mode,
      ...(meta.key === "codex" && mode !== "config-toml" ? { codexSandbox: codexSandboxForMode(mode) } : {}),
    },
  };
}
