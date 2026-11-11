import React from "react";
import { ShareNetwork } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { laneShareMarkSummary, isLiveLaneShare } from "./laneShareModel";
import { openLaneShareSheet, useLaneShareList } from "./laneShareStore";

/**
 * The share mark of a lane card or lane header: shown only while the lane has
 * a pending or active share. It reads the machine's cached share list, so a
 * lane without a share costs nothing more. A click opens "Manage sharing".
 */
export const LaneShareMark = React.memo(function LaneShareMark({
  pin,
  laneId,
  laneName,
  size = 12,
}: {
  /** The lane's machine; null for the tab's own. */
  pin: OpenProjectBinding | null;
  laneId: string;
  laneName: string;
  size?: number;
}) {
  const { key, entry } = useLaneShareList(pin);
  const shares = entry?.shares;
  const summary = React.useMemo(() => laneShareMarkSummary(shares ?? [], laneId), [shares, laneId]);
  if (!summary || !key) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-fg/55 hover:bg-fg/[0.06] hover:text-fg/85"
      title={summary.label}
      aria-label={summary.label}
      data-testid="lane-share-mark"
      data-pending={summary.pending > 0 || undefined}
      onClick={(event) => {
        event.stopPropagation();
        const first = (shares ?? []).find((share) => share.laneId === laneId && isLiveLaneShare(share));
        openLaneShareSheet({
          listKey: key,
          laneId,
          laneName,
          pin,
          machineName: pin?.kind === "remote" ? pin.runtimeName : null,
          grantId: first?.grantId ?? null,
        });
      }}
    >
      <ShareNetwork size={size} weight={summary.present > 0 ? "fill" : "regular"} />
      {summary.live > 1 ? <span className="kit-num text-[10px] leading-none">{summary.live}</span> : null}
    </button>
  );
});
