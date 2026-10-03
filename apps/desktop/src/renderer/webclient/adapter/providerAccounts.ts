import type {
  ProviderInstance,
  ProviderInstanceCreateResult,
  ProviderInstanceRemoveResult,
  ProviderInstanceSettings,
  ProviderLoginStatus,
} from "../../../shared/types/providerInstances";
import type { AdeNamespace } from "./types";

type Call = <T>(
  action: string,
  args: unknown,
  fallback: T | (() => T | Promise<T>),
  idempotent?: boolean,
) => Promise<T>;

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
 */
export function createProviderAccountsNamespace(call: Call): AdeNamespace<"providerInstances"> {
  const unavailable = (): never => {
    throw new Error("This ADE host cannot manage provider accounts remotely yet. Update ADE on the host.");
  };
  const read = <T>(method: string, args: unknown): Promise<T> =>
    call<T>(`providerAccounts.${method}`, args ?? {}, unavailable);
  // A change goes to the host every time: never replayed from a cached answer.
  const write = <T>(method: string, args: unknown): Promise<T> =>
    call<T>(`providerAccounts.${method}`, args ?? {}, unavailable, false);
  const instance = (result: { instance: ProviderInstance }): ProviderInstance => result.instance;
  const login = (result: { login: ProviderLoginStatus }): ProviderLoginStatus => result.login;

  return {
    list: async (args) => (await read<{ instances: ProviderInstance[] }>("list", args)).instances,
    create: (args) => write<ProviderInstanceCreateResult>("create", args),
    remove: (args) => write<ProviderInstanceRemoveResult>("remove", args),
    rename: async (args) => instance(await write("rename", args)),
    setDefault: async (args) => instance(await write("setDefault", args)),
    setAccent: async (args) => instance(await write("setAccent", args)),
    dismissReplaced: async (args) => instance(await write("dismissReplaced", args)),
    loginStart: async (args) => login(await write("loginStart", args)),
    // A poll must see the live state, not a cached one.
    loginStatus: async (args) => login(await write("loginStatus", args)),
    loginSubmitCode: async (args) => login(await write("loginSubmitCode", args)),
    loginCancel: async (args) => login(await write("loginCancel", args)),
    getSettings: async (args) => (await read<{ settings: ProviderInstanceSettings }>("getSettings", args)).settings,
    setSettings: async (args) => (await write<{ settings: ProviderInstanceSettings }>("setSettings", args)).settings,
    refresh: async (args) => (await write<{ instances: ProviderInstance[] }>("refresh", args)).instances,
  } as AdeNamespace<"providerInstances">;
}
