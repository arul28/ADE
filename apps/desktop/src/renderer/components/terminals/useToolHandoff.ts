import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { AgentChatSteerResult } from "../../../shared/types/chat";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { cursorSessionRunsInCloud, supportsActiveTurnDispatchMode } from "../../../shared/types/chat";
import type { WorkSidebarTab } from "../../state/appStore";
import { providerFromChatToolType } from "../../lib/sessions";
import { showToast } from "../app/toast/toastStore";
import { withChatPin } from "../chat/chatMachinePin";
import { deviceSourceErrorText } from "./chatDeviceSources";
import { DEVICE_KINDS } from "./workToolCatalog";
import { toolNoun } from "./WorkToolPanelBar";
import type { CatalogCardView } from "./useWorkToolCatalog";
import type { ToolMachine } from "./useToolMachines";

/** A tool the person took over: which chat, which tool, that chat's machine, and whether the agent was told. */
type HeldTool = { sessionId: string; tool: WorkSidebarTab; noun: string; pin: OpenProjectBinding | null; told: boolean };

/**
 * Whether a person's note reaches this chat's agent while it works: its
 * provider joins a note to the live turn (`inline`), and a Cursor run is
 * local (a cloud run refuses every inline steer). A queue-only provider
 * (Qwen, Grok, Antigravity, Kimi, Droid, Pi, Devin) holds a note until the
 * turn ends, when it starts a turn of its own.
 */
function agentTakesNotesMidTurn(session: TerminalSessionSummary | null): boolean {
  const provider = session ? providerFromChatToolType(session.toolType) : null;
  if (!provider || !supportsActiveTurnDispatchMode(provider, "inline")) return false;
  return !cursorSessionRunsInCloud({
    provider,
    cursorRuntime: session?.cursorRuntime ?? null,
    cursorCloudAgentId: session?.cursorCloudAgentId ?? null,
  });
}

/**
 * Take over, hand back, and the machine-switch request of the rows above an
 * open tool (`WorkToolPanelBar`).
 *
 * Notes go on the chat's own path for a person's message (`agentChat.steer`
 * on the chat's pin) with `dispatchMode: "inline"`, which joins the running
 * turn. A plain steer QUEUES for every provider, so a note sent that way
 * arrived after the turn as a new turn. So the take-over and hand-back notes
 * go only inline, only while that chat's own turn runs, and never to a
 * queue-only provider (`canTellAgent` false: the bar says so): a turn is
 * never started just to say them. The machine-switch request still means
 * something next turn, so a queue-only provider gets it queued, and the
 * toast says which happened.
 *
 * `session` is the chat's row, only when it is the chat the pane serves.
 */
export function useToolHandoff(args: {
  sessionId: string | null;
  pin: OpenProjectBinding | null;
  session: TerminalSessionSummary | null;
  turnRunning: boolean;
  active: boolean;
  /** Tabs open in the strip, and the one on screen: closing the held tool's tab hands it back. */
  openTools: readonly WorkSidebarTab[];
  effectiveTool: WorkSidebarTab | null;
}) {
  const { sessionId, pin, session, turnRunning, active, openTools, effectiveTool } = args;
  const canTellAgent = agentTakesNotesMidTurn(session);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const turnRunningRef = useRef(turnRunning);
  turnRunningRef.current = turnRunning;
  const canTellRef = useRef(canTellAgent);
  canTellRef.current = canTellAgent;

  const [held, setHeld] = useState<HeldTool | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  // The held chat's own turn, as last seen while the pane served it: after a
  // switch to another chat, that chat's turn says nothing about this one.
  const heldTurnRunningRef = useRef(false);
  if (held && held.sessionId === sessionId) heldTurnRunningRef.current = turnRunning;

  const noteToAgent = useCallback(async (
    chatId: string,
    chatPin: OpenProjectBinding | null,
    text: string,
    dispatchMode: "inline" | undefined,
  ): Promise<AgentChatSteerResult | null> => {
    try {
      const result = await withChatPin(chatPin, (scopedPin) => window.ade.agentChat.steer(
        { sessionId: chatId, text, ...(dispatchMode ? { dispatchMode } : {}) },
        scopedPin,
      ));
      if (result.reason === "queue_full") {
        showToast({ tone: "warning", title: "The agent's queue is full", message: "Send it again once the queue clears.", report: false });
        return null;
      }
      return result;
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't reach the agent", message: deviceSourceErrorText(error), report: false });
      return null;
    }
  }, []);

  const askMachine = useCallback((kind: DeviceKind, machine: ToolMachine) => {
    if (!sessionId) return;
    const noun = DEVICE_KINDS[kind].noun;
    const id = `${kind}@${machine.isChat ? "here" : machine.name}`;
    const inline = canTellRef.current && turnRunningRef.current;
    void noteToAgent(
      sessionId,
      pinRef.current,
      `Please switch the ${noun} to ${machine.name} (ade devices use "${id}").`,
      inline ? "inline" : undefined,
    ).then((result) => {
      if (!result) return;
      showToast({
        id: "work-tools-agent-note",
        tone: result.queued ? "info" : "success",
        title: result.queued ? "Queued for the agent's next turn" : "Sent to the agent",
        message: `Asked it to switch the ${noun} to ${machine.name}.`,
      });
    });
  }, [noteToAgent, sessionId]);

  const takeOver = useCallback((tile: CatalogCardView) => {
    if (!sessionId) return;
    const noun = toolNoun(tile);
    const tell = canTellRef.current && turnRunningRef.current;
    setHeld({ sessionId, tool: tile.tool, noun, pin: pinRef.current, told: tell });
    if (!tell) return;
    void noteToAgent(
      sessionId,
      pinRef.current,
      `The person took over the ${noun}; leave it alone until they hand it back.`,
      "inline",
    ).then((result) => {
      if (result) return;
      setHeld((current) => (current && current.sessionId === sessionId && current.tool === tile.tool
        ? { ...current, told: false }
        : current));
    });
  }, [noteToAgent, sessionId]);

  const handBack = useCallback(() => {
    const current = heldRef.current;
    if (!current) return;
    setHeld(null);
    // Nothing to take back from an agent that was never told, and no turn of
    // that chat's to tell: a note then would start one.
    if (!current.told || !heldTurnRunningRef.current) return;
    void noteToAgent(
      current.sessionId,
      current.pin,
      `The person is done with the ${current.noun}; you can use it again.`,
      "inline",
    );
  }, [noteToAgent]);

  // Closing the tool's tab, the pane, or moving to another chat hands it back
  // (with its note). Looking at the tiles meanwhile keeps the hold.
  const handBackRef = useRef(handBack);
  handBackRef.current = handBack;
  const heldToolOpen = held ? openTools.includes(held.tool) || effectiveTool === held.tool : false;
  useEffect(() => {
    if (!held) return;
    if (!active || !heldToolOpen || sessionId !== held.sessionId) handBackRef.current();
  }, [active, held, heldToolOpen, sessionId]);
  useEffect(() => () => { if (heldRef.current) handBackRef.current(); }, []);

  const heldHere = held && held.sessionId === sessionId ? held : null;
  return {
    /** The tool the person holds for the chat on screen. */
    heldTool: heldHere?.tool ?? null,
    /** The agent was told about that hold. */
    told: heldHere?.told ?? false,
    canTellAgent,
    askMachine,
    takeOver,
    handBack,
  };
}
