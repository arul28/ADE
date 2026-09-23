import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { AgentChatFileRef, ChatLaunchKind } from "../../../../shared/types";
import type { DraftLaunchSnapshot } from "../../../lib/draftLaunchJobs";

/**
 * Hand-off from a closed launch back to Work — the one channel for it.
 *
 * Cancel and Delete can be pressed from the thread, the Launches slide-out or
 * a sidebar row, none of which own Work's tabs or the draft composer. They
 * post a close notice here: Work closes the launch's tab and shows the draft
 * of that kind again, and (when asked to) the prompt is left for that draft
 * composer to pick up (on mount, or immediately if it is already on screen)
 * and merge into whatever is already typed, so nothing the user wrote is lost.
 * A launch handed back to the legacy create-lane chain posts a notice without
 * a prompt, and so does the launch store when a host snapshot reports a launch
 * cancelled (from any device) — the one path that closes its tab everywhere.
 */
export type ChatLaunchDraftRestoreRequest = {
  launchId: string;
  kind: ChatLaunchKind;
  /** Full composer snapshot when this window started the launch. */
  draftSnapshot: DraftLaunchSnapshot | null;
  /** Fallback for launches started elsewhere: the prompt as the host knows it. */
  prompt: { text: string; attachments: AgentChatFileRef[] };
};

/** A launch that was removed: its tab closes and Work goes back to the draft of its kind. */
export type ChatLaunchClosedNotice = {
  launchId: string;
  sessionId: string | null;
  kind: ChatLaunchKind;
  /** Set on delivery: this notice hands the prompt back to a draft composer. */
  restoresPrompt?: boolean;
};

type RestoreState = {
  requests: ChatLaunchDraftRestoreRequest[];
  /** The latest close notice; subscribers react to each new object. */
  lastClosed: ChatLaunchClosedNotice | null;
};

const restoreStore = createStore<RestoreState>(() => ({ requests: [], lastClosed: null }));

/** Close a launch's tab in Work and, with `restore`, hand its prompt back to the draft — in one update. */
export function announceChatLaunchClosed(
  notice: ChatLaunchClosedNotice,
  restore: ChatLaunchDraftRestoreRequest | null = null,
): void {
  restoreStore.setState((state) => ({
    requests: restore
      ? [...state.requests.filter((entry) => entry.launchId !== restore.launchId), restore]
      : state.requests,
    lastClosed: { ...notice, restoresPrompt: Boolean(restore) },
  }));
}

/** Called once for every close notice posted after subscribing. */
export function subscribeChatLaunchClosed(listener: (notice: ChatLaunchClosedNotice) => void): () => void {
  return restoreStore.subscribe((state, previous) => {
    if (state.lastClosed && state.lastClosed !== previous.lastClosed) listener(state.lastClosed);
  });
}

export function consumeChatLaunchDraftRestore(launchId: string): void {
  restoreStore.setState((state) => {
    if (!state.requests.some((entry) => entry.launchId === launchId)) return state;
    return { requests: state.requests.filter((entry) => entry.launchId !== launchId) };
  });
}

/** Oldest pending restore for a draft of this kind, or null. */
export function useChatLaunchDraftRestore(kind: ChatLaunchKind | null): ChatLaunchDraftRestoreRequest | null {
  return useStore(restoreStore, (state) => (
    kind ? state.requests.find((entry) => entry.kind === kind) ?? null : null
  ));
}

export function resetChatLaunchDraftRestoreForTests(): void {
  restoreStore.setState({ requests: [], lastClosed: null });
}
