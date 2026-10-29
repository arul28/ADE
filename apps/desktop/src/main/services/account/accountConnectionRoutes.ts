import type { MachineConnectionRoutes } from "../../../shared/types";
import { parseMachineConnectionRoutes } from "../../../shared/machineConnectionRoutes";
import { unwrapAccountActionResult } from "../../../../../ade-cli/src/services/account/accountRefreshBroker";

const ROUTES_TIMEOUT_MS = 12_000;
/** A refresh can run `tailscale status` (5 s) and then `serve --https` (15 s). */
const ROUTES_REFRESH_TIMEOUT_MS = 25_000;

export type AccountConnectionRoutesDeps = {
  /** `account.call` on THIS computer's brain. Absent when no brain answers. */
  callBrainAccountAction?: (action: string, args?: Record<string, unknown>) => Promise<unknown>;
  localMachineKey: () => string;
  resolveTargetIdForMachineKey: (machineKey: string) => string | null;
  isTargetConnected?: (targetId: string) => boolean;
  callMachineMethod: <T = unknown>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
};

export type AccountConnectionRoutesBridge = {
  getRoutes(args: { machineKey?: string | null; refresh?: boolean }): Promise<MachineConnectionRoutes>;
  setRelayEnabled(args: { machineKey?: string | null; enabled: boolean }): Promise<MachineConnectionRoutes>;
};

/**
 * Reads and changes one computer's connection routes, on THAT computer.
 *
 * This computer goes to its own brain. Any other computer goes over the live
 * paired connection to it, found by its account machine key, so a switch on
 * the Account page always changes the machine whose row it sits in.
 */
export function createAccountConnectionRoutesBridge(
  deps: AccountConnectionRoutesDeps,
): AccountConnectionRoutesBridge {
  /** The other computer's key, or null for this one. */
  const remoteKey = (machineKey: string | null | undefined): string | null => {
    const key = machineKey?.trim();
    return !key || key === deps.localMachineKey().trim() ? null : key;
  };

  const read = (raw: unknown, who: string): MachineConnectionRoutes => {
    const routes = parseMachineConnectionRoutes(unwrapAccountActionResult(raw));
    if (!routes) throw new Error(`${who} sent connection details ADE couldn't read.`);
    return routes;
  };

  const call = async (
    machineKey: string | null | undefined,
    action: "getConnectionRoutes" | "setRelayEnabled",
    args: Record<string, unknown>,
  ): Promise<MachineConnectionRoutes> => {
    const key = remoteKey(machineKey);
    if (!key) {
      if (!deps.callBrainAccountAction) {
        throw new Error("ADE's background service isn't running on this computer. Reopen ADE, then try again.");
      }
      return read(await deps.callBrainAccountAction(action, args), "This computer");
    }
    const targetId = deps.resolveTargetIdForMachineKey(key);
    if (!targetId || (deps.isTargetConnected && !deps.isTargetConnected(targetId))) {
      throw new Error("Connect to this computer to see and change its routes.");
    }
    try {
      return read(
        await deps.callMachineMethod(targetId, `account.${action}`, args, {
          timeoutMs: args.refresh === true ? ROUTES_REFRESH_TIMEOUT_MS : ROUTES_TIMEOUT_MS,
        }),
        "That computer",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unsupported (remote )?command|method not found|unknown method/i.test(message)) {
        throw new Error("Update ADE on that computer to manage its routes from here.");
      }
      throw error;
    }
  };

  return {
    getRoutes: ({ machineKey, refresh }) =>
      call(machineKey, "getConnectionRoutes", refresh ? { refresh: true } : {}),
    setRelayEnabled: ({ machineKey, enabled }) =>
      call(machineKey, "setRelayEnabled", { enabled }),
  };
}
