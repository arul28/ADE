import type { AiSettingsStatus } from "../../../../shared/types";
import type { SettingsProviderId } from "./types";

/**
 * When Settings › Agents & Models calls a provider connected, read from the
 * status payload alone (no check in flight, no key verification): Claude by
 * its SDK binary and sign-in, OpenCode by its binary and catalog, Muse by its
 * runtime and sign-in, everyone else by their connection row's
 * `runtimeAvailable`.
 *
 * The provider descriptors (`descriptors.tsx`, `acpProviders.tsx`) and the
 * first-run "Connect your agents" card (`firstRunAgentModel.ts`) both read it,
 * so the two never disagree. Type-only imports: the launch path reads it
 * without loading the Settings page.
 */
export function providerStatusConnected(id: SettingsProviderId, status: AiSettingsStatus | null | undefined): boolean {
  if (!status) return false;
  switch (id) {
    case "claude": {
      const claude = status.availableProviders?.claude;
      return Boolean(claude?.binary.present && claude.auth.ready);
    }
    case "opencode":
      return status.opencodeBinaryInstalled !== false && !status.opencodeInventoryError;
    case "muse": {
      const muse = status.providerConnections?.muse;
      return Boolean(muse?.runtimeAvailable && muse.authAvailable);
    }
    default:
      return status.providerConnections?.[id]?.runtimeAvailable === true;
  }
}

/**
 * The model picker's own "can run here" flag. Claude reports an availability
 * record instead, and OpenCode and Pi have no flag at all.
 */
export function providerOffersModels(id: SettingsProviderId, status: AiSettingsStatus | null | undefined): boolean {
  if (!status || id === "claude" || id === "opencode" || id === "pi") return false;
  return status.availableProviders?.[id] === true;
}
