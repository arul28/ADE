import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import type { AgentChatPermissionMode, AutomationRuleDraft } from "../../../shared/types";
import { familyToPermissionKey, getPermissionOptions } from "../shared/permissionOptions";

type AutomationPermissionConfig = NonNullable<AutomationRuleDraft["permissionConfig"]>;

export function permissionControlsForModel(modelId: string) {
  const descriptor = resolveModelDescriptor(modelId);
  if (!descriptor) return null;
  const key = familyToPermissionKey(descriptor.family, descriptor.isCliWrapped);
  return {
    key,
    options: getPermissionOptions({
      family: descriptor.family,
      isCliWrapped: descriptor.isCliWrapped,
    }),
  };
}

function codexSandboxForMode(mode: AgentChatPermissionMode) {
  if (mode === "full-auto") return "danger-full-access";
  if (mode === "plan") return "read-only";
  return "workspace-write";
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
    delete providers[meta.key];
    if (meta.key === "codex") delete providers.codexSandbox;
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
