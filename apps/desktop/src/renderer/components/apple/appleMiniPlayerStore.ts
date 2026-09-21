import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";

/**
 * Which device is floating over the chat, if any.
 *
 * A module store rather than React state because the two ends are in different
 * subtrees with no ancestor short of the page: the rail's "Float over chat"
 * lives inside the Apple pane, and the player floats over the chat column.
 * Exactly one player at a time — a second Float replaces the first, which is
 * what "float THIS device" means.
 */

export type AppleMiniPlayerTarget = {
  laneId: string | null;
  chatSessionId: string | null;
  deviceUdid: string;
  deviceName: string;
  deviceRuntime: string | null;
  family: "iphone" | "ipad";
  runtimePin: OpenProjectBinding | null;
};

let current: AppleMiniPlayerTarget | null = null;
let listeners = new Set<() => void>();
/**
 * Devices the user closed the player for, on a surface with no chat.
 *
 * A4 opens the player by itself when the tools pane closes on a live device,
 * which is only welcome the first time. Closing it is a statement about THIS
 * device — "not this one, not automatically".
 *
 * Where there IS a chat, that statement is the SHARED per-chat marker in
 * `chatCompanionUiState` (`isWorkLivePreviewEnabled(state, "ios")`), the same
 * one the "Show preview when minimized" toggle writes — so the × on the player
 * and the toggle in the tool's header can never disagree, which is the whole
 * point of A4's "no parallel store". This set is only the fallback for a
 * projectless/chatless surface, which has nowhere to remember the choice.
 */
let dismissed = new Set<string>();

/**
 * Set while a tab close is stopping the tool for real.
 *
 * Closing the Apple TAB and closing the tools PANE unmount the same panel, so
 * both reach the handoff below — but only one of them means "keep showing me
 * the device". Without this flag a tab close raced its own `shutdown`: the
 * handoff's `deviceList` read could still answer "Booted" and float a device
 * that was on its way down, leaving a player showing a frozen last frame.
 *
 * Cleared by the first handoff that sees it, so it can never outlive the close
 * that set it and suppress a later, legitimate minimize.
 */
let closingForReal = false;

/** A tab close is stopping the tool: the next handoff is not a minimize. */
export function suppressAppleMiniPlayerHandoff(): void {
  closingForReal = true;
}

/** True when this chat (or, chatless, this device) wants no floating player. */
function previewSuppressed(chatSessionId: string | null, udid: string): boolean {
  if (!chatSessionId) return dismissed.has(udid);
  return !isWorkLivePreviewEnabled(readChatCompanionUiState(chatSessionId), "ios");
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function openAppleMiniPlayer(target: AppleMiniPlayerTarget): void {
  // Asking for it explicitly undoes an earlier dismissal: the rail's "Float
  // over chat" is the user changing their mind, not a request to be ignored.
  dismissed.delete(target.deviceUdid);
  setWorkLivePreviewEnabledForChat(target.chatSessionId, "ios", true);
  current = target;
  emit();
}

export function closeAppleMiniPlayer(udid?: string): void {
  if (udid && current?.deviceUdid !== udid) return;
  if (current) {
    // A4: × on the floating preview turns it OFF for this chat, which is the
    // same marker the header toggle clears to turn it back on.
    dismissed.add(current.deviceUdid);
    setWorkLivePreviewEnabledForChat(current.chatSessionId, "ios", false);
  }
  current = null;
  emit();
}

/**
 * Put the device back in the pane.
 *
 * Not a dismissal: the picture did not go away, it moved. Called when the
 * Apple tool mounts (the pane is showing the device again) and by
 * "Open in pane".
 */
export function retakeAppleMiniPlayer(udid?: string): void {
  if (udid && current?.deviceUdid !== udid) return;
  if (!current) return;
  current = null;
  emit();
}

export function isAppleMiniPlayerDismissed(udid: string, chatSessionId: string | null = null): boolean {
  return previewSuppressed(chatSessionId, udid);
}

/**
 * The tools pane closed (or switched tool) on a live device: float it.
 *
 * Deliberately a module function called from an unmount effect rather than a
 * hook: by the time this matters the component asking is already gone, and the
 * question it has to answer — "is this lane's simulator actually up?" — is one
 * `deviceList` read, not something worth polling for while the pane is open.
 */
export async function handoffAppleMiniPlayer(args: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): Promise<void> {
  if (closingForReal) {
    closingForReal = false;
    return;
  }
  const { laneId } = args;
  if (!laneId) return;
  if (current) return;
  const api = window.ade?.iosSimulator;
  if (!api?.deviceList) return;
  const listed = await api.deviceList({ laneId, installed: true }, args.runtimePin).catch(() => null);
  const lane = listed?.lane ?? null;
  if (!lane) return;
  if (listed?.installed.find((entry) => entry.udid === lane.udid)?.state !== "Booted") return;
  if (previewSuppressed(args.chatSessionId, lane.udid)) return;
  // A second close-and-reopen race (two panes unmounting at once) must not
  // replace a player that is already on screen.
  if (current) return;
  openAppleMiniPlayer({
    laneId,
    chatSessionId: args.chatSessionId,
    deviceUdid: lane.udid,
    deviceName: lane.name,
    deviceRuntime: lane.runtime,
    family: lane.family === "ipad" ? "ipad" : "iphone",
    runtimePin: args.runtimePin,
  });
}

export function getAppleMiniPlayerTarget(): AppleMiniPlayerTarget | null {
  return current;
}

export function useAppleMiniPlayerTarget(): AppleMiniPlayerTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAppleMiniPlayerTarget,
    getAppleMiniPlayerTarget,
  );
}

/** Test seam: a float from one test must not reach the next. */
export function resetAppleMiniPlayerForTests(): void {
  current = null;
  listeners = new Set();
  dismissed = new Set();
  closingForReal = false;
}
