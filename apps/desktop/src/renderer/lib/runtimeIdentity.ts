import type { LocalRuntimeStatus } from "../../shared/types";

/**
 * Calls `onChange` when the local brain behind this window may be a different
 * one: its connection state changed, or a new process answered.
 *
 * `onRuntimeStatusChanged` also fires as a ~15 s health heartbeat with the same
 * state and pid. Listeners that re-publish or re-read on a reconnect must not
 * treat every heartbeat as one; the Work tool publish wrote the same state to
 * the brain three times every 15 s per open project.
 */
export function subscribeRuntimeIdentityChanges(onChange: () => void): (() => void) | undefined {
  const subscribe = typeof window === "undefined" ? undefined : window.ade?.app?.onRuntimeStatusChanged;
  if (typeof subscribe !== "function") return undefined;
  let lastIdentity: string | null = null;
  return subscribe((status: LocalRuntimeStatus) => {
    const identity = `${status?.connectionState ?? "unknown"}:${status?.pid ?? ""}`;
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    onChange();
  });
}
