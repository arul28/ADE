import type {
  ProviderInstance,
  ProviderInstanceCreateResult,
  ProviderInstanceRemoveResult,
  ProviderInstanceSettings,
  ProviderLoginStatus,
} from "../../../shared/types/providerInstances";
import type { AdeNamespace, MiscCall } from "./types";

/**
 * The host's provider accounts, for the Accounts panel in the hosted web client.
 *
 * Each member forwards to the host's `providerAccounts.*` command, which runs
 * the same `provider_instances` action the desktop calls, and unwraps the
 * action's `{ instance }` / `{ login }` envelope into what the desktop bridge
 * returns. A host older than these commands rejects, and the panel shows its
 * error instead of an empty list that looks like "no accounts".
 *
 * `loginCommand` stays absent: it hands back a shell command to run on the
 * host, which a browser cannot do. The panel signs in with `loginStart`.
 * `setAccent` stays absent too: no account screen offers a colour any more.
 */
export function createProviderAccountsNamespace(call: MiscCall): AdeNamespace<"providerInstances"> {
  const unavailable = (): never => {
    throw new Error("This ADE host cannot manage provider accounts remotely yet. Update ADE on the host.");
  };
  // A read may be answered from the last good reply while the host is away.
  const cached = <T>(method: string, args: unknown): Promise<T> =>
    call<T>(`providerAccounts.${method}`, args ?? {}, unavailable);
  // A change, or a running sign-in's status, goes to the host every time.
  const live = <T>(method: string, args: unknown): Promise<T> =>
    call<T>(`providerAccounts.${method}`, args ?? {}, unavailable, false);
  const instance = (result: { instance: ProviderInstance }): ProviderInstance => result.instance;
  const login = (result: { login: ProviderLoginStatus }): ProviderLoginStatus => result.login;

  return {
    list: async (args) => (await cached<{ instances: ProviderInstance[] }>("list", args)).instances,
    create: (args) => live<ProviderInstanceCreateResult>("create", args),
    remove: (args) => live<ProviderInstanceRemoveResult>("remove", args),
    rename: async (args) => instance(await live("rename", args)),
    setDefault: async (args) => instance(await live("setDefault", args)),
    dismissReplaced: async (args) => instance(await live("dismissReplaced", args)),
    loginStart: async (args) => login(await live("loginStart", args)),
    loginStatus: async (args) => login(await live("loginStatus", args)),
    loginSubmitCode: async (args) => login(await live("loginSubmitCode", args)),
    loginCancel: async (args) => login(await live("loginCancel", args)),
    getSettings: async (args) => (await cached<{ settings: ProviderInstanceSettings }>("getSettings", args)).settings,
    setSettings: async (args) => (await live<{ settings: ProviderInstanceSettings }>("setSettings", args)).settings,
    refresh: async (args) => (await live<{ instances: ProviderInstance[] }>("refresh", args)).instances,
  } as AdeNamespace<"providerInstances">;
}
