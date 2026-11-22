import { useEffect, useMemo, useRef, useState } from "react";
import { hideAccountCloudLaunch, launchInProgress, launchesForOrigin, useAccountCloudLaunches } from "../../../state/accountCloudLaunches";
import { useAdeCloudLaneComputers } from "../../../state/adeCloudLaneIndex";
import { CloudSetupCardList, type LaunchChatState } from "../../projects/CloudSetupCard";
import { useTabCopyPin } from "../../../state/repositoryScope";
import { useRetainedCrossMachineSlices } from "../../../state/crossMachineLanes";
import type { OpenProjectBinding } from "../../../../shared/types/core";
import type { AgentChatSessionSummary } from "../../../../shared/types";
import { refreshCloudMachines } from "../../remoteTargets/useCloudMachines";
import { cn } from "../../ui/cn";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { workChatPath } from "../../../lib/workChatPath";
import { useNavigate } from "react-router-dom";
import { extractError } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { useOptionalWebWorkspace, useWebMachines } from "../../../webclient/workspace/WebWorkspaceContext";
import type { CloudLaunchRecord } from "../../../../shared/accountCloudLaunches";

function chatStateOfSummary(summary: AgentChatSessionSummary): LaunchChatState {
  if (summary.awaitingInput) return "waiting";
  return summary.status === "active" ? "working" : "done";
}

/**
 * The state of the started chats, each read from the computer it runs on: the
 * Work list's row of that chat names its computer (a new ADE Cloud computer,
 * not the one this tab is on); a chat with no row yet is asked on the tab's
 * computer. Read again when one of them changes.
 */
