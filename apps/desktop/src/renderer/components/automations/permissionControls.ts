import { cursorPermissionFromMisfiledOpenCode } from "../../../shared/cursorModes";
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
