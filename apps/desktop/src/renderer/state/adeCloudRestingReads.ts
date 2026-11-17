import type { AdeCloudRestingTarget } from "../../shared/adeCloud/chatQueue";
import { rootAppStoreApi } from "./appStore";
import { adeCloudLaneComputerForMachine, adeCloudLaneComputersNow, subscribeAdeCloudLaneComputers } from "./adeCloudLaneIndex";
import { cloudConnectionMachineKey, isSavedChatsMachineId, subscribeCloudConnectionTargets } from "./cloudSavedChats";
import { machineIsCloudResting } from "./cloudRestingRows";

/**
 * Reading never wakes: the connections of ADE Cloud computers that rest now
 * go to the preload (`window.ade.adeCloud.setRestingTargets`), and a read for
 * one of their lanes (files, Git, changes) is answered from the account. A
 * send, a terminal or a wake still goes to the computer
 * (`useAdeCloudLaneWake`). The list follows the cross-machine store and the
 * ADE Cloud lane index and the cloud connections list; no timer.
 */

let started = false;
let lastSent = "";

function restingTargets(): AdeCloudRestingTarget[] {
  const state = rootAppStoreApi.getState();
  const computers = adeCloudLaneComputersNow();
  const tabOrigin = state.projectBinding?.kind === "remote" ? state.projectBinding.gitOriginUrl ?? null : null;
  const targets = new Map<string, AdeCloudRestingTarget>();
  for (const entry of Object.values(state.crossMachineLanesByMachineId)) {
    if (isSavedChatsMachineId(entry.machineId) || !machineIsCloudResting(entry, computers)) continue;
    const binding = entry.binding?.kind === "remote" ? entry.binding : null;
    const targetId = binding?.targetId ?? entry.targetId ?? null;
    if (!targetId || targets.has(targetId)) continue;
    const machineKey = cloudConnectionMachineKey(entry.machineId)
      ?? cloudConnectionMachineKey(targetId)
      ?? adeCloudLaneComputerForMachine({ hostname: binding?.hostname ?? null }, computers)?.machineKey
      ?? null;
    if (!machineKey) continue;
    targets.set(targetId, { targetId, machineKey, origin: binding?.gitOriginUrl ?? tabOrigin });
  }
  return [...targets.values()];
}

/** Sends the list again when it changed. Cheap: a walk of the machine entries. */
export function publishAdeCloudRestingTargets(): void {
  const set = window.ade?.adeCloud?.setRestingTargets;
  if (typeof set !== "function") return;
  const targets = restingTargets();
  const next = JSON.stringify(targets);
  if (next === lastSent) return;
  lastSent = next;
  set(targets);
}

/** Starts the follow once per window (idempotent). */
export function startAdeCloudRestingReads(): void {
  if (started || typeof window === "undefined" || typeof window.ade?.adeCloud?.setRestingTargets !== "function") return;
  started = true;
  let entries = rootAppStoreApi.getState().crossMachineLanesByMachineId;
  rootAppStoreApi.subscribe((state) => {
    if (state.crossMachineLanesByMachineId === entries) return;
    entries = state.crossMachineLanesByMachineId;
    publishAdeCloudRestingTargets();
  });
  subscribeAdeCloudLaneComputers(publishAdeCloudRestingTargets);
  subscribeCloudConnectionTargets(publishAdeCloudRestingTargets);
  publishAdeCloudRestingTargets();
}
