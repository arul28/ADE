import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";
import {
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
  appleStreamViewerForLane,
  releaseAppleStreamLease,
} from "./appleStreamLease";

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
  // A close-for-real stops the stream itself; a hold left over from an earlier
  // minimize would be a second, later stop aimed at a device already off.
  releaseAppleMiniPlayerHandoverHold();
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
  /*
   * A retake is a handover too, in the other direction — and it was the one
   * that broke.
   *
   * Reopening the Apple tool mounts the pane, which calls this; the player
   * unmounts a beat later and hands ITS lease back. That release was the last
   * one, so it fired a lane-scoped `stopStream` — at a capture the arriving
   * pane had, in the meantime, already adopted. The service went on reporting
   * `running: true` (so its own short-circuit refused to start another), the
   * helper had stopped encoding, and the pane sat on "Connecting video" until
   * the renderer was reloaded.
   *
   * Holding a lease across the swap keeps the count above zero exactly as the
   * minimize direction does, so the player's release is not `last` and the
   * picture is never interrupted. Skipped while the tool is closing for real,
   * where the stream is SUPPOSED to stop.
   */
  if (!closingForReal) {
    const key = appleStreamLeaseKey({
      pinKey: current.runtimePin?.key,
      laneId: current.laneId,
      deviceUdid: current.deviceUdid,
    });
    // Only when there is a run to hold on to: taking a lease on a stream
    // nobody is watching would leave the expiry below stopping a capture that
    // was never started.
    if (appleStreamLeaseCount(key) > 0) {
      takeHandoverHold({
        key,
        laneId: current.laneId,
        chatSessionId: current.chatSessionId,
        runtimePin: current.runtimePin,
      });
    }
  }
  current = null;
  emit();
}

export function isAppleMiniPlayerDismissed(udid: string, chatSessionId: string | null = null): boolean {
  return previewSuppressed(chatSessionId, udid);
}

/**
 * What the pane last saw of a lane's device, so the handover below needs no
 * question of its own.
 *
 * Written by the panel while the tool is OPEN — one read on mount and one per
 * `apple.device.state` event, never a poll — because the handover runs in an
 * unmount cleanup, and anything it has to await there is a gap the user sees
 * between the pane going and the player arriving.
 */
export type AppleMiniPlayerLaneDevice = {
  udid: string;
  name: string;
  runtime: string | null;
  family: string | null;
};

const laneDevices = new Map<string, AppleMiniPlayerLaneDevice>();

/** The panel's cache write. A null device forgets the lane. */
export function noteAppleMiniPlayerLaneDevice(
  laneId: string | null,
  device: AppleMiniPlayerLaneDevice | null,
): void {
  if (!laneId) return;
  if (device) laneDevices.set(laneId, device);
  else laneDevices.delete(laneId);
}

export function getAppleMiniPlayerLaneDevice(laneId: string | null): AppleMiniPlayerLaneDevice | null {
  return (laneId ? laneDevices.get(laneId) : null) ?? null;
}

/**
 * The last frame the pane drew, kept for the player that is about to replace it.
 *
 * Even with the capture held open across the handover (below), the new reader
 * has to dial the helper and wait for the keyframe it asks for on attach — one
 * encode frame, but a visible one on a black box. The poster is that frame, as
 * a data URL, painted under the stage until the decoder produces a real one.
 *
 * Keyed by device and read exactly once: a stale poster is a photograph of a
 * screen that has since changed, and showing one after the picture is live
 * would be worse than the black box it replaced.
 */
const posters = new Map<string, { dataUrl: string; atMs: number }>();

/**
 * How long a photograph is still a fair stand-in for the live picture.
 *
 * The panel photographs the frame on every unmount, including a tab close that
 * floats nothing at all — so a poster can outlive the handover it was taken
 * for. A handover is one commit; anything older than a couple of seconds is a
 * picture of a screen that has since moved on, and showing it would be worse
 * than the black box it replaces.
 */
export const APPLE_MINI_PLAYER_POSTER_TTL_MS = 3_000;

export function noteAppleMiniPlayerPoster(
  deviceUdid: string,
  dataUrl: string | null,
  atMs: number = Date.now(),
): void {
  if (dataUrl) posters.set(deviceUdid, { dataUrl, atMs });
  else posters.delete(deviceUdid);
}

export function takeAppleMiniPlayerPoster(deviceUdid: string, nowMs: number = Date.now()): string | null {
  const poster = posters.get(deviceUdid) ?? null;
  posters.delete(deviceUdid);
  if (!poster) return null;
  return nowMs - poster.atMs <= APPLE_MINI_PLAYER_POSTER_TTL_MS ? poster.dataUrl : null;
}

/**
 * How long the handover keeps the stream alive on its own.
 *
 * Long enough for React to render and mount the player (one commit), short
 * enough that a handover whose player never arrives does not leave a simulator
 * encoding H.264 into nothing.
 */
export const APPLE_STREAM_HANDOVER_HOLD_MS = 6_000;

