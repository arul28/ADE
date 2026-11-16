import { CircleNotch } from "@phosphor-icons/react";
import { COLORS } from "./laneDesignTokens";
import {
  restingCloudMachineKey,
  useCloudMachineWakeInFlight,
  wakeRestingCloudMachine,
  type RestingCloudMachine,
} from "../../lib/cloudMachineWake";

/**
 * The opened lane of an ADE Cloud computer that is asleep. Opening the lane
 * started the wake (`selectLane`); this view shows the progress, and offers
 * the wake again when it ended without the computer coming up.
 */
export function RestingCloudLaneDetail({ laneName, machine }: { laneName: string; machine: RestingCloudMachine }) {
  const waking = useCloudMachineWakeInFlight(restingCloudMachineKey(machine));
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      data-testid="lane-detail-cloud-waking"
    >
      <div className="text-[13px] font-medium" style={{ color: COLORS.textPrimary }}>{laneName}</div>
      {waking ? (
        <div className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: COLORS.textMuted }}>
          <CircleNotch size={12} className="animate-spin" />
          Waking {machine.machineName}…
        </div>
      ) : (
        <>
          <div className="text-[12px]" style={{ color: COLORS.textMuted }}>
            {machine.machineName} is asleep. The lane opens when it wakes.
          </div>
          <button
            type="button"
            className="rounded-md border border-border/60 px-2.5 py-1 text-[12px] text-fg/85 hover:bg-fg/[0.05]"
            onClick={() => wakeRestingCloudMachine(machine)}
          >
            Wake {machine.machineName}
          </button>
        </>
      )}
    </div>
  );
}
