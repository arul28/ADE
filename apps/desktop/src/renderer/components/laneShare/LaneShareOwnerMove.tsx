import React from "react";
import { ArrowsLeftRight } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { laneShareRiskLevel, type LaneShareRights } from "../../../shared/laneShareRights";
import { LANE_SHARE_MOVE_FINAL_STAGES, type LaneShareMoveView } from "../../../shared/laneShareMove";
import { parseCodedErrorMessage } from "../../../shared/codedError";
import { Banner } from "../ui/notice";
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { LaneShareRightsPanel } from "./LaneShareRightsPanel";
import { confirmHighRiskShare } from "./laneShareDefaults";
import { useLaneShareList } from "./laneShareStore";

/**
 * The owner's side of moving a chat between the two people of a share. All
 * calls go to the shared lane's machine (the chat's pin), where the moves
 * live. Nothing loads for a lane with no accepted share.
 */

const EXPIRY_CHECK_MS = 30_000;

export function laneShareGuestShortName(email: string | null): string {
  if (!email) return "the guest";
  const local = email.split("@")[0] ?? email;
  return local.length > 24 ? `${local.slice(0, 23)}…` : local;
}

/** Accepted shares of a lane on this machine: the people a chat can move to. */
export function useMovableLaneShares(pin: OpenProjectBinding | null, laneId: string | null): LaneShareGivenEntry[] {
  const { entry } = useLaneShareList(pin, { enabled: Boolean(laneId) });
  const shares = entry?.shares;
  return React.useMemo(
    () => (laneId ? (shares ?? []).filter((share) => share.laneId === laneId && share.state === "active" && share.local && share.rights) : []),
    [laneId, shares],
  );
}

/** Asks, then starts "Move to <guest>'s computer" for one chat. */
export async function startLaneShareMove(args: { pin: OpenProjectBinding | null; share: LaneShareGivenEntry; sessionId: string }): Promise<void> {
  const who = laneShareGuestShortName(args.share.receiverEmail);
  const ok = await confirmDialog({
    title: `Move this chat to ${who}'s computer?`,
    message: [
      `${who} picks one of their computers and accepts within 15 minutes. Nothing moves before that.`,
      "The chat's brief and its unpushed work go into a new lane there. None of your sign-ins, keys or provider sessions move.",
      `Your account email goes to ${who}, so their new lane can be shared back to you.`,
    ].join(" "),
    confirmLabel: "Ask to move",
  });
  if (!ok) return;
  try {
    await window.ade.laneShare.move("moveStart", { grantId: args.share.grantId, sessionId: args.sessionId }, args.pin);
  } catch (error) {
    showToast({ tone: "error", title: "Couldn't start the move", message: parseCodedErrorMessage(error).message, report: false });
  }
}

const STAGE_TEXT: Partial<Record<LaneShareMoveView["stage"], string>> = {
  offered: "Waiting for them to accept",
  accepted: "Accepted. Getting ready…",
  packing: "Packing the work…",
  ready: "Copying the work to their computer…",
  landing: "Making the new lane…",
};

/**
 * The composer card of the shared lane's chats: a guest's request to move
 * work here (Accept, with the share back rights), and the state of moves
 * of this chat to a guest.
 */
