import { useEffect, useMemo, useState } from "react";
import type { CloudAccountState, CloudMachine } from "../../../shared/adeCloud";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { cloudBoxForMachine } from "./cloudMachineModel";
import { useCloudMachines } from "./useCloudMachines";

/** The cloud computer behind the machine a surface works on, with the account's hours. */
export function useCloudComputer(pin: OpenProjectBinding | null | undefined, enabled = true): {
  box: CloudMachine | null;
  account: CloudAccountState | null;
  /**
   * The list was read and the machine's account key looked up, so a null
   * `box` means the machine is not an ADE Cloud computer (or no longer one).
   */
  known: boolean;
  refresh: () => void;
} {
  const cloudEnabled = useAdeCloudEnabled();
  const bound = useAppStore((state) => state.projectBinding ?? null);
  const binding = effectiveRuntimeBinding(pin, bound);
  const remote = enabled && cloudEnabled && binding?.kind === "remote";
  const { result, refresh } = useCloudMachines(remote);
  const hostname = binding?.kind === "remote" ? binding.hostname ?? null : null;
  const { machineKey, resolved } = useTargetMachineKey(remote && binding?.kind === "remote" ? binding.targetId : null);
  const box = useMemo(
    () => (result && (machineKey || hostname) ? cloudBoxForMachine(result.machines, { machineKey, hostname }) : null),
    [hostname, machineKey, result],
  );
  const known = remote && resolved && result?.state === "ok";
  return { box, account: result?.account ?? null, known, refresh };
}

/** The computer's account key behind a paired machine: a relay connection's hostname is the relay's, not the computer's. */
function useTargetMachineKey(targetId: string | null): { machineKey: string | null; resolved: boolean } {
  const [answer, setAnswer] = useState<{ targetId: string; machineKey: string | null } | null>(null);
  useEffect(() => {
    setAnswer(null);
    if (!targetId) return;
    let cancelled = false;
    void window.ade.remoteRuntime?.listTargets?.().then(
      (targets) => {
        if (!cancelled) setAnswer({ targetId, machineKey: targets.find((target) => target.id === targetId)?.pairedMachine?.machineKey?.trim() ?? null });
      },
      (error: unknown) => console.warn("[cloud] reading connection targets failed", error),
    );
    return () => {
      cancelled = true;
    };
  }, [targetId]);
  const current = answer && answer.targetId === targetId ? answer : null;
  return { machineKey: current?.machineKey ?? null, resolved: current != null };
}

export function computerIsDown(box: CloudMachine | null): boolean {
  return box?.state === "asleep" || box?.state === "stopped";
}

/** Asleep or stopped, or on the way between: a person's use wakes it. */
export function cloudComputerResting(box: CloudMachine | null): box is CloudMachine {
  return box != null && (computerIsDown(box) || box.state === "starting" || box.state === "stopping");
}

/** Whether the computer is out of reach for now; PR and Jira read around it. */
export function useCloudComputerAsleep(pin: OpenProjectBinding | null | undefined): CloudMachine | null {
  const { box } = useCloudComputer(pin);
  return cloudComputerResting(box) ? box : null;
}
