import React from "react";
import { UsersThree } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { StatusChip } from "../ui/notice";
import { isLiveLaneShare } from "./laneShareModel";
import { openLaneShareSheet, useLaneShareList } from "./laneShareStore";
import { startLaneShareMove } from "./LaneShareOwnerMove";

function personLabel(email: string | null): string {
  if (!email) return "a guest";
  const local = email.split("@")[0] ?? email;
  return local.length > 24 ? `${local.slice(0, 23)}…` : local;
}

/**
 * The owner's composer line on a shared lane's chat: who has access, and who
 * is connected now. Reads the lane machine's cached share list (the chat's
 * pin), so a chat in an unshared lane renders nothing and loads nothing new.
 * "Here now" means the guest's device is connected to this lane's machine; the
 * host knows no finer presence (which chat they look at).
 */
export const LaneShareComposerChip = React.memo(function LaneShareComposerChip({
  pin,
  laneId,
  laneName,
  sessionId = null,
}: {
  pin: OpenProjectBinding | null;
  laneId: string | null;
  laneName: string | null;
  /** The open chat: "Move to <guest>'s computer" moves it. */
  sessionId?: string | null;
}) {
  const { key, entry, pin: listPin } = useLaneShareList(pin, { enabled: Boolean(laneId) });
  const shares = entry?.shares;
  const live = React.useMemo(
    () => (laneId ? (shares ?? []).filter((share) => share.laneId === laneId && isLiveLaneShare(share)) : []),
    [laneId, shares],
  );
  if (!laneId || !key || live.length === 0) return null;
  const names = live.map((share) => personLabel(share.receiverEmail));
  const here = live.filter((share) => share.connectedDevices > 0).map((share) => personLabel(share.receiverEmail));
  const shown = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
  const tooltip = [
    `Shared with ${live.map((share) => share.receiverEmail ?? "a guest").join(", ")}`,
    here.length > 0 ? `Connected now: ${here.join(", ")}` : "Nobody is connected now",
  ].join(". ");
  return (
    <StatusChip
      tone="neutral"
      icon={<UsersThree size={10} weight="bold" />}
      label={`Shared with ${shown}`}
      detail={here.length > 0 ? `${here.join(", ")} here now` : undefined}
      tooltip={tooltip}
      testId="chat-lane-share-chip"
      actions={[
        {
          label: "Manage",
          onClick: () => openLaneShareSheet({
            listKey: key,
            laneId,
            laneName: laneName?.trim() || "this lane",
            pin: listPin,
            machineName: pin?.kind === "remote" ? pin.runtimeName : null,
            grantId: live[0]?.grantId ?? null,
          }),
        },
        // An accepted share of this machine: the open chat can move to that person.
        ...(sessionId
          ? live
              .filter((share) => share.state === "active" && share.local && share.rights)
              .slice(0, 2)
              .map((share) => ({
                label: `Move to ${personLabel(share.receiverEmail)}'s computer`,
                onClick: () => { void startLaneShareMove({ pin: listPin, share, sessionId }); },
              }))
          : []),
      ]}
    />
  );
});
