/**
 * The `provider_logins` actions (P5 step 1): `status` (a read for anyone)
 * and `captureNow` (the person's "look now"). Each one runs on the brain the
 * call reaches, so a caller pins the machine whose sign-ins it means.
 * Neither ever returns a token, a key, a file's content or a hash.
 */

import {
  isProviderLoginProvider,
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
    cloud: { enabled: true },
    signIns: [],
    providers: PROVIDER_LOGIN_CARRY
      .filter((row) => !provider || row.provider === provider)
      .map((row) => ({ provider: row.provider, carry: row.carry, message: row.message, local: { state: "not_checked", key: null } })),
  };
}

export function buildProviderLoginsDomainService() {
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
  };
}
