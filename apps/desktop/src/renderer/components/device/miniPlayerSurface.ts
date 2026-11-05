import type { OpenProjectBinding } from "../../../shared/types";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import type { WorkLiveScreenTool } from "../../state/workLiveCardState";
import { isWorkLivePreviewEnabled, readChatCompanionUiState } from "../chat/chatCompanionUiState";

/*
 * The rules both floating players keep: the Apple device's
 * (`appleMiniPlayerStore.ts`) and the Android emulator's
 * (`androidMiniPlayerStore.ts`).
 */

/**
 * The Work surface in front of the player: the session the page is showing,
 * reduced to what decides whether the floating device belongs over it.
 *
 * Null is the new-chat / empty composer screen. That screen may have a lane
 * picked in its composer, but it is not a surface OF that lane yet — nothing
 * has been started there — and it is exactly where the owner saw a lane's
 * simulator float uninvited (2026-09-23, "it shouldn't have done that").
 */
export type MiniPlayerSurface = {
  /** The session's lane; null for a lane-less (projectless) session. */
  laneId: string | null;
  /** The session's own pin, as `resolveSessionRuntimePin` answers it. */
  runtimePin: OpenProjectBinding | null;
  /** The machine this window is bound to, which a null pin means. */
  boundBinding: OpenProjectBinding | null;
};

/**
 * Does the floating device belong over this surface?
 *
 * Only over a session of the SAME lane on the SAME machine. The device is a
 * lane's; over another lane's chat it is someone else's picture, and a lane id
 * alone is not an identity — two machines can each have a lane called the
 * same thing, so the machine is compared too, through the same
 * `workRuntimeScopeKey` the Work tools key themselves on. Both sides resolve a
 * null pin against the window's CURRENT binding, which is what a null pin
 * means to the stream as well.
 *
 * A lane-less target (a projectless chat's device) belongs only on lane-less
 * surfaces, by the same rule: null lane equals null lane.
 */
export function miniPlayerBelongsToSurface(
  target: { laneId: string | null; runtimePin: OpenProjectBinding | null },
  surface: MiniPlayerSurface | null,
): boolean {
  if (!surface) return false;
  if ((target.laneId || null) !== (surface.laneId || null)) return false;
  return workRuntimeScopeKey(target.runtimePin, surface.boundBinding)
    === workRuntimeScopeKey(surface.runtimePin, surface.boundBinding);
}

/**
 * True when this chat wants no floating player for `tool`: the shared
 * per-chat marker the tool header's "Show preview when minimized" writes. A
 * chatless surface has nowhere to keep that choice, so `dismissed` (the
 * devices the person closed the player for) stands in.
 */
export function miniPlayerPreviewSuppressed(args: {
  chatSessionId: string | null;
  tool: WorkLiveScreenTool;
  deviceKey: string;
  dismissed: ReadonlySet<string>;
}): boolean {
  if (!args.chatSessionId) return args.dismissed.has(args.deviceKey);
  return !isWorkLivePreviewEnabled(readChatCompanionUiState(args.chatSessionId), args.tool);
}
