import React from "react";
import { UsersThree } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { laneShareInviteExpired } from "../laneShareModel";
import { LANE_SHARE_GUEST_ROUTE } from "./laneShareGuestRoute";
import { activeLaneShares, loadLaneShareReceived, useLaneShareGuestStore } from "./laneShareGuestStore";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The Home page's way back to lanes other accounts share with this one: a
 * footer line in the Projects card, shown only when there is an accepted
 * share or an open invite. A guest with no machine and no project has no
 * Work sidebar, so without it the shared lanes are reachable only from the
 * invite email. Reads the received list once (cached for minutes).
 */
export function LaneShareHomeFoot() {
  const navigate = useNavigate();
  const received = useLaneShareGuestStore((state) => state.received);
  React.useEffect(() => {
    void loadLaneShareReceived();
  }, []);
  const active = activeLaneShares(received).length;
  const invites = (received ?? []).filter((entry) => entry.state === "pending" && !laneShareInviteExpired(entry)).length;
  if (active === 0 && invites === 0) return null;
  const parts = [
    active > 0 ? plural(active, "lane shared with you", "lanes shared with you") : null,
    invites > 0 ? plural(invites, "invite", "invites") : null,
  ].filter(Boolean);
  return (
    <div className="ade-home-look-foot ade-home-shared-foot" data-testid="home-shared-lanes">
      <span className="ade-home-shared-foot-text">
        <UsersThree size={13} aria-hidden />
        {parts.join(", ")}
      </span>
      <button type="button" className="kit-btn" onClick={() => navigate(LANE_SHARE_GUEST_ROUTE)}>
        Open
      </button>
    </div>
  );
}
