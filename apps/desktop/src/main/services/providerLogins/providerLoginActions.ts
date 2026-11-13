/**
 * The `provider_logins` actions: `status` (a read for anyone), `captureNow`
 * (the person's "look now"), `allowKeychain` (the person's one OS keyring read
 * on their desktop, user-only and machine-scoped), `allowGitHubCli` (the person's
 * switch for Copilot's GitHub CLI login on one computer, user-only and
 * machine-scoped; on is for that computer's desktop only), and the person's five writes `use`, `setCloud`,
 * `setCloudAll`, `setCloudBalance` and `remove` (user-only: the desktop app, never the CLI, an
 * agent or an outside app; `actionPolicy.ts`). Each one runs on the brain the
 * call reaches; the writes are account-wide, so any brain of the person's
 * answers the same. None ever returns a token, a key, a file's content or a
 * hash.
 */

import {
  isProviderLoginProvider,
  type ProviderLoginAction,
  type ProviderLoginProvider,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { isRecord } from "../shared/utils";
import { PROVIDER_LOGIN_CARRY } from "./providerLoginCarry";
import { PROVIDER_LOGIN_NOT_THIS_RUNTIME, providerLoginSync } from "./providerLoginSync";

function readProvider(args: unknown): ProviderLoginProvider | null {
  const value = isRecord(args) ? args.provider : undefined;
  if (value === undefined || value === null || value === "") return null;
  const provider = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (!isProviderLoginProvider(provider)) throw new Error(`Unknown provider '${String(value)}'.`);
  return provider;
}

/** A process with no sign-in sync (the desktop's own main process, a test runtime). */
function notThisRuntime(provider: ProviderLoginProvider | null): ProviderLoginStatus {
  return {
    thisComputer: {
      capture: "off",
      reason: "not_this_runtime",
      message: PROVIDER_LOGIN_NOT_THIS_RUNTIME,
      label: null,
      cloudComputer: false,
      lastPassAt: null,
    },
    cloud: { enabled: true, inUse: {}, claude: { smartBalance: false } },
    signIns: [],
    providers: PROVIDER_LOGIN_CARRY
      .filter((row) => !provider || row.provider === provider)
      .map((row) => ({ provider: row.provider, carry: row.carry, message: row.message, local: { state: "not_checked", key: null } })),
    applied: null,
  };
}

function readKey(args: unknown, name = "key"): string {
  const value = isRecord(args) ? args[name] : undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`provider_logins needs ${name}.`);
  return value.trim();
}

function readOn(args: unknown): boolean {
  const value = isRecord(args) ? args.on : undefined;
  if (typeof value !== "boolean") throw new Error("provider_logins needs on (true or false).");
  return value;
}

function requireSync() {
  const sync = providerLoginSync();
  if (!sync) throw new Error(PROVIDER_LOGIN_NOT_THIS_RUNTIME);
  return sync;
}

/** One method per action of `PROVIDER_LOGIN_ACTIONS` (the IPC allow-list and the action policy read that list). */
export function buildProviderLoginsDomainService(): Record<ProviderLoginAction, (args?: unknown) => Promise<ProviderLoginStatus>> {
  return {
    async status(args?: unknown): Promise<ProviderLoginStatus> {
      const provider = readProvider(args);
      const sync = providerLoginSync();
      return sync ? await sync.status(provider) : notThisRuntime(provider);
    },
    async captureNow(args?: unknown): Promise<ProviderLoginStatus> {
      const provider = readProvider(args);
      const sync = providerLoginSync();
      return sync ? await sync.captureNow(provider) : notThisRuntime(provider);
    },
    /**
     * `{provider: "antigravity", slot?}`: copy the agy CLI sign-in from this
     * computer's OS keyring, once. Refused on a cloud computer. The desktop calls it only for the computer
     * the person is using (a remote pin is refused in the preload).
     */
    async allowKeychain(args?: unknown): Promise<ProviderLoginStatus> {
      const provider = readProvider(args);
      if (provider !== "antigravity") throw new Error("provider_logins.allowKeychain needs provider \"antigravity\".");
      const raw = isRecord(args) ? args.slot : undefined;
      if (raw !== undefined && raw !== null && raw !== "personal" && raw !== "business") {
        throw new Error("provider_logins.allowKeychain takes slot \"personal\" or \"business\".");
      }
      return await requireSync().allowKeychain({ provider, slot: raw ?? null });
    },
    /**
     * `{on}`: Copilot's GitHub CLI login for ADE Cloud on this computer (G1).
     * On is only for this computer's desktop (`thisDesktopOnlyRefusalFor`), off
     * for any of the person's desktops. Refused on a cloud computer.
     */
    async allowGitHubCli(args?: unknown): Promise<ProviderLoginStatus> {
      return await requireSync().allowGitHubCli({ on: readOn(args) });
    },
    /** `{provider, key}`: a vault key, "key" for the saved key, or null for the newest. Pi takes `slot` with null. */
    async use(args?: unknown): Promise<ProviderLoginStatus> {
      const provider = readProvider(args);
      if (!provider) throw new Error("provider_logins.use needs provider.");
      const raw = isRecord(args) ? args.key : undefined;
      const key = raw === null || raw === undefined || raw === "" ? null : readKey(args);
      const slot = isRecord(args) && typeof args.slot === "string" && args.slot.trim() ? args.slot.trim() : null;
      return await requireSync().use({ provider, key, slot });
    },
    async setCloud(args?: unknown): Promise<ProviderLoginStatus> {
      return await requireSync().setCloud({ key: readKey(args), on: readOn(args) });
    },
    async setCloudAll(args?: unknown): Promise<ProviderLoginStatus> {
      return await requireSync().setCloudAll({ on: readOn(args) });
    },
    /** `{provider: "claude", on}`: Claude's smart balance on ADE Cloud (one switch for ADE Cloud). */
    async setCloudBalance(args?: unknown): Promise<ProviderLoginStatus> {
      const provider = readProvider(args);
      if (provider !== "claude") throw new Error("provider_logins.setCloudBalance needs provider \"claude\".");
      return await requireSync().setCloudBalance({ provider, on: readOn(args) });
    },
    async remove(args?: unknown): Promise<ProviderLoginStatus> {
      return await requireSync().remove({ key: readKey(args) });
    },
  };
}
