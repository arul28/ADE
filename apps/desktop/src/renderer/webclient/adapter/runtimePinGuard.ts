import type { OpenProjectBinding } from "../../../shared/types";
import type { AdeSyncClient } from "../sync";
import type { AdapterProjectState } from "./infra/projectState";

/**
 * Adapter-wide runtime-pin boundary guard.
 *
 * An Electron-contract call can arrive with a per-session runtime pin naming
 * the (machine, project) it must run against. A web adapter instance speaks to
 * exactly one machine and one bound project, and `CommandCaller` stamps that
 * project onto every project-scoped command — so a pin naming anything else
 * cannot be routed, and serving it anyway would be a wrong-machine or
 * wrong-project read or write.
 *
 * A pin naming THIS adapter's own machine and project is not a routing problem
 * at all: it restates where the call was already going. That is the common case
 * behind the Chats surface, which keeps the window's project binding while
 * showing a projectless page, so every pinned pty call it makes is pinned to
 * the machine already on the other end of the socket. Those proceed unpinned.
 * Genuinely foreign pins still fail loudly; a cross-machine web union must
 * extend the adapter before relying on one.
 */

/**
 * The trailing runtime pin as the Electron contract declares it: a binding, or
 * nothing. Every pinned adapter member takes exactly this.
 */
export type RuntimePinArg = OpenProjectBinding | null | undefined;

/**
 * Whether a remote pin names the machine this adapter is connected to.
 *
 * A target id IS an environment id on the hosted client: `connectMachineEntry`
 * resolves a machine to `environment.envId` and hands that back as the target
 * the federated adapter binds, so the client's selected environment is the same
 * string the pin carries.
 */
function pinTargetsThisMachine(pin: { targetId: string }, client: AdeSyncClient): boolean {
  const envId = client.getStatus().selectedEnvId;
  return Boolean(envId) && pin.targetId === envId;
}

export type RuntimePinScope = {
  client: AdeSyncClient;
  state: AdapterProjectState;
};

/**
 * Throw unless the call can be served as-is: no pin, or a pin naming the
 * machine and project this adapter already talks to.
 *
 * Requiring the project to match too is the conservative half. Dropping a pin
 * means "use whatever project this adapter is bound to", which is the same
 * request only when the pin agrees; a same-machine pin naming a DIFFERENT
 * project would otherwise be silently answered for the wrong one.
 */
export function assertWebRuntimePinRoutable(
  operation: string,
  pin: RuntimePinArg,
  scope: RuntimePinScope,
): void {
  if (pin == null) return;
  // A `kind: "local"` pin names a runtime on the machine running the desktop
  // app — something the browser has no path to at all, and which carries no
  // targetId, so the remote comparison below could only report it as an
  // unroutable binding. Say what actually happened instead.
  if (pin.kind === "local") {
    throw new Error("This chat runs on a machine ADE Web can't reach directly.");
  }
  if (pinTargetsThisMachine(pin, scope.client) && pin.projectId === scope.state.getProjectId()) {
    return;
  }
  // The key is `remote:<targetId>:<projectId>` (federated.ts `bindingKey`) and
  // is used only to name the binding here — the routing decision above reads
  // the fields directly rather than splitting the key, which would break on any
  // id containing a colon.
  throw new Error(
    `ADE Web cannot route ${operation} to pinned runtime ${pin.key || "unknown binding"};`
    + " cross-machine web routing is not implemented.",
  );
}
