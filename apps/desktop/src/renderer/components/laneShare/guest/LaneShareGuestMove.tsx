import React from "react";
import { ArrowsLeftRight, FolderPlus } from "@phosphor-icons/react";
import type { OpenProjectBinding, RecentProjectSummary } from "../../../../shared/types";
import type { AgentChatSessionSummary } from "../../../../shared/types/chat";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { laneShareCliTypingFor, laneShareRiskLevel, type LaneShareCliTyping, type LaneShareGuestState, type LaneShareRights } from "../../../../shared/laneShareRights";
import { rendererRuntimeTarget } from "../../../lib/platform";
import { LANE_SHARE_MOVE_FINAL_STAGES, moveErrorText, type LaneShareMoveView } from "../../../../shared/laneShareMove";
import { remoteProjectBindingKey } from "../../../../shared/projectIdentity";
import { Banner } from "../../ui/notice";
import { showToast } from "../../app/toast/toastStore";
import { isWebClientMode } from "../../../lib/webClientMode";
import { useRemoteConnectionSnapshot } from "../../../state/projectMachines";
import { localProjectBindingForRoot } from "../../../state/appStore";
import { copyMachines, existingCopiesForRepo, repoKeyForUrl } from "../../projects/projectCopies";
import { LaneShareRightsPanel } from "../LaneShareRightsPanel";
import { confirmHighRiskShare } from "../laneShareDefaults";
import type { LaneShareGuestConnection } from "./laneShareGuestConnection";
import { receiveMoveHere, sendMoveToOwner, type LaneShareMoveProgress } from "./laneShareMoveRunner";

/**
 * The guest's side of moving a chat between the two people of a share.
 *
 * - `LaneShareGuestMoveCard`: the owner wants to move a chat to the guest
 *   (`to_guest`): pick one of the guest's own computers that has the
 *   project, set the rights of the share back, then Accept or Decline.
 *   Nothing moves before Accept.
 * - `LaneShareGuestMoveOut`: the guest moves a chat of one of its own
 *   computers to the owner (`to_owner`); the owner's Accept decides.
 *
 * The hosted web client has no computer of its own to receive into or pack
 * from, so both say to use the desktop app.
 */

/**
 * `cliTyping`: whether the destination can let the owner type into a CLI of
 * the new lane, which it shares back. Known for this computer only; null for
 * another (the switch stays on, and that machine's host still decides).
 */
type Destination = { machineId: string; name: string; pin: OpenProjectBinding; cliTyping: LaneShareCliTyping | null };

function repoUrlFromKey(repoKey: string | null): string | null {
  if (!repoKey) return null;
  const cleaned = repoKey.replace(/^repo:/, "").trim();
  if (!/^[a-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/i.test(cleaned)) return null;
  return `https://${cleaned}`;
}

/** The guest's own computers that are online and have a copy of the shared repository. */
function useMoveDestinations(repoKey: string | null, active: boolean): { destinations: Destination[]; loaded: boolean } {
  const { snapshot, loaded } = useRemoteConnectionSnapshot(active);
  const [recents, setRecents] = React.useState<RecentProjectSummary[] | null>(null);
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.ade.project.listRecent()
      .then((rows) => { if (!cancelled) setRecents(rows); })
      .catch(() => { if (!cancelled) setRecents([]); });
    return () => { cancelled = true; };
  }, [active]);
  const destinations = React.useMemo(() => {
    const key = repoKeyForUrl(repoUrlFromKey(repoKey));
    if (!key) return [];
    const copies = existingCopiesForRepo(key, { recents: recents ?? [], snapshot });
    const out: Destination[] = [];
    for (const machine of copyMachines(snapshot, { includeLocal: true })) {
      const copy = copies.get(machine.machineId);
      if (!copy || !machine.online) continue;
      if (machine.isLocal) {
        out.push({
          machineId: machine.machineId,
          name: machine.name,
          pin: localProjectBindingForRoot(copy.rootPath, copy.displayName),
          cliTyping: laneShareCliTypingFor(rendererRuntimeTarget().platform),
        });
        continue;
      }
      const connection = snapshot?.connections.find((entry) => entry.target.id === machine.targetId);
      if (!machine.targetId || !copy.projectId || !connection) continue;
      out.push({
        machineId: machine.machineId,
        name: machine.name,
        pin: {
          kind: "remote",
          key: remoteProjectBindingKey(machine.targetId, copy.projectId),
          targetId: machine.targetId,
          runtimeName: machine.name,
          ...(connection.target.transport ? { transport: connection.target.transport } : {}),
          hostname: connection.target.hostname,
          projectId: copy.projectId,
          rootPath: copy.rootPath,
          displayName: copy.displayName,
        },
        cliTyping: null,
      });
    }
    return out;
  }, [recents, repoKey, snapshot]);
  return { destinations, loaded: loaded && recents != null };
}

