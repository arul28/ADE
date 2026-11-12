import { useMemo } from "react";
import type { LaneType, OpenProjectBinding } from "../../../shared/types";
import { useAdeCloudLaneForBinding } from "../../state/adeCloudLaneIndex";
import { stopSharingLaneWithAll } from "./laneShareActions";
import { isLiveLaneShare } from "./laneShareModel";
import { openLaneShareSheet, useLaneShareList } from "./laneShareStore";

/** The share entries a lane menu offers (`buildLaneMenuGroups`' `share`). */
export type LaneMenuShareArgs = {
  /** Live shares (pending and active) of the lane. */
  liveCount: number;
  /** Set when this lane cannot be shared: "Share lane…" shows disabled with this reason. */
  disabledReason: string | null;
  onShare: () => void;
  onManage: () => void;
  onStopAll: () => void;
};

/**
 * "Share lane…", "Manage sharing…" and "Stop sharing with all" for one lane.
 * `pin` is the lane's machine (null: the tab's). Reads the machine's cached
 * share list; it loads once per machine, not per lane.
 */
export function useLaneShareMenu(args: {
  laneId: string | null;
  laneName: string | null;
  pin: OpenProjectBinding | null | undefined;
  machineName?: string | null;
  /** A lane of the primary checkout or one being made cannot be shared yet. */
  disabled?: boolean;
  /** The lane's type: the main checkout (`primary`) cannot be shared. */
  laneType?: LaneType | null;
}): LaneMenuShareArgs | null {
  const { key, entry } = useLaneShareList(args.pin, { enabled: !args.disabled && Boolean(args.laneId) });
  // Sharing is for lanes on the person's own computers for now: a lane's ADE
  // Cloud computer would wake and spend the owner's hours for a guest.
  const onCloud = useAdeCloudLaneForBinding(args.pin ?? null) != null;
  const disabledReason = onCloud
    ? "Lanes on ADE Cloud can't be shared yet."
    : args.laneType === "primary"
      ? "The main checkout can't be shared. Share a lane instead."
      : null;
  const pin = args.pin ?? null;
  const pinKey = pin?.key ?? null;
  const shares = entry?.shares;
  return useMemo(() => {
    if (args.disabled || !args.laneId || !key) return null;
    const laneId = args.laneId;
    const laneName = args.laneName?.trim() || "this lane";
    const live = (shares ?? []).filter((share) => share.laneId === laneId && isLiveLaneShare(share));
    const open = (grantId?: string | null) => openLaneShareSheet({
      listKey: key,
      laneId,
      laneName,
      pin,
      machineName: args.machineName ?? (pin?.kind === "remote" ? pin.runtimeName : null),
      grantId: grantId ?? null,
    });
    return {
      liveCount: live.length,
      disabledReason,
      onShare: () => open(null),
      onManage: () => open(live[0]?.grantId ?? null),
      onStopAll: () => { void stopSharingLaneWithAll({ laneName, shares: live, pin, listKey: key }); },
    };
    // `pin` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.disabled, args.laneId, args.laneName, args.machineName, disabledReason, key, pinKey, shares]);
}
