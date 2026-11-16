import React from "react";
import { UsersThree } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { laneShareInviteExpired } from "../laneShareModel";
import { LaneShareState } from "../laneShareUi";
import { LANE_SHARE_GUEST_ROUTE, laneShareGuestPath } from "./laneShareGuestRoute";
import { loadLaneShareReceived, useLaneShareGuestStore } from "./laneShareGuestStore";

const MAX_ROWS = 4;

/**
 * Lanes other accounts share with this one, and open invites, newest
 * invites first. Reads the received list once (cached for minutes).
 */
export function useLaneShareHomeRows(): LaneShareReceivedEntry[] {
  const received = useLaneShareGuestStore((state) => state.received);
  React.useEffect(() => {
    void loadLaneShareReceived();
  }, []);
  return React.useMemo(() => {
    const rows = received ?? [];
    const invites = rows.filter((entry) => entry.state === "pending" && !laneShareInviteExpired(entry));
    const active = rows.filter((entry) => entry.state === "active");
    return [...invites, ...active];
  }, [received]);
}

/**
 * The Home page's "Shared with you" list, inside the Projects card: each row
 * opens the lane (an invite opens it with its one Accept). A guest with no
 * machine and no project has no Work sidebar, so this is its way in besides
 * the invite email. Renders nothing without a share or an invite.
 */
export function LaneShareHomeRows({ rows }: { rows: readonly LaneShareReceivedEntry[] }) {
  const navigate = useNavigate();
  if (rows.length === 0) return null;
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="ade-home-shared" data-testid="home-shared-lanes">
      <div className="ade-home-shared-head">
        <span>Shared with you</span>
        {rows.length > MAX_ROWS ? (
          <button type="button" className="kit-card-head-action" onClick={() => navigate(LANE_SHARE_GUEST_ROUTE)}>
            All {rows.length}
          </button>
        ) : null}
      </div>
      {shown.map((entry) => {
        const invite = entry.state === "pending";
        const from = entry.giverLabel ?? "another account";
        return (
          <button
            key={entry.grantId}
            type="button"
            className="ade-home-shared-row"
            onClick={() => navigate(laneShareGuestPath(entry.grantId))}
          >
            <UsersThree size={14} aria-hidden className="ade-home-shared-icon" />
            <span className="ade-home-shared-text">
              <span className="ade-home-shared-name">{entry.laneLabel ?? "Shared lane"}</span>
              <span className="ade-home-shared-sub">
                {invite ? `${from} invited you` : `From ${from}`}
                {entry.projectLabel ? ` in ${entry.projectLabel}` : ""}
              </span>
            </span>
            {invite ? <LaneShareState label="New" tone="ok" /> : null}
          </button>
        );
      })}
    </div>
  );
}
