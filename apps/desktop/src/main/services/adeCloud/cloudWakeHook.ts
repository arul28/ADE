/**
 * The desktop's ADE Cloud answers for remote connections: "wake it for use",
 * and whether an update can take effect on a box. The remote connection
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

type UpdateBlocker = (target: RemoteRuntimeTarget) => Promise<string | null>;

let updateBlocker: UpdateBlocker | null = null;

export function setCloudUpdateBlocker(next: UpdateBlocker | null): void {
  updateBlocker = next;
}

/** Why an update can't take effect on this machine (a cloud box from an older template), or null. */
export async function cloudUpdateBlocker(target: RemoteRuntimeTarget): Promise<string | null> {
  return updateBlocker ? await updateBlocker(target).catch(() => null) : null;
}
