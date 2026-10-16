import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import type { ProviderInstance, ProviderInstanceProvider } from "../../../shared/types/providerInstances";
import { recheckSignedOutLogins } from "../usage/usageTrackingService";

/**
 * Re-read this machine's provider accounts: the saved logins first (a broken
 * login may have been fixed outside ADE), then each config home's identity.
 * The local IPC handler and the `provider_instances` action both call this.
 *
 * The quota rows and smart balance keep a signed-out reading until the next
 * poll, so a restored login asks for a poll now. So does a refresh that names
 * one account: a sign-in that just finished should not wait for an idle poll.
 */
export async function refreshProviderAccounts(
  args: { provider?: ProviderInstanceProvider; instanceId?: string },
  usage: { forceRefresh: () => Promise<unknown> } | null | undefined,
): Promise<ProviderInstance[]> {
  const restored = await recheckSignedOutLogins(args).catch(() => []);
  if (restored.length > 0 || args.instanceId) void usage?.forceRefresh().catch(() => undefined);
  return getMachineProviderInstanceStore().refreshAccounts(args.provider);
}
