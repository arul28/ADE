/**
 * Reconnect for a cloud machine that was removed from the account ("Not
 * in ADE" in the machine list). Removing a machine is durable on purpose: its
 * brain refuses the account (`machine_revoked`) until someone runs `ade
 * machines reconnect` on it, and only a person's re-pair lifts that. Reconnect
 * is that re-pair, done for the person: ADE runs the command on the box over
 * exec and approves its sign-in code with this computer's account, as it does
 * for a new machine. The box keeps its files and identity, so it comes back as
 * the same machine.
 *
 * Account-level like the rest of the machine list: it runs in this desktop's
 * main process with the account's ADE Cloud access and takes no pin.
 */

import type { CloudCreateMachineResult, CloudCreateProgress } from "../../../shared/adeCloud";
import { getErrorMessage } from "../shared/utils";
import {
  CloudCreateCancelled,
  approveCloudMachineSignIn,
  readCloudBoxAuth,
  startCloudBoxSignIn,
  waitForCloudAccountRow,
  waitForCloudBoxAuth,
} from "./cloudMachineCreator";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { enableCloudSleep } from "./cloudSleep";
import { wakeThroughTransition } from "./cloudReadyClaim";

/** In the account: signed in, and the account did not remove it. */
function inAccount(auth: Record<string, unknown> | null): boolean {
  return auth?.signedIn === true && (auth.thisComputerRefusal == null);
}

type ReconnectDeps = CloudMachineCreatorDeps;

export async function reconnectCloudMachine(
  deps: ReconnectDeps,
  args: { instanceId: string; requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<CloudCreateMachineResult> {
  try {
    return await reconnect(deps, args, onProgress, options);
  } catch (error) {
    // The shared steps word a cancel for a create.
    if (error instanceof CloudCreateCancelled) {
      throw new CloudCreateCancelled("You stopped the reconnect. If the box had already signed in, it shows under Your computers when it's ready.");
    }
    throw error;
  }
}

async function reconnect(
  deps: ReconnectDeps,
  args: { instanceId: string; requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal },
): Promise<CloudCreateMachineResult> {
  const { requestId } = args;
  const { signal } = options;
  const logger = deps.logger ?? {};
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't set up in this build.");
  const client = await deps.client();
  const instance = await client.getInstance(args.instanceId);
  const name = instance.name ?? instance.id;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (instance.status !== "running") {
    progress("creating", `Waking ${name}…`, instance.id);
    await wakeThroughTransition(client, instance.id);
  }
  progress("waiting_for_brain", `Asking ADE on ${name}…`, instance.id);
  const auth = await waitForCloudBoxAuth(client, instance.id, { signal, sleep, machine: name });
  if (!inAccount(auth)) {
    progress("signing_in", `Signing ${name} back in to your account…`, instance.id);
    const started = await startCloudBoxSignIn(client, instance.id, "reconnect", signal);
    if (!started.userCode) {
      logger.warn?.("cloud.reconnect_no_code", { instanceId: instance.id, exitCode: started.exitCode });
      throw new Error(`${name} didn't start its sign-in.`);
    }
    await approveCloudMachineSignIn(deps, {
      userCode: started.userCode,
      name,
      instanceId: instance.id,
      directory,
      signal,
      readSignedIn: async () => inAccount(await readCloudBoxAuth(client, instance.id, signal)),
      onApprovalSent: () => logger.info?.("cloud.reconnect_approval_sent", { instanceId: instance.id }),
      progress,
    });
  }
  progress("joining", `${name} is signed in. Adding it to your computers…`, instance.id);
  const joined = await waitForCloudAccountRow(deps, { client, instanceId: instance.id, name, requestId, signal });
  if (joined.machineKey) {
    await enableCloudSleep(client, instance.id, { logger })
      .catch((error: unknown) => logger.warn?.("cloud.reconnect_sleep_failed", { instanceId: instance.id, error: getErrorMessage(error) }));
  }
  logger.info?.("cloud.machine_reconnected", { instanceId: instance.id, joined: joined.joined });
  return { instanceId: instance.id, name, ...joined };
}
