import type { ProviderLoginStatus } from "../../../shared/types/providerLogins";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";
import type { AdapterInfra } from "./types";

type ProviderLoginsBridge = NonNullable<Window["ade"]["providerLogins"]>;

const DESKTOP_ONLY = "Do this in the ADE desktop app on that computer: only that computer's own ADE can read its Keychain or its GitHub CLI login.";

/**
 * `window.ade.providerLogins` for the web app: the account's sign-ins for
 * Settings › Providers (the account cards, ADE Cloud as a place) and the
 * ADE Cloud page's sign-ins card.
 *
 * Every member goes to the connected machine's `providerLogins.*` commands,
 * the same `provider_logins` service the desktop reaches through its pin. The
 * account part is the same from any of the person's brains, so the connected
 * machine answers for it. A pin naming another machine (the reporting cloud
 * computer of the ADE Cloud place) is refused by the pin guard, so that part
 * reads "no answer" instead of being served by the wrong machine.
 *
 * The writes are the person's own, so they ask the host every time and never
 * resolve a fallback. The two that only that computer's own desktop may run
 * (`allowKeychain`, `allowGitHubCli`) refuse with a plain sentence. There is no
 * push event for a change here, so `onChanged` fires when this tab's
 * connection comes back, and each write returns the new status itself.
 */
export function createWebProviderLoginsNamespace(infra: Pick<AdapterInfra, "client" | "commands" | "state">): ProviderLoginsBridge {
  const { client, commands } = infra;

  const read = async (method: "status", args: unknown, pin: RuntimePinArg): Promise<ProviderLoginStatus> => {
    assertWebRuntimePinRoutable(`providerLogins.${method}`, pin, infra);
    return await commands.call<ProviderLoginStatus>(`providerLogins.${method}`, args ?? {}, {
      fallback: () => {
        throw new Error("Update ADE on that computer to see your sign-ins here.");
      },
      authoritative: true,
      retainLastRead: false,
    });
  };

  const write = async (method: string, args: unknown, pin: RuntimePinArg): Promise<ProviderLoginStatus> => {
    assertWebRuntimePinRoutable(`providerLogins.${method}`, pin, infra);
    return await commands.call<ProviderLoginStatus>(`providerLogins.${method}`, args ?? {}, { idempotent: false });
  };

  const refused = async (): Promise<ProviderLoginStatus> => {
    throw new Error(DESKTOP_ONLY);
  };

  return {
    status: (args, pin) => read("status", args, pin),
    captureNow: (args, pin) => write("captureNow", args, pin),
    allowKeychain: refused,
    allowGitHubCli: refused,
    use: (args, pin) => write("use", args, pin),
    setCloud: (args, pin) => write("setCloud", args, pin),
    setCloudAll: (args, pin) => write("setCloudAll", args, pin),
    setCloudBalance: (args, pin) => write("setCloudBalance", args, pin),
    remove: (args, pin) => write("remove", args, pin),
    onChanged: (cb) => {
      let readiness = client.getStatus().readiness;
      return client.subscribe((status) => {
        if (status.readiness === readiness) return;
        readiness = status.readiness;
        if (status.readiness === "ready") cb();
      });
    },
  };
}
