import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { effectiveRuntimeBinding, laneOnMachineKey } from "../../lib/chatMachineRouting";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { useAppStore } from "../../state/appStore";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";
import { miniPlayerBelongsToSurface, miniPlayerPreviewSuppressed, type MiniPlayerSurface } from "../device/miniPlayerSurface";
import { androidLaneDeviceName } from "./androidDeviceState";
import { androidStreamLeaseKey, androidStreamLeases } from "./androidStreamLease";

/**
 * Which Android emulator floats over the chat, if any.
 *
 * The Android slot of the floating players: one Apple device
 * (`appleMiniPlayerStore.ts`) and one Android emulator can float at the same
 * time, each in its own player. A second Float of an emulator replaces the
 * first, as Apple's does.
 *
 * Smaller than Apple's store, for two reasons:
 *
 * - The Android stream is per lane and its lease already waits
 *   `STREAM_STOP_GRACE_MS` before the last viewer's stop
 *   (`useGracefulStreamLease`), so the pane's release and the player's
 *   acquire in the next commit share one stream. No handover hold is needed.
 * - The stream server gives a joining reader its cached keyframe at once, so
 *   the player paints its first frame without a poster.
 *
 * The rules that are the same as Apple's: the player shows only over a
 * surface of the same lane on the same machine; the machine is frozen when
 * the player opens; × turns the per-chat preview off (the same marker the
 * tool header's "Show preview when minimized" writes), and Float turns it on.
 */

export type AndroidMiniPlayerTarget = {
  laneId: string;
  chatSessionId: string | null;
  avdName: string;
  deviceName: string;
  /** The AVD's screen in pixels (portrait), so the picture maps touch before the first frame. */
  lcdWidth: number | null;
  lcdHeight: number | null;
  runtimePin: OpenProjectBinding | null;
};

/** What the pane last saw of its lane's emulator, for the synchronous handoff. */
export type AndroidMiniPlayerLaneDevice = {
  avdName: string;
  deviceName: string;
  lcdWidth: number | null;
  lcdHeight: number | null;
  /** True while the emulator is booted. */
  booted: boolean;
};

export type AndroidMiniPlayerLaneRef = {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
};

function boundBinding(): OpenProjectBinding | null {
  return useAppStore.getState().projectBinding;
}

let current: AndroidMiniPlayerTarget | null = null;
const listeners = new Set<() => void>();
/** Emulators the person closed the player for on a surface with no chat. */
const dismissed = new Set<string>();
/**
 * Lanes (on their machine) whose Android tab a close is stopping for real:
 * that lane's next handoff is not a minimize. The pane's own unmount takes
 * the mark, whenever React gets to it; the pane's next mount clears a mark
 * that no unmount took (a closed tab that was not on screen).
 */
const closingForReal = new Set<string>();
const laneDevices = new Map<string, AndroidMiniPlayerLaneDevice>();

function emit(): void {
  for (const listener of listeners) listener();
}

function laneDeviceKey(where: AndroidMiniPlayerLaneRef): string | null {
  return where.laneId ? laneOnMachineKey(where.runtimePin, boundBinding(), where.laneId) : null;
}

/** True when this chat (or, chatless, this emulator) wants no floating player. */
function previewSuppressed(chatSessionId: string | null, avdName: string): boolean {
  return miniPlayerPreviewSuppressed({ chatSessionId, tool: "android", deviceKey: avdName, dismissed });
}

/** Does the floating emulator belong over this surface? Same lane, same machine. */
export function androidMiniPlayerBelongsToSurface(
  target: AndroidMiniPlayerTarget,
  surface: MiniPlayerSurface | null,
): boolean {
  return miniPlayerBelongsToSurface(target, surface);
}

export function openAndroidMiniPlayer(target: AndroidMiniPlayerTarget): void {
  dismissed.delete(target.avdName);
  setWorkLivePreviewEnabledForChat(target.chatSessionId, "android", true);
  // Frozen: a null pin means "the machine this window is bound to" only until
  // the window switches machines.
  current = { ...target, runtimePin: effectiveRuntimeBinding(target.runtimePin, boundBinding()) };
  emit();
}

/** × on the player: off for this chat until Float or the header toggle turns it on. */
export function closeAndroidMiniPlayer(avdName?: string): void {
  if (avdName && current?.avdName !== avdName) return;
  if (current) {
    dismissed.add(current.avdName);
    setWorkLivePreviewEnabledForChat(current.chatSessionId, "android", false);
  }
  current = null;
  emit();
}

/**
 * The emulator moved back into the pane, or its tab closed. Not a dismissal.
 * With `where`, only a player of that lane on that machine goes: closing one
 * lane's tab leaves another lane's floating emulator alone.
 */
export function retakeAndroidMiniPlayer(where?: AndroidMiniPlayerLaneRef): void {
  if (!current) return;
  if (where && laneDeviceKey(where) !== laneDeviceKey(current)) return;
  current = null;
  emit();
}

/**
 * A tab close stops the tool: the handoff of the unmount it causes floats
 * nothing. Keyed by the lane on its machine and taken by that unmount, so it
 * holds however late the unmount comes (the close runs after a dialog, and
 * the commit that unmounts the pane can come after other work). It never
 * reaches another lane's pane.
 */
