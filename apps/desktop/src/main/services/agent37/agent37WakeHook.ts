/**
 * The desktop's "wake it for use" for remote connections. The remote
 * connection service is built before the Agent 37 integration, so it asks
 * through this hook, which `registerAgent37Ipc` fills in. Unset (no
 * integration in this process), nothing wakes.
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
