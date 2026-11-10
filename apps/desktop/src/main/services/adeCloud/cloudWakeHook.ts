/**
 * The desktop's ADE Cloud answers for remote connections: "wake it for use",
 * "is it asleep", and whether an update can take effect on a box. The remote connection
 * service is built before the provider integration, so it asks through these
 * hooks, which `registerCloudIpc` fills in. Unset (no integration in this
 * process), nothing wakes and nothing is refused.
 */

import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";

type WakeForUse = (target: RemoteRuntimeTarget) => Promise<boolean>;

let hook: WakeForUse | null = null;

export function setCloudWakeForUse(next: WakeForUse | null): void {
  hook = next;
}

export async function cloudWakeForUse(target: RemoteRuntimeTarget): Promise<boolean> {
  return hook ? await hook(target) : false;
}

/**
 * True when the machine is a cloud computer that is asleep. Null, at once or
 * as the answer, when it isn't a cloud computer: telling may need a bounded
 * read of the account's computers.
 */
type AsleepCheck = (target: RemoteRuntimeTarget) => Promise<boolean | null> | null;

let asleepCheck: AsleepCheck | null = null;

export function setCloudAsleepCheck(next: AsleepCheck | null): void {
  asleepCheck = next;
}

/** Whether this machine is a cloud computer that is asleep or stopped; null when it isn't a cloud computer. */
export function cloudAsleepForUse(target: RemoteRuntimeTarget): Promise<boolean | null> | null {
  return asleepCheck ? asleepCheck(target) : null;
}

type RestChanged = (targetId: string, resting: boolean) => void;

let restChanged: RestChanged | null = null;

export function setCloudRestChanged(next: RestChanged | null): void {
  restChanged = next;
}

/** A cloud computer started or ended a rest. Once per change, from the remote connection service. */
export function cloudRestChanged(targetId: string, resting: boolean): void {
  restChanged?.(targetId, resting);
}

type UpdateBlocker = (target: RemoteRuntimeTarget) => Promise<string | null>;

let updateBlocker: UpdateBlocker | null = null;

export function setCloudUpdateBlocker(next: UpdateBlocker | null): void {
  updateBlocker = next;
}

/** Why an update can't take effect on this machine (a cloud box from an older template), or null. */
export async function cloudUpdateBlocker(target: RemoteRuntimeTarget): Promise<string | null> {
  return updateBlocker ? await updateBlocker(target).catch(() => null) : null;
}
