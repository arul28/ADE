import { useEffect, useMemo, useState } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { useMachineEntryForBinding } from "../../state/crossMachineLanes";

/**
 * Who is on the other end of a pinned Mac Desktop call.
 *
 * The version matters for exactly one failure: a brain older than this app has
 * no `mac_desktop` domain, and the only useful sentence then names the machine
 * and the ADE running on it. `CrossMachineMachineLanes` carries the machine's
 * name, the machine list the version — neither alone is the whole answer.
 *
 * Read through a ref-like effect keyed on the target id, never on the pin
 * object: callers hand in a fresh binding object on many renders, and this is
 * not a poller. A binding-less pin is This computer, which never reaches the
 * missing-domain path.
 */
export type MacDesktopMachineFacts = {
  machineName: string;
  machineVersion: string | null;
};

/** The connection snapshot's version for one target, or null. Pure for tests. */
export function macDesktopMachineVersion(
  snapshot: { connections?: readonly { target: { id: string }; version: string | null }[] } | null,
  targetId: string | null,
): string | null {
  if (!snapshot || !targetId) return null;
  const connection = snapshot.connections?.find((entry) => entry.target.id === targetId);
  return connection?.version?.trim() || null;
}

export function useMacDesktopMachineFacts(
  pin: OpenProjectBinding | null,
): MacDesktopMachineFacts {
  const entry = useMachineEntryForBinding(pin);
  const [machineVersion, setMachineVersion] = useState<string | null>(null);
  const targetId = pin?.kind === "remote" ? pin.targetId : null;

  useEffect(() => {
    if (!targetId) {
      setMachineVersion(null);
      return undefined;
    }
    const api = window.ade?.remoteRuntime;
    // An older packaged shell with no snapshot bridge loses the version, not
    // the panel: the sentence degrades to "an older ADE" instead of vanishing.
    if (!api?.getConnectionSnapshot) {
      setMachineVersion(null);
      return undefined;
    }
    let cancelled = false;
    const apply = (snapshot: Parameters<typeof macDesktopMachineVersion>[0]) => {
      if (!cancelled) setMachineVersion(macDesktopMachineVersion(snapshot, targetId));
    };
    void api.getConnectionSnapshot().then(apply).catch(() => {});
    const unsubscribe = api.onConnectionSnapshotChanged?.(apply);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [targetId]);

  const machineName = entry?.machineName?.trim() || machineNameForBinding(pin);
  return useMemo(
    () => ({ machineName, machineVersion }),
    [machineName, machineVersion],
  );
}
