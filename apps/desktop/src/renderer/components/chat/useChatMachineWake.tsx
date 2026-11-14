import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../../shared/wokenMachine";
import { savedChatComputerGone } from "../../state/cloudSavedChats";
import { cloudComputerResting, useCloudComputer } from "../remoteTargets/useCloudComputer";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { useCloudMachineWakeInFlight } from "../../lib/cloudMachineWake";
import { Banner } from "../ui/notice";

export type ChatMachineWake = {
  /** The chat's machine is an ADE Cloud computer that is asleep, stopped, or coming up. */
  resting: boolean;
  /** The chat's machine was an ADE Cloud computer that has been deleted. */
  gone: boolean;
  /** A wake from here is under way: the connect, then the wait to read online. */
  waking: boolean;
  /** Why the last wake failed, as one sentence, or null. */
  error: string | null;
  /**
   * Wakes the chat's machine and connects it: the person's own Connect, so a
   * sleeping cloud computer wakes (`remoteConnectionService` wakes on an
   * explicit connect). True once the scope reads online. False, with `error`
   * set, when the connect fails, another wake already runs, or the machine
   * does not read online within `WOKEN_MACHINE_CONNECT_WAIT_MS`: the caller's
   * control comes back.
   */
  wake: () => Promise<boolean>;
  /** `wake()`, then `run` once the machine reads online. Resolves as `wake()` does. */
  wakeThen: (run: () => void) => Promise<boolean>;
};

const NOT_RESTING: ChatMachineWake = {
  resting: false,
  gone: false,
  waking: false,
  error: null,
  wake: async () => false,
  wakeThen: async () => false,
};

/** Why a cloud computer can't show a proof right now: asleep, waking from here, or deleted. */
export type ChatMachineReach = "asleep" | "waking" | "gone";

/** The chat's machine as a notice words it; null when it is not a sleeping or deleted cloud computer. */
export function chatMachineReach(machine: Pick<ChatMachineWake, "gone" | "waking" | "resting">): ChatMachineReach | null {
  if (machine.gone) return "gone";
  if (machine.waking) return "waking";
  return machine.resting ? "asleep" : null;
}

/** One sentence for a picture, video or proof on a cloud computer that is asleep, waking or deleted. */
export function chatMachineMediaSentence(reach: ChatMachineReach, noun: string, machineName: string, wakeError?: string | null): string {
  switch (reach) {
    case "asleep":
      return `This ${noun} is on ${machineName}, which is asleep.${wakeError ? ` ${wakeError}` : ""}`;
    case "waking":
      return `Waking ${machineName} to show this ${noun}…`;
    case "gone":
      return `This ${noun} was on ${machineName}, which was deleted, so it can't be shown.`;
  }
}

const ChatMachineWakeContext = createContext<ChatMachineWake | null>(null);

/**
 * Whether the chat's machine is only asleep (a person's click may wake it) or
 * gone, as opposed to unreachable, worked out once for the chat: the proof
 * tiles, code blocks and model chips of a transcript read it from here. A
 * machine that is online reads `resting: false, gone: false` and nothing is
 * read for it. While it is offline, the computer list is watched once for
 * the chat; once the list says the machine is not a cloud computer, it is
 * not watched again for that machine.
 *
 * The wake is the explicit connect of the chat's own machine (the scope's
 * binding: the pin, or the tab's binding for an unpinned chat), never the
 * tab's machine in its place. One wake runs at a time for the chat.
 */
