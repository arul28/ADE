import { useMemo } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { stopSharingLaneWithAll } from "./laneShareActions";
import { isLiveLaneShare } from "./laneShareModel";
import { openLaneShareSheet, useLaneShareList } from "./laneShareStore";

/** The share entries a lane menu offers (`buildLaneMenuGroups`' `share`). */
export type LaneMenuShareArgs = {
  /** Live shares (pending and active) of the lane. */
  liveCount: number;
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
}): LaneMenuShareArgs | null {
  const { key, entry } = useLaneShareList(args.pin, { enabled: !args.disabled && Boolean(args.laneId) });
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
      onShare: () => open(null),
      onManage: () => open(live[0]?.grantId ?? null),
      onStopAll: () => { void stopSharingLaneWithAll({ laneName, shares: live, pin, listKey: key }); },
    };
    // `pin` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.disabled, args.laneId, args.laneName, args.machineName, key, pinKey, shares]);
}
