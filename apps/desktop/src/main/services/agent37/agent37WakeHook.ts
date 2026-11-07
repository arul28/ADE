/**
 * The desktop's Agent 37 answers for remote connections: "wake it for use",
 * and whether an update can take effect on a box. The remote connection
 * service is built before the Agent 37 integration, so it asks through these
 * hooks, which `registerAgent37Ipc` fills in. Unset (no integration in this
 * process), nothing wakes and nothing is refused.
 */

import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";

type WakeForUse = (target: RemoteRuntimeTarget) => Promise<boolean>;

let hook: WakeForUse | null = null;

export function setAgent37WakeForUse(next: WakeForUse | null): void {
  hook = next;
}

export async function agent37WakeForUse(target: RemoteRuntimeTarget): Promise<boolean> {
  return hook ? await hook(target) : false;
}

type UpdateBlocker = (target: RemoteRuntimeTarget) => Promise<string | null>;

let updateBlocker: UpdateBlocker | null = null;

export function setAgent37UpdateBlocker(next: UpdateBlocker | null): void {
  updateBlocker = next;
}

/** Why an update can't take effect on this machine (an Agent 37 box from an older template), or null. */
export async function agent37UpdateBlocker(target: RemoteRuntimeTarget): Promise<string | null> {
  return updateBlocker ? await updateBlocker(target).catch(() => null) : null;
}
