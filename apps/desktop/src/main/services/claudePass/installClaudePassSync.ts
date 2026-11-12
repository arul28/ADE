/**
 * Starts the brain's Claude pass reconcile (claudePassSync.ts) on the sign-in
 * sync's hooks (providerLoginHooks.ts): the end of each sync pass, the gate
 * before a Claude turn, and a part of `provider_logins.status`; and the end
 * of a pass that a chat reports (claudePassEnd.ts). No timer of its own. `ade serve` calls it next to the sign-in sync's installer.
 *
 * With `staticOff` (an embedded runtime, a development build, sync off) it
 * does nothing: a cloud computer then keeps today's boot token in its env.
 */

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  debug: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
};

export async function installClaudePassSync(args: {
  staticOff: string | null;
  adeDir: string;
  logger: Logger;
}): Promise<void> {
  if (args.staticOff) return;
  const [
    hooks,
    { createClaudePassSync },
    { getMachineAccountStores },
    { getMachineProviderInstanceStore },
    { isAdeCloudComputer },
    { noteProviderLoginChanged },
    { configureClaudePassUse },
    { setClaudePassEndHandler },
  ] = await Promise.all([
    import("../providerLogins/providerLoginHooks"),
    import("./claudePassSync"),
    import("../../../../../ade-cli/src/services/account/machineAccountStores"),
    import("../../../../../ade-cli/src/services/providerInstances/providerInstanceStore"),
    import("../adeCloud/cloudComputerRules"),
    import("../ai/providerLoginChanged"),
    import("./claudePassUse"),
    import("./claudePassEnd"),
  ]);
  // Last use of each pass, from the file the brain wrote before (keys and numbers only).
  configureClaudePassUse({ adeDir: args.adeDir });
  const stores = getMachineAccountStores(args.logger);
  const sync = createClaudePassSync({
    cloudComputer: isAdeCloudComputer(),
    adeDir: args.adeDir,
    vault: () => stores.vault,
    settings: () => stores.settings,
    store: () => getMachineProviderInstanceStore(),
    accountUserId: stores.accountUserId,
    restart: (provider, options) => hooks.restartProviderRuntimesWhenIdle(provider, options),
    noteChanged: (provider) => {
      noteProviderLoginChanged(provider);
      // Open windows read `claudePasses` again (an added, removed or ended pass).
      hooks.notifyProviderLoginsChanged();
    },
    logger: args.logger,
  });
  const run = (label: string, work: () => unknown): void => {
    try {
      work();
    } catch (error) {
      args.logger.warn("claude_pass.reconcile_failed", { at: label, reason: error instanceof Error ? error.name : "unknown" });
    }
  };
  hooks.onProviderLoginPass((info) => run("pass", () => sync.reconcile({ accountUserId: info.accountUserId })));
  // Claude refused a pass as no longer valid (a chat's auth failure): one end mark.
  setClaudePassEndHandler((instanceId) => run("end", () => sync.endPass(instanceId)));
  // Local reads and at most one small file write: no time limit is needed.
  hooks.registerProviderLoginGate("claude", async () => run("gate", () => sync.reconcileForTurn()));
  hooks.registerProviderLoginStatusPart(({ provider }) => {
    if (provider && provider !== "claude") return {};
    const entries = sync.statusEntries();
    return entries ? { claudePasses: entries } : {};
  });
}
