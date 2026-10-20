import { useCallback } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { machineIdForBinding } from "../../shared/machineIdentity";
import { selectActiveProjectStateKey, useAppStore } from "../state/appStore";
import { queueAgentChatDraftHandoff } from "./agentChatDraftHandoff";
import { navigateToAppTarget } from "./openExternal";
import { chatDraftMachineId, openStartChatDraft } from "./workDraft";

/**
 * Put `prompt` in a chat composer and go there. `sessionId: null` starts a new
 * chat in the lane. For a lane on the tab's own machine only.
 */
export function handPromptToChat(args: { laneId: string; sessionId: string | null; prompt: string }): void {
  if (args.sessionId) {
    queueAgentChatDraftHandoff({ sessionId: args.sessionId }, args.prompt);
    navigateToAppTarget({ kind: "work", laneId: args.laneId, sessionId: args.sessionId });
    return;
  }
  queueAgentChatDraftHandoff({ draftTargetId: `work:draft:${args.laneId}:chat` }, args.prompt);
  navigateToAppTarget({ kind: "work", laneId: args.laneId });
}

export type LaneChatHandoffArgs = {
  laneId: string;
  /** An existing chat, or null to start a new chat in the lane. */
  sessionId: string | null;
  /** Written into the composer, never sent. Omit to just open the chat. */
  prompt?: string | null;
};

/**
 * `handPromptToChat` that knows which machine the lane lives on.
 *
 * `pin` is null for a lane on the tab's machine, and then this is exactly
 * `handPromptToChat`. For a lane on another machine the Work tab must not
 * resolve the bare lane or session id against the tab's machine: an existing
 * chat is focused with its binding (`ade:work:select-session`), and a new chat
 * starts as a draft that carries the owner machine (`openStartChatDraft`), the
 * same way `useStartChatInLane` does.
 */
export function useLaneChatHandoff(
  pin: OpenProjectBinding | null,
  options: {
    /**
     * Start the new chat the way "New chat in this lane" does
     * (`useStartChatInLane`): point the Work draft at the lane on its machine
     * and select it, so the composer shows that lane and takes the prompt even
     * when another lane was selected. Without it a local new chat only
     * navigates with the lane id (the PR actions' behaviour).
     */
    startDraftInLane?: boolean;
  } = {},
): (args: LaneChatHandoffArgs) => void {
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  const selectLane = useAppStore((state) => state.selectLane);
  const startDraftInLane = options.startDraftInLane === true;
  return useCallback((args: LaneChatHandoffArgs) => {
    const prompt = args.prompt ?? null;
    if (!pin && !(startDraftInLane && !args.sessionId)) {
      if (prompt != null) {
        handPromptToChat({ laneId: args.laneId, sessionId: args.sessionId, prompt });
      } else {
        navigateToAppTarget({ kind: "work", laneId: args.laneId, sessionId: args.sessionId });
      }
      return;
    }
    if (pin && args.sessionId) {
      if (prompt != null) queueAgentChatDraftHandoff({ sessionId: args.sessionId }, prompt);
      window.dispatchEvent(new CustomEvent("ade:work:select-session", {
        detail: { sessionId: args.sessionId, laneId: args.laneId, binding: pin },
      }));
      navigateToAppTarget({ kind: "work" });
      return;
    }
    if (prompt != null) {
      queueAgentChatDraftHandoff({ draftTargetId: `work:draft:${args.laneId}:chat` }, prompt);
    }
    const draftMachineId = pin ? chatDraftMachineId(machineIdForBinding(pin), machineIdForBinding(projectBinding)) : null;
    if (projectStateKey) {
      openStartChatDraft(setWorkViewState, projectStateKey, args.laneId, draftMachineId);
    }
    // A foreign lane id is not in this tab's lane list; selecting it would
    // steal the local selection without making the draft find that lane.
    if (!draftMachineId) selectLane(args.laneId);
    navigateToAppTarget({ kind: "work" });
  }, [pin, projectBinding, projectStateKey, selectLane, setWorkViewState, startDraftInLane]);
}