export function ChatMachineWakeProvider({ children }: { children: ReactNode }) {
  const scope = useChatRuntimeScope();
  const offline = scope.isRemote && !scope.online;
  // Non-reactive, as the composer reads it: it changes with the saved-chat
  // sync, which re-renders the chat anyway.
  const gone = offline && scope.sessionId != null && savedChatComputerGone(scope.pin, scope.sessionId);
  const targetId = scope.binding?.kind === "remote" ? scope.binding.targetId : null;
  // The target the list said is no cloud computer: not watched again.
  const [notCloudTargetId, setNotCloudTargetId] = useState<string | null>(null);
  const { box, known, refresh } = useCloudComputer(scope.binding, offline && !gone && targetId !== notCloudTargetId);
  useEffect(() => {
    if (known && !box && targetId) setNotCloudTargetId(targetId);
  }, [box, known, targetId]);
  const resting = offline && !gone && cloudComputerResting(box);
  // Both stamped with the target they are for: the single-chat view keeps
  // this provider mounted across chats, and another machine's chat must not
  // show this machine's wake or its late failure.
  const [wakingTargetId, setWakingTargetId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ targetId: string; message: string } | null>(null);
  // Opening the chat from a list wakes its computer (`wakeRestingCloudMachine`);
  // the computer reads "starting" while any wake runs. Either is this chat's
  // wake too, so the view shows the progress.
  const listWaking = useCloudMachineWakeInFlight(box?.machineKey ?? null);
  const waking = (targetId != null && wakingTargetId === targetId)
    || (resting && (listWaking || box?.state === "starting"));
  const error = failure && failure.targetId === targetId ? failure.message : null;
  const machineName = scope.machineName;
  // `scope.online` follows the connection snapshot: main pushes
  // `onConnectionSnapshotChanged` once the connect succeeds, and
  // `crossMachineLanes.ts` (`applySnapshot` → `applyReachability`) sets the
  // machine's entry online, which the scope reads. A wake waits for that.
  const onlineRef = useRef(scope.online);
  onlineRef.current = scope.online;
  const targetRef = useRef(targetId);
  targetRef.current = targetId;
  const pendingRef = useRef<{ resolve: (online: boolean) => void; timer: number } | null>(null);
  // From the click to the end of the wait: a second click on the same machine
  // meanwhile starts nothing.
  const inFlightTargetRef = useRef<string | null>(null);

  const settle = useCallback((online: boolean) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    window.clearTimeout(pending.timer);
    pending.resolve(online);
  }, []);

  useEffect(() => {
    if (scope.online) settle(true);
  }, [scope.online, settle]);
  // A chat that closes, or a switch to another machine's chat, drops the wait:
  // the cleanup runs before the effect above reads the new chat's `online`.
  useEffect(() => () => settle(false), [settle, targetId]);

  const wake = useCallback(async (): Promise<boolean> => {
    const connect = window.ade?.remoteRuntime?.connect;
    if (!targetId || !connect || inFlightTargetRef.current === targetId) return false;
    inFlightTargetRef.current = targetId;
    const fail = (message: string) => setFailure({ targetId, message });
    try {
      setWakingTargetId(targetId);
      setFailure(null);
      try {
        await connect(targetId);
      } catch (connectFailure) {
        console.warn("[cloud] waking the chat's machine failed", connectFailure);
        fail(`ADE couldn't wake ${machineName}. Try again.`);
        refresh();
        return false;
      }
      refresh();
      // The person opened another machine's chat meanwhile: its `online` is not this wake's.
      if (targetRef.current !== targetId) return false;
      if (onlineRef.current) return true;
      // One timer for this click, not a poll: the snapshot settles it sooner.
      return await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
          fail(`${machineName} didn't come back online in time. Try again.`);
          settle(false);
        }, WOKEN_MACHINE_CONNECT_WAIT_MS);
        pendingRef.current = { resolve, timer };
      });
    } finally {
      if (inFlightTargetRef.current === targetId) inFlightTargetRef.current = null;
      setWakingTargetId((current) => (current === targetId ? null : current));
    }
  }, [machineName, refresh, settle, targetId]);

  const wakeThen = useCallback(async (run: () => void): Promise<boolean> => {
    const online = await wake();
    if (online) run();
    return online;
  }, [wake]);

  const value = useMemo<ChatMachineWake>(
    () => ({ resting, gone, waking, error, wake, wakeThen }),
    [error, gone, resting, wake, wakeThen, waking],
  );
  return <ChatMachineWakeContext.Provider value={value}>{children}</ChatMachineWakeContext.Provider>;
}

/** The chat's machine as `ChatMachineWakeProvider` found it; outside a chat, never resting. */
export function useChatMachineWake(): ChatMachineWake {
  return useContext(ChatMachineWakeContext) ?? NOT_RESTING;
}

/**
 * The opened chat's own progress line while its ADE Cloud computer wakes, and
 * why the last wake failed. Nothing for a machine that is up or not a cloud
 * computer. The list row stays as it is; the progress lives here.
 */
export function ChatMachineWakeBanner({ style }: { style?: CSSProperties }) {
  const machine = useChatMachineWake();
  const scope = useChatRuntimeScope();
  if (machine.gone || !machine.resting) return null;
  if (machine.waking) {
    return (
      <Banner
        layout="inline"
        style={style}
        model={{ id: "chat-machine-waking", tone: "info", busy: true, title: `Waking ${scope.machineName}…` }}
      />
    );
  }
  if (!machine.error) return null;
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "chat-machine-wake-failed",
        tone: "error",
        title: machine.error,
        report: false,
        actions: [{ label: "Try again", onClick: () => void machine.wake() }],
      }}
    />
  );
}
