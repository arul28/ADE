/**
 * Reconnect for an Agent 37 machine that was removed from the account ("Not
 * in ADE" in the machine list). Removing a machine is durable on purpose: its
 * brain refuses the account (`machine_revoked`) until someone runs `ade
 * machines reconnect` on it, and only a person's re-pair lifts that. Reconnect
 * is that re-pair, done for the person: ADE runs the command on the box over
 * exec and approves its sign-in code with this computer's account, as it does
 * for a new machine. The box keeps its files and identity, so it comes back as
 * the same machine.
 *
 * Account-level like the rest of the machine list: it runs in this desktop's
 * main process with the account's Agent 37 key and takes no pin.
 */

import { agent37CapReachedMessage, type Agent37CreateMachineResult, type Agent37CreateProgress } from "../../../shared/agent37";
import { getErrorMessage } from "../shared/utils";
import {
  Agent37CreateCancelled,
  approveAgent37MachineSignIn,
  readAgent37BoxAuth,
  startAgent37BoxSignIn,
  waitForAgent37AccountRow,
  waitForAgent37BoxAuth,
} from "./agent37MachineCreator";
import type { Agent37MachineCreatorDeps } from "./agent37MachineCreator";
import type { Agent37CopyDeps } from "./agent37MachineCopy";
import { enableAgent37Sleep } from "./agent37Sleep";
import { wakeThroughTransition } from "./agent37ReadyClaim";

/** In the account: signed in, and the account did not remove it. */
function inAccount(auth: Record<string, unknown> | null): boolean {
  return auth?.signedIn === true && (auth.thisComputerRefusal == null);
}

type ReconnectDeps = Agent37MachineCreatorDeps & Pick<Agent37CopyDeps, "spending">;

export async function reconnectAgent37Machine(
  deps: ReconnectDeps,
  args: { instanceId: string; requestId: string },
  onProgress: (progress: Agent37CreateProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<Agent37CreateMachineResult> {
  try {
    return await reconnect(deps, args, onProgress, options);
  } catch (error) {
    // The shared steps word a cancel for a create.
    if (error instanceof Agent37CreateCancelled) {
      throw new Agent37CreateCancelled("You stopped the reconnect. If the box had already signed in, it shows under Your computers when it's ready.");
    }
    throw error;
  }
}

async function reconnect(
  deps: ReconnectDeps,
  args: { instanceId: string; requestId: string },
  onProgress: (progress: Agent37CreateProgress) => void,
  options: { signal?: AbortSignal },
): Promise<Agent37CreateMachineResult> {
  const { requestId } = args;
  const { signal } = options;
  const logger = deps.logger ?? {};
  const progress = (stage: Agent37CreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't set up in this build.");
  const client = await deps.client();
  const instance = await client.getInstance(args.instanceId);
  const name = instance.name ?? instance.id;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (instance.status !== "running") {
    // A wake bills like any other: refused past the month's cap.
    const month = await deps.spending?.().catch((error: unknown) => {
      logger.warn?.("agent37.reconnect_spending_failed", { instanceId: instance.id, error: getErrorMessage(error) });
      return null;
    });
    if (month?.capReached) throw new Error(agent37CapReachedMessage(month));
    progress("creating", `Waking ${name}…`, instance.id);
    await wakeThroughTransition(client, instance.id);
  }
  progress("waiting_for_brain", `Asking ADE on ${name}…`, instance.id);
  const auth = await waitForAgent37BoxAuth(client, instance.id, { signal, sleep, machine: name });
  if (!inAccount(auth)) {
    progress("signing_in", `Signing ${name} back in to your account…`, instance.id);
    const started = await startAgent37BoxSignIn(client, instance.id, "reconnect", signal);
    if (!started.userCode) {
      logger.warn?.("agent37.reconnect_no_code", { instanceId: instance.id, exitCode: started.exitCode });
      throw new Error(`${name} didn't start its sign-in.`);
    }
    await approveAgent37MachineSignIn(deps, {
      userCode: started.userCode,
      name,
      instanceId: instance.id,
      directory,
      signal,
      readSignedIn: async () => inAccount(await readAgent37BoxAuth(client, instance.id, signal)),
      onApprovalSent: () => logger.info?.("agent37.reconnect_approval_sent", { instanceId: instance.id }),
      progress,
    });
  }
  progress("joining", `${name} is signed in. Adding it to your computers…`, instance.id);
  const joined = await waitForAgent37AccountRow(deps, { client, instanceId: instance.id, name, requestId, signal });
  if (joined.machineKey) {
    await enableAgent37Sleep(client, instance.id, { afterMinutes: deps.sleepAfterMinutes?.() ?? undefined, logger })
      .catch((error: unknown) => logger.warn?.("agent37.reconnect_sleep_failed", { instanceId: instance.id, error: getErrorMessage(error) }));
  }
  logger.info?.("agent37.machine_reconnected", { instanceId: instance.id, joined: joined.joined });
  return { instanceId: instance.id, name, ...joined };
}