export const LaneShareOwnerMoveCard = React.memo(function LaneShareOwnerMoveCard({
  pin,
  laneId,
  sessionId,
  style,
}: {
  pin: OpenProjectBinding | null;
  laneId: string | null;
  sessionId: string;
  style?: React.CSSProperties;
}) {
  const shares = useMovableLaneShares(pin, laneId);
  const enabled = shares.length > 0;
  const pinKey = pin?.key ?? null;
  const [moves, setMoves] = React.useState<LaneShareMoveView[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(() => new Set());
  const pinRef = React.useRef(pin);
  pinRef.current = pin;

  const reload = React.useCallback(async () => {
    try {
      const result = await window.ade.laneShare.move<{ moves?: LaneShareMoveView[] }>("moveList", {}, pinRef.current);
      setMoves(Array.isArray(result?.moves) ? result.moves : []);
    } catch {
      // An older host has no moves; nothing to show.
      setMoves([]);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      setMoves([]);
      return;
    }
    void reload();
    return window.ade.laneShare.onEvent((event) => {
      if (event.type === "lane_share_move_changed" && (!laneId || event.laneId === laneId)) void reload();
    }, pinRef.current);
  }, [enabled, laneId, pinKey, reload]);

  const live = moves.some((move) => !LANE_SHARE_MOVE_FINAL_STAGES.has(move.stage));
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { void reload(); }, EXPIRY_CHECK_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  if (!enabled) return null;
  const shown = moves.filter((move) =>
    move.laneId === laneId
    && !dismissed.has(move.moveId)
    && (move.direction === "to_owner" || move.sessionId === sessionId));
  if (shown.length === 0) return null;
  const dismiss = (moveId: string) => setDismissed((current) => new Set(current).add(moveId));
  const guestOf = (grantId: string) => laneShareGuestShortName(shares.find((share) => share.grantId === grantId)?.receiverEmail ?? null);

  return (
    <div className="flex flex-col gap-1.5" style={style} data-testid="lane-share-owner-move-card">
      {shown.map((move) => move.direction === "to_owner" && move.stage === "offered" ? (
        <OwnerConsent key={move.moveId} move={move} pin={pin} guestEmail={shares.find((share) => share.grantId === move.grantId)?.receiverEmail ?? null} onChanged={reload} />
      ) : (
        <OwnerMoveStatus key={move.moveId} move={move} pin={pin} who={move.starterName ?? guestOf(move.grantId)} onDismiss={() => dismiss(move.moveId)} onChanged={reload} />
      ))}
    </div>
  );
});

function OwnerMoveStatus({
  move,
  pin,
  who,
  onDismiss,
  onChanged,
}: {
  move: LaneShareMoveView;
  pin: OpenProjectBinding | null;
  who: string;
  onDismiss: () => void;
  onChanged: () => Promise<void>;
}) {
  const final = LANE_SHARE_MOVE_FINAL_STAGES.has(move.stage);
  const toGuest = move.direction === "to_guest";
  const title = final
    ? move.stage === "done"
      ? toGuest
        ? `Moved to ${who}'s computer${move.result?.laneName ? ` as the lane “${move.result.laneName}”` : ""}.`
        : `${who}'s work is in the new lane “${move.result?.laneName ?? move.laneName ?? ""}”.`
      : move.stage === "declined"
        ? toGuest ? `${who} declined the move.` : "You declined the move."
        : move.error ?? "The move ended."
    : toGuest
      ? `Move to ${who}'s computer: ${STAGE_TEXT[move.stage] ?? move.stage}`
      : `${who}'s move to this computer: ${move.stage === "landing" ? "making the new lane…" : "copying the work…"}`;
  const cancel = async () => {
    try {
      await window.ade.laneShare.move("moveCancel", { moveId: move.moveId }, pin);
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't cancel the move", message: parseCodedErrorMessage(error).message, report: false });
    }
    await onChanged();
  };
  return (
    <Banner
      layout="inline"
      model={{
        id: `lane-share-owner-move-${move.moveId}`,
        tone: final ? (move.stage === "done" ? "success" : "neutral") : "info",
        title,
        report: false,
        actions: final ? [] : [{ label: "Cancel", onClick: () => { void cancel(); } }],
        ...(final ? { dismiss: { onDismiss } } : {}),
      }}
    />
  );
}

function OwnerConsent({
  move,
  pin,
  guestEmail,
  onChanged,
}: {
  move: LaneShareMoveView;
  pin: OpenProjectBinding | null;
  guestEmail: string | null;
  onChanged: () => Promise<void>;
}) {
  const who = move.starterName ?? laneShareGuestShortName(guestEmail);
  const [rights, setRights] = React.useState<LaneShareRights | null>(move.rights);
  const [endsAt, setEndsAt] = React.useState<number | null>(null);
  const [editRights, setEditRights] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const respond = async (accept: boolean) => {
    if (busy) return;
    const high = accept && rights ? laneShareRiskLevel(rights).level === "high" : false;
    if (high && rights && !(await confirmHighRiskShare(guestEmail ?? who, rights))) return;
    setBusy(true);
    try {
      await window.ade.laneShare.move("moveRespond", {
        moveId: move.moveId,
        accept,
        ...(accept && rights ? { rights, endsAt, confirmHighRisk: high } : {}),
      }, pin);
    } catch (error) {
      showToast({ tone: "error", title: accept ? "Couldn't accept the move" : "Couldn't decline the move", message: parseCodedErrorMessage(error).message, report: false });
    } finally {
      setBusy(false);
    }
    await onChanged();
  };
  const minutes = Math.max(1, Math.ceil((move.expiresAt - Date.now()) / 60_000));
  return (
    <div className="kit-panel flex min-w-0 flex-col gap-2 p-3" data-testid="lane-share-owner-move-consent">
      <div className="flex min-w-0 items-center gap-2">
        <ArrowsLeftRight size={14} className="shrink-0 text-fg/60" aria-hidden />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-fg/85">
          {who} wants to move {move.chatTitle ? `“${move.chatTitle}”` : "a chat"} to this computer
        </span>
        <span className="shrink-0 text-[11px] text-fg/50">Ends in {minutes} min</span>
      </div>
      <span className="text-[12px] leading-[1.45] text-fg/65">
        The work of {move.branchName ? <code className="font-mono">{move.branchName}</code> : "their branch"} goes into a new lane
        {move.laneName ? ` “${move.laneName}”` : ""} here, never into this shared lane. The chat continues with this computer's sign-ins. Git hooks of the arriving work do not run.
        The new lane is shared back with {who}.
      </span>
      {rights ? (
        <div className="flex flex-col gap-1.5">
          <button type="button" className="self-start text-[11.5px] text-fg/60 underline-offset-2 hover:underline" onClick={() => setEditRights((open) => !open)}>
            {editRights ? "Hide the rights of the share back" : `Share back with ${who}: the same rights (change)`}
          </button>
          {editRights ? <LaneShareRightsPanel rights={rights} endsAt={endsAt} onChange={setRights} onEndsAtChange={setEndsAt} now={Date.now()} /> : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy} onClick={() => { void respond(true); }}>Accept</button>
        <button type="button" className="kit-btn" data-size="sm" disabled={busy} onClick={() => { void respond(false); }}>Decline</button>
      </div>
    </div>
  );
}
