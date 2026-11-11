import { acpLoginCommand, acpProviderLabel } from "./acpProviders";
import type { TerminalToolType } from "../../../../shared/types";
import type { AiProviderConnections } from "../../../../shared/types/config";
import { MUSE_LOGIN_COMMAND, PROVIDER_DISPLAY_NAME } from "../../../../shared/providers";
import type { SettingsProviderId } from "./types";

/**
 * The terminal sign-in for a provider: the ACP CLIs' own login commands, and
 * Muse's `muse login`. Muse's runs as a `muse` terminal so the PTY host swaps
 * in that machine's pinned binary (ADE never runs a `muse` from PATH).
 */
export function providerSignIn(id: SettingsProviderId): { command: string; label: string; toolType: TerminalToolType } | null {
  if (id === "muse") return { command: MUSE_LOGIN_COMMAND, label: PROVIDER_DISPLAY_NAME.muse, toolType: "muse" };
  const command = acpLoginCommand(id);
  return command ? { command, label: acpProviderLabel(id) ?? id, toolType: "shell" } : null;
}

/** The connection row a provider's sign-in writes. OpenCode has none of its own; its providers are inside it. */
export function connectionKeyFor(id: SettingsProviderId): keyof AiProviderConnections | null {
  return id === "opencode" ? null : id;
}
