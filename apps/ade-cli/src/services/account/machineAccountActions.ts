/**
 * The provider account and the account vault with no project open
 * (`cloud.call`, `accountVault.call` in multiProjectRpcServer): the
 * desktop's Settings in a window with no project on this computer, and
 * `ade cloud` from any folder. The services and caller rules of
 * `run_ade_action`, for the actions in `ADE_ACTION_MACHINE_SCOPED`.
 */
import { JsonRpcError, JsonRpcErrorCode } from "../../jsonrpc";
import { cloudDomainEnabled } from "../../../../desktop/src/shared/adeCloud";
import { callerIdentityIsAgent, type AdeRuntimeRole } from "../../runtimeRoles";
import {
  adeActionCallerRefusal,
  isAllowedAdeAction,
  isMachineScopedAdeAction,
  isUserOnlyAdeAction,
  type AdeMachineScopedDomain,
} from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import { ACTION_NOT_CALLABLE_CODE, encodeCodedErrorMessage } from "../../../../desktop/src/shared/codedError";
import { DESKTOP_CLIENT_NAMES, isRemoteBrainCallerClientName } from "../../../../desktop/src/shared/runtimeClientNames";

const MACHINE_ACCOUNT_METHODS = {
  "cloud.call": "cloud",
  "accountVault.call": "account_vault",
} as const satisfies Record<string, AdeMachineScopedDomain>;

export type MachineAccountMethod = keyof typeof MACHINE_ACCOUNT_METHODS;

/** The account-level domain services, over the machine's account stores (`buildMachineAccountDomainServices`). */
export type MachineAccountDomains = () => Promise<Partial<Record<AdeMachineScopedDomain, Record<string, unknown> | null>>>;

export type MachineAccountCaller = {
  role: AdeRuntimeRole | null;
  identity: Record<string, unknown> | null;
  /** The name the client gave itself in `ade/initialize`. */
  clientName: string | null;
  /** The paired device a sync-channel peer authenticated as; null on this computer's own sockets. */
  peerDeviceId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMachineAccountMethod(method: string): method is MachineAccountMethod {
  return Object.prototype.hasOwnProperty.call(MACHINE_ACCOUNT_METHODS, method);
}

export async function runMachineAccountAction(
  method: MachineAccountMethod,
  params: Record<string, unknown>,
  caller: MachineAccountCaller,
  domains: MachineAccountDomains | undefined,
): Promise<{ domain: AdeMachineScopedDomain; action: string; result: unknown; statusHints: Record<string, never> }> {
  // This computer's own windows and terminals: a paired device reaches its
  // own computer's brain for the account, never this one.
  if (caller.peerDeviceId) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidRequest, `${method} answers only this computer's own connections.`);
  }
  const domain = MACHINE_ACCOUNT_METHODS[method];
  const action = typeof params.action === "string" ? params.action.trim() : "";
  if (!isMachineScopedAdeAction(domain, action) || !isAllowedAdeAction(domain, action)) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${domain}.${action || "?"} runs in a project, not through ${method}.`);
  }
  const remoteBrain = isRemoteBrainCallerClientName(caller.clientName);
  const userClient = !callerIdentityIsAgent(caller.identity) && !remoteBrain;
  const refusal = adeActionCallerRefusal(domain, action, { role: caller.role, userClient, remoteBrain });
  if (refusal) {
    throw new JsonRpcError(
      refusal.kind === "role" ? JsonRpcErrorCode.methodNotFound : JsonRpcErrorCode.policyDenied,
      refusal.message,
    );
  }
  // The person's own desktop app on this computer: Settings › the provider always
  // asks this computer's brain, never another one's.
  const localDesktop = userClient && caller.clientName === DESKTOP_CLIENT_NAMES.local;
  if (isUserOnlyAdeAction(domain, action) && !localDesktop) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, `${domain}.${action} is limited to the ADE desktop app on this computer.`);
  }
  // The vault with no project is the desktop's ADE Cloud code, and only that.
  if (domain === "account_vault" && !localDesktop) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, `${method} is only for the ADE desktop app on this computer.`);
  }
  const service = (await domains?.())?.[domain] ?? null;
  const callable = service?.[action];
  // No ADE Cloud for this account: `cloud` answers as if it weren't here, like
  // a missing action below. `access` itself stays, it is the answer.
  const hiddenCloud = domain === "cloud" && action !== "access" && !(await cloudDomainEnabled(service, (error) => console.warn("[cloud] access read failed", error instanceof Error ? error.message : String(error))));
  if (typeof callable !== "function" || hiddenCloud) {
    throw new JsonRpcError(
      JsonRpcErrorCode.methodNotFound,
      encodeCodedErrorMessage(ACTION_NOT_CALLABLE_CODE, `${domain}.${action} is unavailable in this runtime.`),
    );
  }
  const argsList = Array.isArray(params.argsList) ? params.argsList : [isRecord(params.args) ? params.args : {}];
  const result = await (callable as (...args: unknown[]) => unknown).apply(service, argsList);
  return { domain, action, result, statusHints: {} };
}
