import React from "react";
import { ArrowSquareOut, UsersThree } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { NoticePopover } from "../ui/notice/NoticePopover";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { cn } from "../ui/cn";
import { formatLaneShareEnd, isLiveLaneShare, laneShareAccessText } from "./laneShareModel";
import { laneShareGuestShortName, startLaneShareMove } from "./LaneShareOwnerMove";
import { openLaneShareSheet, useLaneShareList } from "./laneShareStore";
import { LaneShareState } from "./laneShareUi";

/**
 * The owner's share icon in a shared lane's chat header. It shows only while
 * the lane has a pending or active share, and is filled while a guest is
 * connected. It opens a small panel: who has access, what they can do, and
 * "Manage sharing". It reads the lane machine's cached share list (the
 * chat's pin), so a chat in an unshared lane renders nothing.
 */
export const LaneShareHeaderButton = React.memo(function LaneShareHeaderButton({
  pin,
  laneId,
  laneName,
  sessionId = null,
}: {
  pin: OpenProjectBinding | null;
  laneId: string | null;
  laneName: string | null;
  /** The open chat: an accepted guest's row offers to move it to them. */
  sessionId?: string | null;
}) {
  const { key, entry, pin: listPin } = useLaneShareList(pin, { enabled: Boolean(laneId) });
  const [open, setOpen] = React.useState(false);
  const shares = entry?.shares;
  const live = React.useMemo(
    () => (laneId ? (shares ?? []).filter((share) => share.laneId === laneId && isLiveLaneShare(share)) : []),
    [laneId, shares],
  );
  if (!laneId || !key || live.length === 0) return null;
  const here = live.some((share) => share.connectedDevices > 0);
  const name = laneName?.trim() || "this lane";
  const title = live.length === 1
    ? `Shared with ${live[0]?.receiverEmail ?? "a guest"}`
    : `Shared with ${live.length} people`;
  const manage = (grantId: string | null) => {
    setOpen(false);
    openLaneShareSheet({
      listKey: key,
      laneId,
      laneName: name,
      pin: listPin,
      machineName: pin?.kind === "remote" ? pin.runtimeName : null,
      grantId,
    });
  };
  return (
    <NoticePopover
      open={open}
      onOpenChange={setOpen}
      width={300}
      cardProps={{ "data-testid": "lane-share-header-panel" }}
      trigger={(
        <button
          type="button"
          className={cn(WORK_HEADER_ICON_BUTTON_CLASS, "relative")}
          title={here ? `${title}. Connected now.` : title}
          aria-label={title}
          data-testid="lane-share-header-button"
        >
          <UsersThree size={16} weight={here ? "fill" : "bold"} />
          {here ? <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[color:var(--kit-ok)]" /> : null}
        </button>
      )}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-[12.5px] font-medium text-fg">Shared lane</span>
        <span className="shrink-0 text-[11px] text-fg/45">{live.length === 1 ? "1 person" : `${live.length} people`}</span>
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {live.map((share) => (
          <SharePersonRow
            key={share.grantId}
            share={share}
            onManage={() => manage(share.grantId)}
            onMove={sessionId && share.state === "active" && share.local && share.rights
              ? () => {
                  setOpen(false);
                  void startLaneShareMove({ pin: listPin, share, sessionId });
                }
              : null}
          />
        ))}
      </ul>
      <button
        type="button"
        className="kit-btn mt-1 w-full justify-center"
        onClick={() => manage(live[0]?.grantId ?? null)}
      >
        Manage sharing
      </button>
    </NoticePopover>
  );
});

function SharePersonRow({ share, onManage, onMove }: { share: LaneShareGivenEntry; onManage: () => void; onMove: (() => void) | null }) {
  const email = share.receiverEmail ?? "A guest";
  const left = share.usage?.messagesLeftToday;
  const facts = [
    share.state === "pending" ? "Invited, not accepted yet" : laneShareAccessText(share),
    left != null ? `${left} messages left today` : null,
    share.endsAt ? formatLaneShareEnd(share.endsAt) : null,
  ].filter(Boolean).join(". ");
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-fg/[0.04]">
      <button type="button" className="flex min-w-0 items-center justify-between gap-2 text-left" onClick={onManage} title={`Manage ${email}'s access`}>
        <span className="min-w-0 truncate text-[12.5px] text-fg">{email}</span>
        {share.connectedDevices > 0 ? <LaneShareState label="Here now" tone="ok" /> : null}
      </button>
      <span className="text-[11.5px] leading-snug text-fg/55">{facts}</span>
      {onMove ? (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 text-[11.5px] text-fg/60 hover:text-fg"
          title={`${laneShareGuestShortName(share.receiverEmail)} picks one of their computers and accepts within 15 minutes. Nothing moves before that.`}
          onClick={onMove}
        >
          <ArrowSquareOut size={12} />
          Move this chat to them…
        </button>
      ) : null}
    </li>
  );
}