function useLaunchChatStates(sessionIds: readonly string[]): ReadonlyMap<string, LaunchChatState> {
  const tabPin = useTabCopyPin();
  const slices = useRetainedCrossMachineSlices();
  const targets = useMemo(() => {
    const byKey = new Map<string, { pin: OpenProjectBinding; sessionIds: string[] }>();
    for (const sessionId of [...sessionIds].sort()) {
      const pin = slices.find((slice) => slice.binding && slice.sessions.some((session) => session.id === sessionId))?.binding ?? tabPin;
      if (!pin) continue;
      const entry = byKey.get(pin.key) ?? { pin, sessionIds: [] };
      entry.sessionIds.push(sessionId);
      byKey.set(pin.key, entry);
    }
    return [...byKey.values()];
  }, [sessionIds, slices, tabPin]);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  // One read per chat and computer: a pin rebuilt with the same key reads nothing again.
  const targetsKey = targets.map((target) => `${target.pin.key}=${target.sessionIds.join(",")}`).join("\0");
  const [states, setStates] = useState<ReadonlyMap<string, LaunchChatState>>(() => new Map());
  useEffect(() => {
    const current = targetsRef.current;
    if (current.length === 0) {
      setStates(new Map());
      return;
    }
    let cancelled = false;
    const unsubscribes = current.map(({ pin, sessionIds: ids }) => {
      const read = (sessionId: string) => {
        void window.ade.agentChat.getSummary({ sessionId }, pin).then(
          (summary) => {
            if (cancelled) return;
            setStates((previous) => {
              const next = new Map(previous);
              if (summary) next.set(sessionId, chatStateOfSummary(summary));
              else next.delete(sessionId);
              return next;
            });
          },
          () => undefined,
        );
      };
      for (const id of ids) read(id);
      const watched = new Set(ids);
      // A turn's start, end or a question changes the state: read that chat again (once per burst).
      const queued = new Set<string>();
      return window.ade.agentChat.onEvent((envelope) => {
        if (!watched.has(envelope.sessionId) || queued.has(envelope.sessionId)) return;
        queued.add(envelope.sessionId);
        window.setTimeout(() => {
          queued.delete(envelope.sessionId);
          if (!cancelled) read(envelope.sessionId);
        }, 1_000);
      }, pin);
    });
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [targetsKey]);
  return states;
}

/** How many 5 s reads "Open chat" waits for a new computer to be listed before it gives up. */
const OPEN_CHAT_READS = 12;
/** How long "Open chat" waits for a just-connected computer's chat to be listed. */
const CONNECTED_CHAT_WAIT_MS = 15_000;

/**
 * ADE Web's chats on new ADE Cloud computers for this project, above the Work
 * composer: the same setup card as the project page (computer, clone,
 * sign-in, message), from the account server's launches. The web starts them
 * through the account server (`POST /cloud/launches`), not through a lane
 * launch in a brain, so the desktop's lane setup card does not apply.
 *
 * Shown: launches in progress, failed ones (for Retry), and the ones this tab
 * started, until the person hides a finished one (its chat is in the Work
 * list). Its own component, so the launch poll re-renders only the cards.
 */
export function WebCloudSetupCards({ originUrl, className }: { originUrl: string | null; className?: string }) {
  const { entries } = useAccountCloudLaunches();
  const cloudIndex = useAdeCloudLaneComputers();
  const shown = useMemo(() => {
    // A failed launch whose lane is on another computer now was replaced by a
    // later launch: it is no longer something to retry (a Retry would make the
    // lane a second computer).
    const replaced = (record: CloudLaunchRecord | null) => record?.state === "failed"
      && record.laneId != null
      && cloudIndex.computers.some((computer) => (
        computer.laneId === record.laneId && computer.instanceId !== record.instanceId && computer.state !== "deleting"
      ));
    return launchesForOrigin(entries, originUrl).filter((entry) => (
      entry.record?.state !== "cancelled"
      && !replaced(entry.record)
      && (launchInProgress(entry) || entry.startError != null || entry.record?.state === "failed" || entry.startedHere)
    ));
  }, [entries, originUrl, cloudIndex.computers]);
  const readySessionIds = useMemo(
    () => shown.flatMap((entry) => (entry.record?.sessionId ? [entry.record.sessionId] : [])),
    [shown],
  );
  const chatStates = useLaunchChatStates(readySessionIds);
  const workspace = useOptionalWebWorkspace();
  const navigate = useNavigate();
  const webMachines = useWebMachines();
  // "Open chat" on a launch whose computer this tab has not connected: connect it first, then open the chat.
  const [opening, setOpening] = useState<CloudLaunchRecord | null>(null);
  const machineOf = (record: CloudLaunchRecord) => {
    const machineKey = cloudIndex.computers.find((computer) => computer.instanceId === record.instanceId)?.machineKey?.toLowerCase();
    return machineKey ? webMachines.find((machine) => machine.accountMachine?.machineKey?.toLowerCase() === machineKey) ?? null : null;
  };
  const openingMachine = opening ? machineOf(opening) : null;
  const openingListed = openingMachine != null;
  const startedRef = useRef<string | null>(null);
  // The open the person chose last; an older connect that ends later, or one that ends after the cards unmount, opens nothing.
  const currentOpenRef = useRef<string | null>(null);
  useEffect(() => () => {
    currentOpenRef.current = null;
  }, []);
  useEffect(() => {
    if (!opening || !openingMachine || !workspace || startedRef.current === opening.launchId) return;
    startedRef.current = opening.launchId;
    const record = opening;
    void workspace.connectMachineEntry(openingMachine).then(
      () => {
        if (record.sessionId && currentOpenRef.current === record.launchId) {
          setConnectedChat({ launchId: record.launchId, sessionId: record.sessionId, laneId: record.laneId ?? null });
        }
      },
      (error: unknown) => showToast({ tone: "error", title: `Couldn't connect to ${openingMachine.name}`, message: extractError(error) }),
    ).finally(() => {
      startedRef.current = null;
      setOpening((current) => (current?.launchId === record.launchId ? null : current));
    });
  }, [opening, openingMachine, workspace]);
  // The computer is connected; its chats reach the Work list a moment later.
  // Work drops a chat it does not list from the address, so go there once
  // the chat is listed (or after a wait, if it never is).
  const [connectedChat, setConnectedChat] = useState<{ launchId: string; sessionId: string; laneId: string | null } | null>(null);
  const slices = useRetainedCrossMachineSlices();
  const connectedChatListed = connectedChat != null
    && slices.some((slice) => slice.sessions.some((session) => session.id === connectedChat.sessionId));
  useEffect(() => {
    if (!connectedChat) return;
    const go = () => {
      setConnectedChat(null);
      if (currentOpenRef.current === connectedChat.launchId) navigate(workChatPath(connectedChat.sessionId, connectedChat.laneId));
    };
    if (connectedChatListed) {
      go();
      return;
    }
    const timer = window.setTimeout(go, CONNECTED_CHAT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [connectedChat, connectedChatListed, navigate]);
  // A computer not listed yet: read the account's computers again every few seconds, then stop.
  useEffect(() => {
    if (!opening || openingListed) return;
    refreshCloudMachines();
    let reads = 0;
    const timer = window.setInterval(() => {
      reads += 1;
      if (reads >= OPEN_CHAT_READS) {
        window.clearInterval(timer);
        setOpening(null);
        showToast({ tone: "error", title: "Couldn't open the chat yet", message: "Its ADE Cloud computer isn't listed yet. Try again in a moment." });
        return;
      }
      refreshCloudMachines();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [opening, openingListed]);
  const openLaunchChat = (record: CloudLaunchRecord) => {
    if (!record.sessionId) return;
    if (!workspace) {
      navigateToAppTarget({ kind: "chat", sessionId: record.sessionId, laneId: record.laneId ?? null });
      return;
    }
    currentOpenRef.current = record.launchId;
    setOpening(record);
  };
  if (shown.length === 0) return null;
  return (
    // Above the composer, inside its dock: several cards scroll on their own so none is cut off.
    // The bottom fades over the padding, so a list that scrolls never reads as running under the composer.
    <div
      className={cn(
        "flex max-h-[40vh] flex-col gap-2 overflow-y-auto pb-4 text-left [&>*]:shrink-0",
        "[mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]",
        className,
      )}
      data-testid="web-cloud-setup-cards"
    >
      <CloudSetupCardList
        entries={shown}
        onOpenChat={openLaunchChat}
        openingLaunchId={opening?.launchId ?? null}
        onHide={hideAccountCloudLaunch}
        compact
        chatStateOf={(record) => (record.sessionId ? chatStates.get(record.sessionId) ?? null : null)}
      />
    </div>
  );
}
