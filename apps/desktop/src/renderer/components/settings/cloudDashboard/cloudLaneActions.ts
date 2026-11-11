import type {
  CloudLaneDeleteResult,
  CloudLaneFreeResult,
  CloudLaneTierTiming,
  CloudLaneWithoutComputer,
} from "../../../../shared/cloudLaneLife";
import type { CloudTierId } from "../../../../shared/cloudTiers";
import { rootAppStoreApi } from "../../../state/appStore";
import { resolveAdeCloudLaneBinding } from "../../chat/adeCloudLaneBinding";
import type { DashLane } from "./cloudDashboardModel";

/**
 * What the dashboard does to a lane. Delete, keep the lane without its
 * computer, the size change and the lanes without a computer are account
 * level: the app's main process acts on the computer by its ADE Cloud id
 * (`cloud.laneLife`), so they need no pin. Clear caches runs ON the lane's
 * computer, so it resolves that computer's binding and passes it as the pin.
 *
 * Each one is checked for: the web app and an older preload may lack it.
 */

const UNAVAILABLE = "This ADE can't do that yet. Update ADE, then try again.";

function laneLife(): NonNullable<NonNullable<typeof window.ade.cloud>["laneLife"]> | null {
  return window.ade?.cloud?.laneLife ?? null;
}

export function cloudLaneLifeAvailable(): boolean {
  return laneLife() != null;
}

export async function deleteCloudLane(instanceId: string, options: { skipCheck: boolean }): Promise<CloudLaneDeleteResult> {
  const call = laneLife();
  if (!call) throw new Error(UNAVAILABLE);
  return await call({ method: "deleteLane", args: { instanceId, skipCheck: options.skipCheck } }) as CloudLaneDeleteResult;
}

/** Pushes the lane's work, removes its computer and keeps the lane: the next message makes a fresh computer. */
export async function freeCloudLane(instanceId: string): Promise<CloudLaneFreeResult> {
  const call = laneLife();
  if (!call) throw new Error(UNAVAILABLE);
  return await call({ method: "freeLane", args: { instanceId } }) as CloudLaneFreeResult;
}

export async function changeCloudLaneTier(instanceId: string, sizeId: CloudTierId, timing: CloudLaneTierTiming): Promise<void> {
  const call = laneLife();
  if (!call) throw new Error(UNAVAILABLE);
  await call({ method: "changeTier", args: { instanceId, sizeId, timing } });
}

/** The lanes kept without a computer (a server read, no wake). Empty when this ADE can't ask. */
export async function listCloudLanesWithoutComputer(): Promise<CloudLaneWithoutComputer[]> {
  const call = laneLife();
  if (!call) return [];
  const lanes = await call({ method: "lanesWithoutComputer" });
  return Array.isArray(lanes) ? lanes as CloudLaneWithoutComputer[] : [];
}

/**
 * Clears the lane computer's caches on that computer. The person's click
 * wakes it if it sleeps (the copy says so); ADE never does this on its own.
 */
export async function clearCloudLaneCaches(lane: DashLane): Promise<{ freedGb: number }> {
  const clear = window.ade?.cloud?.clearCaches;
  const machine = lane.machine;
  if (!clear || !machine?.lane || !lane.instanceId) throw new Error(UNAVAILABLE);
  const snapshot = await window.ade.remoteRuntime?.getConnectionSnapshot?.().catch(() => null);
  const pin = await resolveAdeCloudLaneBinding({
    lane: {
      instanceId: lane.instanceId,
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
  return await clear(pin, lane.instanceId);
}
