import type {
  CloudLaneDeleteResult,
  CloudLaneFreeResult,
  CloudLaneJobSnapshot,
  CloudLaneLifeMethod,
  CloudLaneLifeResults,
  CloudLaneTierTiming,
  CloudLaneWithoutComputer,
  CloudLaneWorkState,
} from "../../../shared/cloudLaneLife";
import type { CloudTierId } from "../../../shared/cloudTiers";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { rootAppStoreApi } from "../../state/appStore";
import { adeCloudLaneComputerForMachine, forgetCloudLaneComputer, type AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { resolveAdeCloudLaneBinding } from "../chat/adeCloudLaneBinding";

/**
 * What ADE does to a cloud lane's computer, from every place that shows one
 * (the dashboard, the Lanes tab and lane menus, the chat).
 *
 * Delete, keep the lane without its computer, the size change, its steps and
 * the lanes without a computer are account level: this app's main process
 * acts on the computer by its ADE Cloud id (`cloud.laneLife`), so they take
 * no pin and answer the same whichever machine a project tab is bound to.
 * Clear caches runs ON the lane's computer, so it resolves that computer's
 * binding and passes it as the pin.
 *
 * Each one is checked for: the web app and an older preload lack them.
 */

export const CLOUD_LANE_LIFE_UNAVAILABLE = "Do this in the ADE desktop app. This window can't change ADE Cloud lanes.";

function laneLife(): NonNullable<NonNullable<typeof window.ade.cloud>["laneLife"]> | null {
  return (typeof window !== "undefined" ? window.ade?.cloud?.laneLife : null) ?? null;
}

async function call<M extends CloudLaneLifeMethod>(method: M, args?: unknown): Promise<CloudLaneLifeResults[M]> {
  const run = laneLife();
  if (!run) throw new Error(CLOUD_LANE_LIFE_UNAVAILABLE);
  return await run({ method, args });
}

export function cloudLaneLifeAvailable(): boolean {
  return laneLife() != null;
}

/** Whether the computer holds work that isn't on GitHub (null: the check couldn't run). */
export async function cloudLaneWorkState(instanceId: string): Promise<CloudLaneWorkState> {
  return await call("workState", { instanceId });
}

export async function deleteCloudLane(instanceId: string, options: { skipCheck: boolean }): Promise<CloudLaneDeleteResult> {
  const done = await call("deleteLane", { instanceId, skipCheck: options.skipCheck });
  if (done.ok) forgetCloudLaneComputer(instanceId);
  return done;
}

/**
 * Pushes the lane's work, removes its computer and keeps the lane: the next
 * message makes a fresh computer. A chat on it then reads "Cloud · lane"
 * with no computer, not the old computer's name.
 */
export async function freeCloudLane(instanceId: string): Promise<CloudLaneFreeResult> {
  const done = await call("freeLane", { instanceId });
  if (done.ok) forgetCloudLaneComputer(instanceId);
  return done;
}

export async function changeCloudLaneTier(input: {
  instanceId: string;
  sizeId: CloudTierId;
  timing: CloudLaneTierTiming;
  /** A resize only: grow the disk to this many GB in the same step. */
  diskGb?: number | null;
  /** An agent's request card the person confirmed. */
  requestId?: string | null;
  requestedByChat?: string | null;
}): Promise<CloudLaneJobSnapshot> {
  return await call("changeTier", input);
}

export async function listCloudLaneJobs(): Promise<CloudLaneJobSnapshot[]> {
  if (!cloudLaneLifeAvailable()) return [];
  const jobs = await call("listJobs");
  return Array.isArray(jobs) ? jobs : [];
}

export async function retryCloudLaneJob(jobId: string): Promise<void> {
  await call("retryJob", { jobId });
}

export async function cancelCloudLaneJob(jobId: string): Promise<void> {
  await call("cancelJob", { jobId });
}

/** Closes a finished or failed job's card in every window. The computer stays as the job left it. */
export async function dismissCloudLaneJob(jobId: string): Promise<void> {
  await call("dismissJob", { jobId });
}

/** The lanes kept without a computer (a server read, no wake). Empty when this ADE can't ask. */
export async function listCloudLanesWithoutComputer(): Promise<CloudLaneWithoutComputer[]> {
  if (!cloudLaneLifeAvailable()) return [];
  const lanes = await call("lanesWithoutComputer");
  return Array.isArray(lanes) ? lanes : [];
}

export async function forgetCloudLaneWithoutComputer(laneId: string): Promise<void> {
  await call("forgetLaneWithoutComputer", { laneId });
}

/**
 * Pushes every lane's work on the computer to GitHub (`cloud.pushAllWork`).
 * Account level, like the others. Throws with the computer's own sentence
 * when it couldn't.
 */
export async function pushCloudLaneWork(instanceId: string): Promise<string> {
  const push = window.ade?.cloud?.pushAllWork;
  if (!push) throw new Error(CLOUD_LANE_LIFE_UNAVAILABLE);
  const result = await push(instanceId);
  if (!result.ok) throw new Error(result.message || "ADE couldn't push the work.");
  return result.message || "Pushed all work to GitHub.";
}

/**
 * Clears the lane computer's caches on that computer. The person's click
 * wakes it if it sleeps (the copy says so); ADE never does this on its own.
 */
export async function clearCloudLaneCaches(input: { instanceId: string | null; machine: CloudLaneMachine | null }): Promise<{ freedGb: number }> {
  const clear = window.ade?.cloud?.clearCaches;
  const { machine, instanceId } = input;
  if (!clear || !machine?.lane || !instanceId) throw new Error(CLOUD_LANE_LIFE_UNAVAILABLE);
  const snapshot = await window.ade.remoteRuntime?.getConnectionSnapshot?.().catch(() => null);
  const pin = await resolveAdeCloudLaneBinding({
    lane: {
      instanceId,
      machineKey: machine.machineKey,
      state: machine.state,
      laneId: machine.lane.laneId,
      laneName: machine.lane.laneName,
      projectOrigin: machine.lane.projectOrigin,
    },
    originUrl: machine.lane.projectOrigin,
    connections: snapshot?.connections ?? [],
    knownBindingFor: (targetId) => rootAppStoreApi.getState().crossMachineLanesByMachineId[targetId]?.binding ?? null,
    stillWanted: () => true,
    onWaking: () => {},
  });
  return await clear(pin, instanceId);
}

/**
 * The ADE Cloud computer a lane lives on, when the lane is that computer's
 * own lane: the pin reaches a lane computer (its target carries the
 * computer's id as host name) and the computer's record names this lane.
 * Null for every other lane, which then deletes the usual way. `computers`
 * is the lane computer index a component reads (`useAdeCloudLaneComputers`).
 */
export function cloudLaneComputerOfLane(
  pin: OpenProjectBinding | null | undefined,
  laneId: string,
  computers: readonly AdeCloudLaneComputer[],
): { instanceId: string; laneName: string } | null {
  if (!pin || pin.kind !== "remote") return null;
  const computer = adeCloudLaneComputerForMachine({ hostname: pin.hostname ?? null }, computers);
  if (!computer || computer.laneId !== laneId) return null;
  return { instanceId: computer.instanceId, laneName: computer.laneName };
}
