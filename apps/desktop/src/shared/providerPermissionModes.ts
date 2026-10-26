import { modelPermissionOptions, nativePermissionToCliMode } from "./modelPermissions";
import { AGENT_CHAT_PERMISSION_MODE_VALUES, type AgentChatPermissionMode } from "./types/chat";

/**
 * The generic permission words (`AgentChatPermissionMode`) a provider honours:
 * its own native modes from the composer's table, mapped back to ADE's generic
 * vocabulary. The table lets an unnamed provider speak OpenCode, but
 * `config-toml` reads a config file only Codex and OpenCode have, and the launch
 * refuses it elsewhere (`validateLaunchProfilePermissionMode` in cliLaunch.ts).
 */
export function providerPermissionModes(provider: string): readonly AgentChatPermissionMode[] {
  const modes = new Set<string>();
  for (const option of modelPermissionOptions(provider)) {
    const mode = nativePermissionToCliMode(provider, option.value);
    if (mode) modes.add(mode);
  }
  if (provider !== "codex" && provider !== "opencode") modes.delete("config-toml");
  return AGENT_CHAT_PERMISSION_MODE_VALUES.filter((mode) => modes.has(mode));
}