function DestinationPicker({
  destinations,
  value,
  onChange,
  disabled,
}: {
  destinations: Destination[];
  value: string;
  onChange: (machineId: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-fg/60">
      <span>Computer</span>
      <select
        className="kit-input max-w-[240px]" data-size="sm"
        value={value}
        aria-label="Computer"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {destinations.map((entry) => (
          <option key={entry.machineId} value={entry.machineId}>{entry.name} · {entry.pin.displayName}</option>
        ))}
      </select>
    </label>
  );
}

function ProgressLine({ progress }: { progress: LaneShareMoveProgress }) {
  const parts = progress.total ? ` ${Math.min(progress.done ?? 0, progress.total)} of ${progress.total} parts` : "";
  return <span className="text-[12px] text-fg/70">{progress.label}{parts}</span>;
}

function minutesLeft(expiresAt: number): string {
  const minutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  return minutes <= 1 ? "less than a minute" : `${minutes} minutes`;
}

/**
 * The consent card for `to_guest`, in the composer area of the shared lane.
 * Shown while the host reports the move, and with the outcome after.
 */
export function LaneShareGuestMoveCard({
  entry,
  connection,
  guestState,
  onAddProject,
}: {
  entry: LaneShareReceivedEntry;
  connection: LaneShareGuestConnection;
  guestState: LaneShareGuestState | null;
  onAddProject: () => void;
}) {
  const move: LaneShareMoveView | null = guestState?.move && guestState.move.direction === "to_guest" ? guestState.move : null;
  const webMode = isWebClientMode();
  const offered = move?.stage === "offered";
  const [running, setRunning] = React.useState<LaneShareMoveProgress | null>(null);
  const [outcome, setOutcome] = React.useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [editRights, setEditRights] = React.useState(false);
  const [rights, setRights] = React.useState<LaneShareRights | null>(move?.rights ?? null);
  const [endsAt, setEndsAt] = React.useState<number | null>(null);
  const [machineId, setMachineId] = React.useState("");
  const abortRef = React.useRef<AbortController | null>(null);
  const { destinations, loaded } = useMoveDestinations(entry.repoKey, Boolean(offered) && !webMode);
  const ownerLabel = entry.giverLabel ?? "The owner";

  React.useEffect(() => {
    setRights(move?.rights ?? null);
    setEditRights(false);
    setOutcome(null);
  }, [move?.moveId]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!destinations.some((entry) => entry.machineId === machineId)) setMachineId(destinations[0]?.machineId ?? "");
  }, [destinations, machineId]);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  if (!move || dismissed === move.moveId) return null;
  const chat = move.chatTitle ? `“${move.chatTitle}”` : "a chat";

  const decline = async () => {
    try {
      await connection.moveStep("decline", { moveId: move.moveId });
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't decline the move", message: moveErrorText(error) });
    }
  };

  const accept = async () => {
    const destination = destinations.find((entry) => entry.machineId === machineId);
    if (!destination || running) return;
    const shareRights = rights ?? move.rights;
    const high = shareRights ? laneShareRiskLevel(shareRights).level === "high" : false;
    if (shareRights && high && move.shareBackEmail && !(await confirmHighRiskShare(move.shareBackEmail, shareRights))) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setOutcome(null);
    setRunning({ label: "Starting…" });
    try {
      const result = await receiveMoveHere({
        connection,
        pin: destination.pin,
        signal: controller.signal,
        onProgress: setRunning,
        move,
        repoKey: entry.repoKey ?? "",
        modelHint: move.modelHint,
        fromName: entry.giverLabel,
        shareBack: shareRights && move.shareBackEmail
          ? { receiverEmail: move.shareBackEmail, rights: shareRights, confirmHighRisk: high, endsAt }
          : null,
      });
      const moved = `Moved to ${destination.name}${result.laneName ? ` as the lane “${result.laneName}”` : ""}. Open it there to continue.`;
      setOutcome({
        tone: result.warning ? "error" : result.note ? "warning" : "success",
        text: [moved, result.note, result.warning].filter(Boolean).join(" "),
      });
    } catch (error) {
      setOutcome({ tone: "error", text: moveErrorText(error) });
    } finally {
      abortRef.current = null;
      setRunning(null);
    }
  };

  const final = LANE_SHARE_MOVE_FINAL_STAGES.has(move.stage);
  return (
    <div className="kit-panel flex min-w-0 flex-col gap-2 p-3" data-testid="lane-share-guest-move-card">
      <div className="flex min-w-0 items-center gap-2">
        <ArrowsLeftRight size={14} className="shrink-0 text-fg/60" aria-hidden />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-fg/85">
          {offered ? `${ownerLabel} wants to move ${chat} to your computer` : `Move of ${chat} to your computer`}
        </span>
        {offered ? <span className="shrink-0 text-[11px] text-fg/50">Ends in {minutesLeft(move.expiresAt)}</span> : null}
      </div>
      {running ? (
        <div className="flex items-center gap-2">
          <ProgressLine progress={running} />
          <button type="button" className="kit-btn" data-size="sm" onClick={() => abortRef.current?.abort()}>Cancel</button>
        </div>
      ) : outcome ? (
        <Banner layout="inline" model={{ id: `lane-share-move-outcome-${move.moveId}`, tone: outcome.tone, title: outcome.text, ...(outcome.tone === "error" ? {} : { report: false as const }), dismiss: { onDismiss: () => setDismissed(move.moveId) } }} />
      ) : final ? (
        <Banner
          layout="inline"
          model={{
            id: `lane-share-move-final-${move.moveId}`,
            tone: move.stage === "done" ? "success" : "neutral",
            title: move.stage === "done" ? "The move finished." : move.stage === "declined" ? "You declined the move." : move.error ?? "The move ended.",
            report: false,
            dismiss: { onDismiss: () => setDismissed(move.moveId) },
          }}
        />
      ) : offered ? (
        webMode ? (
          <span className="text-[12px] text-fg/60">Open this shared lane in the ADE desktop app on one of your computers to accept. The work goes into a new lane there.</span>
        ) : (
          <>
            <span className="text-[12px] leading-[1.45] text-fg/65">
              The work goes into a new lane of your own copy of the project. The chat continues there with your own sign-ins. No sign-in of {ownerLabel} moves.
              {move.shareBackEmail
                ? ` After the move, the new lane is shared back with ${ownerLabel} at ${move.shareBackEmail}.`
                : " The new lane is not shared back."}
            </span>
            {!loaded ? (
              <span className="text-[12px] text-fg/50">Finding your computers…</span>
            ) : destinations.length === 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-fg/65">None of your connected computers has this project yet. Add it first, then accept.</span>
                <button type="button" className="kit-btn" data-size="sm" onClick={onAddProject}>
                  <FolderPlus size={13} />
                  Add this project
                </button>
              </div>
            ) : (
              <DestinationPicker destinations={destinations} value={machineId} onChange={setMachineId} />
            )}
            {rights ? (
              <div className="flex flex-col gap-1.5">
                <button type="button" className="self-start text-[11.5px] text-fg/60 underline-offset-2 hover:underline" onClick={() => setEditRights((open) => !open)}>
                  {editRights ? "Hide the rights of the share back" : `Share back with ${ownerLabel}: the same rights (change)`}
                </button>
                {editRights ? (
                  <LaneShareRightsPanel
                    rights={rights}
                    endsAt={endsAt}
                    onChange={setRights}
                    onEndsAtChange={setEndsAt}
                    now={Date.now()}
                    cliTyping={destinations.find((entry) => entry.machineId === machineId)?.cliTyping ?? null}
                  />
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={!machineId} onClick={() => { void accept(); }}>
                Accept
              </button>
              <button type="button" className="kit-btn" data-size="sm" onClick={() => { void decline(); }}>Decline</button>
            </div>
          </>
        )
      ) : (
        <span className="text-[12px] text-fg/60">The move is running on another of your devices.</span>
      )}
    </div>
  );
}

/**
 * The guest moves a chat of one of its own computers to the owner. Needs
 * Collaborate (send and start chats); the host checks it again.
 */
export function LaneShareGuestMoveOut({
  entry,
  connection,
  guestState,
  onClose,
}: {
  entry: LaneShareReceivedEntry;
  connection: LaneShareGuestConnection;
  guestState: LaneShareGuestState;
  onClose: () => void;
}) {
  const webMode = isWebClientMode();
  const { destinations, loaded } = useMoveDestinations(entry.repoKey, !webMode);
  const [machineId, setMachineId] = React.useState("");
  const [chats, setChats] = React.useState<AgentChatSessionSummary[] | null>(null);
  const [sessionId, setSessionId] = React.useState("");
  const [running, setRunning] = React.useState<LaneShareMoveProgress | null>(null);
  const [outcome, setOutcome] = React.useState<{ tone: "success" | "error"; text: string } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const ownerLabel = entry.giverLabel ?? "the owner";
  const destination = destinations.find((entry) => entry.machineId === machineId) ?? null;
  const pinKey = destination?.pin.key ?? null;

  React.useEffect(() => {
    if (!destinations.some((entry) => entry.machineId === machineId)) setMachineId(destinations[0]?.machineId ?? "");
  }, [destinations, machineId]);
  React.useEffect(() => {
    if (!destination) return;
    let cancelled = false;
    setChats(null);
    void window.ade.agentChat.list({}, destination.pin)
      .then((rows) => { if (!cancelled) setChats(rows); })
      .catch(() => { if (!cancelled) setChats([]); });
    return () => { cancelled = true; };
  }, [pinKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!chats?.some((chat) => chat.sessionId === sessionId)) setSessionId(chats?.[0]?.sessionId ?? "");
  }, [chats, sessionId]);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    if (!destination || !sessionId || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setOutcome(null);
    setRunning({ label: "Starting…" });
    try {
      const result = await sendMoveToOwner({
        connection,
        pin: destination.pin,
        signal: controller.signal,
        onProgress: setRunning,
        grantId: guestState.grantId,
        sessionId,
        ownerName: entry.giverLabel,
      });
      setOutcome({ tone: "success", text: `Moved to ${ownerLabel}'s computer${result.laneName ? ` as the lane “${result.laneName}”` : ""}.` });
    } catch (error) {
      setOutcome({ tone: "error", text: moveErrorText(error) });
    } finally {
      abortRef.current = null;
      setRunning(null);
    }
  };

  return (
    <div className="kit-panel flex max-w-[640px] flex-col gap-2 p-3" data-testid="lane-share-guest-move-out">
      <span className="text-[12.5px] font-medium text-fg/85">Move a chat to {ownerLabel}'s computer</span>
      {webMode ? (
        <span className="text-[12px] text-fg/60">Move a chat from the ADE desktop app on the computer that has it.</span>
      ) : (
        <>
          <span className="text-[12px] leading-[1.45] text-fg/65">
            The chat's work goes to a new lane on {ownerLabel}'s computer after they accept, and continues there with their sign-ins. None of yours move.
          </span>
          {!loaded ? (
            <span className="text-[12px] text-fg/50">Finding your computers…</span>
          ) : destinations.length === 0 ? (
            <span className="text-[12px] text-fg/60">None of your connected computers has this project.</span>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <DestinationPicker destinations={destinations} value={machineId} onChange={setMachineId} disabled={Boolean(running)} />
              <label className="flex items-center gap-1.5 text-[11.5px] text-fg/60">
                <span>Chat</span>
                <select
                  className="kit-input max-w-[260px]" data-size="sm"
                  value={sessionId}
                  aria-label="Chat"
                  disabled={Boolean(running) || !chats?.length}
                  onChange={(event) => setSessionId(event.target.value)}
                >
                  {(chats ?? []).map((chat) => <option key={chat.sessionId} value={chat.sessionId}>{chat.title?.trim() || "Untitled chat"}</option>)}
                </select>
              </label>
            </div>
          )}
          {running ? <ProgressLine progress={running} /> : null}
          {outcome ? <Banner layout="inline" model={{ id: "lane-share-move-out", tone: outcome.tone, title: outcome.text, ...(outcome.tone === "error" ? {} : { report: false as const }) }} /> : null}
        </>
      )}
      <div className="flex items-center gap-2">
        {!webMode ? (
          <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={!sessionId || Boolean(running)} onClick={() => { void start(); }}>
            Move
          </button>
        ) : null}
        <button type="button" className="kit-btn" data-size="sm" onClick={() => (running ? abortRef.current?.abort() : onClose())}>
          {running ? "Cancel" : "Close"}
        </button>
      </div>
    </div>
  );
}
