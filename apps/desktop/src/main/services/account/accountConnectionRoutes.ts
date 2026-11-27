import type { MachineConnectionRoutes } from "../../../shared/types";
import { parseMachineConnectionRoutes } from "../../../shared/machineConnectionRoutes";
import { markExpected } from "../../../shared/expectedError";
import { isUnsupportedAdeActionError, machineNeedsUpdateError } from "../../../shared/codedError";
import { isPeerMissingMethodMessage } from "../../../shared/sentry/expectedFailure";
import { unwrapAccountActionResult } from "../../../../../ade-cli/src/services/account/accountRefreshBroker";
import { BRAND } from "../../../shared/brand";

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
    if (!routes) throw new Error(`${who} sent connection details ${BRAND.NAME} couldn't read.`);
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
        throw new Error(`${BRAND.NAME}'s background service isn't running on this computer. Reopen ${BRAND.NAME}, then try again.`);
      }
      return read(await deps.callBrainAccountAction(action, args), "This computer");
    }
    const targetId = deps.resolveTargetIdForMachineKey(key);
    if (!targetId || (deps.isTargetConnected && !deps.isTargetConnected(targetId))) {
      // A computer this window isn't connected to (asleep, offline): the row says so.
      throw markExpected(new Error("Connect to this computer to see and change its routes."), "environment");
    }
    try {
      // The brain serves these as `account.call` actions (`multiProjectRpcServer`).
      // A bare `account.<action>` method is not a machine method there: every
      // brain answered it "requires params.projectId", so an up-to-date
      // computer was told to update.
      return read(
        await deps.callMachineMethod(targetId, "account.call", { action, args }, {
          timeoutMs: args.refresh === true ? ROUTES_REFRESH_TIMEOUT_MS : ROUTES_TIMEOUT_MS,
        }),
        "That computer",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An older peer: one without the action, or one that still wants a projectId.
      if (isPeerMissingMethodMessage(message) || isUnsupportedAdeActionError(error)) {
        throw markExpected(machineNeedsUpdateError(`Update ${BRAND.NAME} on that computer to manage its routes from here.`), "environment");
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
