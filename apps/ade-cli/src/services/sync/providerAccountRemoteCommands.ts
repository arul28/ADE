import {
  PROVIDER_ACCOUNT_REMOTE_COMMANDS,
  PROVIDER_ACCOUNT_REMOTE_COMMAND_METHODS,
  type ProviderAccountRemoteCommandAction,
  type SyncRemoteCommandPolicy,
} from "../../../../desktop/src/shared/types/sync";

export type ProviderAccountRemoteCommandEntry = {
  action: ProviderAccountRemoteCommandAction;
  policy: SyncRemoteCommandPolicy;
  handler: (payload: Record<string, unknown>) => Promise<unknown>;
};

/**
 * The `providerAccounts.*` commands the phone and the hosted web client call.
 *
 * Each forwards its payload, unchanged, to the method of the same name on the
 * `provider_instances` action domain, so a remote caller and the desktop run
 * one implementation. A method the domain does not provide is a wiring bug and
 * fails here, when the host starts, rather than on a user's first tap.
 */
export function createProviderAccountRemoteCommandHandlers(
  domain: Record<string, unknown>,
): ProviderAccountRemoteCommandEntry[] {
  return PROVIDER_ACCOUNT_REMOTE_COMMAND_METHODS.map((method) => {
    const fn = domain[method];
    if (typeof fn !== "function") {
      throw new Error(`provider_instances has no ${method} method for providerAccounts.${method}.`);
    }
    const policy: SyncRemoteCommandPolicy = PROVIDER_ACCOUNT_REMOTE_COMMANDS[method] === "viewer"
      ? { viewerAllowed: true }
      : { viewerAllowed: false, controllerAllowed: true };
    return {
      action: `providerAccounts.${method}`,
      policy,
      handler: async (payload) => await (fn as (input: unknown) => unknown).call(domain, payload),
    };
  });
}
