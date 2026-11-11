import { useCallback } from "react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useRootAppStore } from "../../state/appStore";
import { adeCloudLaneComputerForMachine, adeCloudLaneLabel, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";

/**
 * How a machine switcher names a machine: an ADE Cloud lane's computer reads
 * "ADE Cloud · <lane>", never the computer's own name; every other machine
 * keeps its name. It reads the lane computers as last read (no read of its
 * own) and the machine's binding from the cross-machine lanes it already
 * has, so it costs nothing per render beyond a lookup.
 */
export function useAdeCloudMachineLabel(): (machine: { machineId?: string | null; binding?: OpenProjectBinding | null; name: string }) => string {
  const { computers } = useAdeCloudLaneComputers();
  const bindings = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  return useCallback((machine) => {
    if (!computers.length) return machine.name;
    const binding = machine.binding ?? (machine.machineId ? bindings[machine.machineId]?.binding ?? null : null);
    const hostname = binding?.kind === "remote" ? binding.hostname ?? null : null;
    const computer = adeCloudLaneComputerForMachine({ hostname, machineKey: machine.machineId ?? null }, computers);
    return computer ? adeCloudLaneLabel(computer.laneName) : machine.name;
  }, [bindings, computers]);
}