/**
 * The lease the HANDOVER holds, between the pane giving its own back and the
 * player taking one.
 *
 * This is the whole of round 4 §B4. The lease is refcounted so that two viewers
 * can share one capture, but a handover is not two viewers — it is one viewer
 * replacing another, and the replacement mounts a commit or two AFTER the
 * original's cleanup. The count therefore touched zero on the way across, the
 * last release stopped the helper's capture, and the player then had to start a
 * new one and wait for it: capture-start, a `simctl` bootstatus check, a fresh
 * port and token, then a connect and a keyframe. That is the "visible moment".
 *
 * Holding a lease over the gap keeps the count at one or more the whole way, so
 * the pane's release is not `last`, the capture is never stopped, and the
 * player's `startStream` returns the RUNNING stream's own status (the service
 * short-circuits an identical device+fps request) instead of making a new one.
 */
let handoverHold: {
  key: string;
  epoch: number;
  timer: number;
  scope: { laneId: string | null; chatSessionId: string | null };
  pin: OpenProjectBinding | null;
} | null = null;

function dropHandoverHold(stopIfLast: boolean): void {
  const hold = handoverHold;
  if (!hold) return;
  handoverHold = null;
  window.clearTimeout(hold.timer);
  const { last } = releaseAppleStreamLease(hold.key, hold.epoch);
  if (!last || !stopIfLast) return;
  // Nobody took the picture up: the hold was the only thing keeping the helper
  // encoding, so it owes the stop the pane's own release would have made.
  void window.ade?.iosSimulator?.stopStream?.(hold.pin, hold.scope).catch(() => {});
}

/** Test seam and the player's own hand-back: give the handover's lease up now. */
export function releaseAppleMiniPlayerHandoverHold(): void {
  dropHandoverHold(false);
}

function takeHandoverHold(args: {
  key: string;
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): void {
  // One at a time: a second handover while one is still held would leave the
  // first one's count parked until its timer, which is a stream nobody stops.
  dropHandoverHold(true);
  const { epoch } = acquireAppleStreamLease(args.key);
  handoverHold = {
    key: args.key,
    epoch,
    pin: args.runtimePin,
    scope: { laneId: args.laneId, chatSessionId: args.chatSessionId },
    timer: window.setTimeout(() => dropHandoverHold(true), APPLE_STREAM_HANDOVER_HOLD_MS),
  };
}

/**
 * The tools pane closed (or switched tool) on a live device: float it.
 *
 * SYNCHRONOUS, which is the point. Round 3 asked the runtime `deviceList`
 * first, so the player opened one IPC round trip after the pane had already
 * gone — and on a remote Mac that round trip is the whole latency of the link.
 * The two facts it was asking for are both already here: a stream LEASE for
 * this lane proves the device is up and producing frames (a stronger answer
 * than "Booted"), and the panel leaves the device's name and family in the
 * cache above while it is open.
 *
 * Deliberately a module function called from an unmount effect rather than a
 * hook: by the time this matters the component asking is already gone.
 *
 * Returns true when it opened the player. The async fallback — a lane with no
 * live lease, which is the cold case where there is nothing to hand over
 * quickly anyway — stays available as `handoffAppleMiniPlayerAsync`.
 */
export function handoffAppleMiniPlayer(args: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): boolean {
  if (closingForReal) {
    closingForReal = false;
    return false;
  }
  const { laneId } = args;
  if (!laneId || current) return false;
  const viewer = appleStreamViewerForLane(laneId);
  if (!viewer) return false;
  if (previewSuppressed(args.chatSessionId, viewer.deviceUdid)) return false;
  const known = getAppleMiniPlayerLaneDevice(laneId);
  // The hold is taken BEFORE the player opens, because the pane's own release
  // is still to come: it runs in the passive-effect pass after this cleanup.
  takeHandoverHold({
    key: viewer.key,
    laneId,
    chatSessionId: args.chatSessionId,
    runtimePin: args.runtimePin,
  });
  openAppleMiniPlayer({
    laneId,
    chatSessionId: args.chatSessionId,
    deviceUdid: viewer.deviceUdid,
    // The name is only ever read aloud (the player's chrome has no title), so
    // the cache missing is a worse label, not a worse picture.
    deviceName: known?.name ?? "Simulator",
    deviceRuntime: known?.runtime ?? null,
    family: known?.family === "ipad" ? "ipad" : "iphone",
    runtimePin: args.runtimePin,
  });
  return true;
}

/**
 * The cold path: no live stream for this lane, so ask the runtime.
 *
 * Kept because the pane can be closed in a state where it never streamed at all
 * (a device booted from Xcode, a pane that errored), and a booted device is
 * still worth floating. Nothing here is on the fast path.
 */
export async function handoffAppleMiniPlayerAsync(args: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): Promise<void> {
  // Consumed HERE, before the fast path, because the fast path answers false
  // for several reasons and "the tool is closing" is the one that must also
  // stop the cold read below — a `deviceList` behind a shutdown is exactly the
  // race that used to float a device on its way down.
  if (closingForReal) {
    closingForReal = false;
    return;
  }
  if (handoffAppleMiniPlayer(args)) return;
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
  noteAppleMiniPlayerLaneDevice(laneId, {
    udid: lane.udid,
    name: lane.name,
    runtime: lane.runtime,
    family: lane.family,
  });
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
  laneDevices.clear();
  posters.clear();
  if (handoverHold) {
    window.clearTimeout(handoverHold.timer);
    handoverHold = null;
  }
}
