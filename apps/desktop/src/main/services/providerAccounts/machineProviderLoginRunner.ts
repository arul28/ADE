import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { recheckSignedOutLogins } from "../usage/usageTrackingService";
import { createProviderLoginRunner, type ProviderLoginRunner } from "./providerLoginRunner";

let runner: ProviderLoginRunner | null = null;

/**
 * The one login runner for this machine's provider accounts, shared by the
 * local IPC handlers and the `provider_instances` actions a pinned Settings
 * page calls, so a sign-in started through one is readable through the other.
 */
export function getMachineProviderLoginRunner(): ProviderLoginRunner {
  if (runner) return runner;
  runner = createProviderLoginRunner({
    getInstance: (id) => getMachineProviderInstanceStore().get(id),
    loginCommand: (id) => getMachineProviderInstanceStore().loginCommand(id),
    verify: async (instance) => {
      const store = getMachineProviderInstanceStore();
      // Read the saved login now (it may carry a stale signed-out mark), then
      // the config home's identity, which is what `signedIn` is built from.
      await recheckSignedOutLogins({ provider: instance.provider, instanceId: instance.id }).catch(() => []);
      await store.refreshAccounts(instance.provider);
      return store.get(instance.id);
    },
  });
  // A sign-in still open when the process ends would leave its CLI running.
  // The desktop app and the headless runtime both exit through here.
  const created = runner;
  process.once("exit", () => created.disposeAll());
  return runner;
}