export function suppressAndroidMiniPlayerHandoff(where: AndroidMiniPlayerLaneRef): void {
  const key = laneDeviceKey(where);
  if (key) closingForReal.add(key);
}

/**
 * The lane's Android pane mounted: a close mark that no unmount took is old
 * (its tab was not on screen), so a later minimize of this pane floats again.
 */
export function clearAndroidMiniPlayerHandoffSuppression(where: AndroidMiniPlayerLaneRef): void {
  const key = laneDeviceKey(where);
  if (key) closingForReal.delete(key);
}

/** The pane's cache write, one per status read. A null device forgets the lane. */
export function noteAndroidMiniPlayerLaneDevice(
  where: AndroidMiniPlayerLaneRef,
  device: AndroidMiniPlayerLaneDevice | null,
): void {
  const key = laneDeviceKey(where);
  if (!key) return;
  if (device) laneDevices.set(key, device);
  else laneDevices.delete(key);
}

function laneDevice(where: AndroidMiniPlayerLaneRef): AndroidMiniPlayerLaneDevice | null {
  const key = laneDeviceKey(where);
  return (key ? laneDevices.get(key) : null) ?? null;
}

function targetFor(
  args: { laneId: string; chatSessionId: string | null; runtimePin: OpenProjectBinding | null },
  device: AndroidMiniPlayerLaneDevice,
): AndroidMiniPlayerTarget {
  return {
    laneId: args.laneId,
    chatSessionId: args.chatSessionId,
    avdName: device.avdName,
    deviceName: device.deviceName,
    lcdWidth: device.lcdWidth,
    lcdHeight: device.lcdHeight,
    runtimePin: args.runtimePin,
  };
}

/**
 * The tools pane closed (or switched tool) on a live emulator: float it.
 *
 * Synchronous, from the pane's unmount: a stream lease for the lane proves
 * the picture is up, and the pane's cache has the device's name. Returns true
 * when it opened the player.
 */
export function handoffAndroidMiniPlayer(args: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): boolean {
  const closingKey = laneDeviceKey(args);
  if (closingKey && closingForReal.delete(closingKey)) return false;
  const { laneId } = args;
  if (!laneId || current) return false;
  const key = androidStreamLeaseKey({ pin: args.runtimePin, bound: boundBinding(), laneId });
  if (androidStreamLeases.count(key) <= 0) return false;
  const device = laneDevice(args);
  if (!device?.booted || previewSuppressed(args.chatSessionId, device.avdName)) return false;
  openAndroidMiniPlayer(targetFor({ ...args, laneId }, device));
  return true;
}

/**
 * Float the lane's emulator over a chat because of its agent.
 *
 * `auto` is the agent driving the emulator: it floats only while this chat's
 * preview is on and never replaces a player already up. Not `auto` is
 * `ade android show --floating`, an explicit ask. The caller has already
 * checked that the chat is in front and the Android tool is not on screen.
 */
export async function floatAndroidMiniPlayerForChat(args: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  auto: boolean;
}): Promise<boolean> {
  const { laneId, chatSessionId } = args;
  if (!laneId) return false;
  const suppressed = () => Boolean(
    args.auto && chatSessionId && !isWorkLivePreviewEnabled(readChatCompanionUiState(chatSessionId), "android"),
  );
  const floatingHere = () => Boolean(current && androidMiniPlayerBelongsToSurface(current, {
    laneId,
    runtimePin: args.runtimePin,
    boundBinding: boundBinding(),
  }));
  if (suppressed()) return false;
  if (current) {
    if (floatingHere()) return true;
    if (args.auto) return false;
  }
  // An automatic float always asks whether the emulator is up: the cache
  // outlives a power-off. An explicit ask may show it off, with the player's Start.
  let device = args.auto ? null : laneDevice(args);
  if (!device) {
    const api = window.ade?.androidEmulator;
    if (!api?.getStatus) return false;
    const status = await api.getStatus({ laneId }, args.runtimePin).catch((cause: unknown) => {
      // Nothing floats: the pane went, and the emulator's state is unknown.
      logRendererDebugEvent("android.mini_player_status_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    });
    const lane = status?.lane ?? null;
    const avdName = lane?.device?.avdName ?? null;
    if (!lane || !avdName) return false;
    device = {
      avdName,
      deviceName: androidLaneDeviceName(lane),
      lcdWidth: lane.avd?.lcdWidth ?? null,
      lcdHeight: lane.avd?.lcdHeight ?? null,
      booted: lane.state === "booted",
    };
    noteAndroidMiniPlayerLaneDevice(args, device);
    if (args.auto && !device.booted) return false;
  }
  // The read awaited: the person may have closed a player or turned the
  // preview off meanwhile, and another float may have won.
  if (suppressed()) return false;
  if (floatingHere()) return true;
  if (current && args.auto) return false;
  openAndroidMiniPlayer(targetFor({ laneId, chatSessionId, runtimePin: args.runtimePin }, device));
  return true;
}

export function getAndroidMiniPlayerTarget(): AndroidMiniPlayerTarget | null {
  return current;
}

export function useAndroidMiniPlayerTarget(): AndroidMiniPlayerTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAndroidMiniPlayerTarget,
    getAndroidMiniPlayerTarget,
  );
}
