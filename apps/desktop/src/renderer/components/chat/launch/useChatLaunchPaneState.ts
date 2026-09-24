import { useEffect, useRef, type MutableRefObject } from "react";
import type { ChatLaunchSnapshot } from "../../../../shared/types";
import { isChatLaunchPending } from "../../../../shared/chatLaunch";
import { useChatLaunchForPane } from "../../../state/chatLaunchStore";

export type ChatLaunchPaneState = {
  /** The chat launch behind this pane (never a CLI or cancelled launch), or null. */
  chatLaunch: ChatLaunchSnapshot | null;
  /**
   * The session id is reserved but the brain has not created the chat yet:
   * there is no summary or transcript to read, so the pane renders the launch
   * (prompt bubble, setup card, queued messages) and holds every session read.
   */
  launchAwaitingSession: boolean;
  /** The launch still owns the chat's first moments (see `isChatLaunchPending`). */
  launchQueuesComposer: boolean;
  /**
   * Sends go through the launch's queue rather than straight to the chat:
   * while it is pending, and after the agent started for as long as earlier
   * queued messages still wait for delivery — so a new message never jumps
   * ahead of them, and sending it is the host's cue to retry them.
   */
  launchRoutesSends: boolean;
};

/**
 * The new-lane launch seam of a chat pane: which launch (if any) owns the
 * chat the pane shows. Re-renders only on what the pane acts on (see
 * `useChatLaunchForPane`), never on stage progress.
 */
export function useChatLaunchPaneState(
  lockSessionId: string | null | undefined,
  renderedSessionId: string | null | undefined,
): ChatLaunchPaneState {
  const paneSessionId = lockSessionId ?? renderedSessionId ?? null;
  const snapshot = useChatLaunchForPane(paneSessionId);
  const chatLaunch = snapshot
    && snapshot.kind === "chat"
    && snapshot.phase !== "cancelled"
    && snapshot.sessionId === paneSessionId
    ? snapshot
    : null;
  const launchQueuesComposer = Boolean(chatLaunch && isChatLaunchPending(chatLaunch));
  return {
    chatLaunch,
    launchAwaitingSession: Boolean(chatLaunch && !chatLaunch.sessionCreated),
    launchQueuesComposer,
    launchRoutesSends: launchQueuesComposer
      || Boolean(chatLaunch?.agentStarted && chatLaunch.queuedMessages.length > 0),
  };
}

/**
 * What a pane does as its launch moves along. Called where the pane's other
 * session effects run (after its model-fallback effect), because effect order
 * decides which `setModelId` of a commit wins.
 */
export function useChatLaunchPaneLifecycle({
  chatLaunch,
  launchAwaitingSession,
  refreshSessions,
  setModelId,
  optimisticSessionIdsRef,
  knownSessionIdsRef,
}: {
  chatLaunch: ChatLaunchSnapshot | null;
  launchAwaitingSession: boolean;
  refreshSessions: (options?: { force?: boolean }) => Promise<unknown>;
  setModelId: (modelId: string) => void;
  optimisticSessionIdsRef: MutableRefObject<Set<string>>;
  knownSessionIdsRef: MutableRefObject<Set<string>>;
}): void {
  // The launch's chat now exists on the host: read its summary so the header,
  // model and turn state come from the real session, in this same pane.
  const launchAwaitedSessionRef = useRef(launchAwaitingSession);
  useEffect(() => {
    const wasAwaiting = launchAwaitedSessionRef.current;
    launchAwaitedSessionRef.current = launchAwaitingSession;
    if (wasAwaiting && !launchAwaitingSession) {
      void refreshSessions({ force: true }).catch(() => undefined);
    }
  }, [launchAwaitingSession, refreshSessions]);

  // Until the chat exists there is no session to read its model from; show the
  // model the launch runs with (once per launch — the user can still change it).
  const seededLaunchModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatLaunch || !launchAwaitingSession || !chatLaunch.modelId) return;
    if (seededLaunchModelRef.current === chatLaunch.launchId) return;
    seededLaunchModelRef.current = chatLaunch.launchId;
    setModelId(chatLaunch.modelId);
  }, [chatLaunch, launchAwaitingSession, setModelId]);

  // Accept live events for the reserved id before the summary lists it.
  const reservedSessionId = chatLaunch?.sessionId ?? null;
  useEffect(() => {
    if (!reservedSessionId) return;
    optimisticSessionIdsRef.current.add(reservedSessionId);
    knownSessionIdsRef.current.add(reservedSessionId);
  }, [knownSessionIdsRef, optimisticSessionIdsRef, reservedSessionId]);
}
