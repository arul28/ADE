import { appControlFrameEventLaneId } from "../../desktop/src/shared/appControlFrameDemand";
import type { BufferedEvent } from "./eventBuffer";

/**
 * Runtime events that carry a video frame rather than a state change.
 *
 * App Control's screencast is a CDP `Page.screencastFrame` pass-through: a
 * base64 JPEG at up to 1600x1000, quality 78, `everyNthFrame: 1`. That is
 * 80-350 KB per frame at monitor refresh. The screencast streams only while
 * something shows or records the lane (or a client from before frame demand
 * subscribes to frames), and frames are never kept for replay.
 *
 * On a local socket that is merely wasteful. Over a paired sync transport it is
 * fatal: runtime RPC rides `rpc_data`, which is a *required* send, so the host
 * buffers rather than drops it, and the peer is closed with 4001 "Required sync
 * response backpressured" the moment `bufferedAmount` passes 16 MiB — a
 * desktop bound to a remote runtime with the Work tab open lost its transport
 * roughly every ten seconds. The frames were not even rendered: App Control is
 * reported unavailable for a remote project, so every one of those megabytes
 * was decoded and discarded.
 *
 * So frames are opt-in per subscription. A subscriber that can actually paint
 * them (a desktop attached to its own local runtime) asks for them; nobody else
 * pays for them. Skipping is the *only* correct response to a frame nobody
 * asked for — queueing a stale frame is worse than not sending it, because the
 * next one is already better.
 */
export function isHighVolumeRuntimeEvent(event: BufferedEvent): boolean {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.type !== "app_control_event") return false;
  const inner = record.event;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return false;
  return (inner as Record<string, unknown>).type === "frame";
}

/** The lane of a screencast frame event, for keeping each lane's newest frame apart. */
export function runtimeEventFrameLaneId(event: BufferedEvent): string | null {
  const inner = (event.payload as Record<string, unknown> | null)?.event;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  const record = inner as { laneId?: unknown; frame?: { laneId?: unknown } | null };
  return appControlFrameEventLaneId({
    laneId: typeof record.laneId === "string" ? record.laneId : null,
    frame: { laneId: typeof record.frame?.laneId === "string" ? record.frame.laneId : null },
  });
}

const MAX_PTY_DATA_IDS = 2_000;

/**
 * The terminals whose output a client wants, from a `ptyDataIds` param: null
 * when the client sent no list (it wants every terminal's output).
 *
 * A desktop window asks only for the terminals it shows and reads a hidden
 * one's screen again when it comes back, so output it would drop anyway does
 * not need to cross the link. The list is an allow-list of PTY ids; `pty_exit`
 * and every other event still reach the client.
 */
export function readPtyDataIds(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const item of value.slice(0, MAX_PTY_DATA_IDS)) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id && id.length <= 256) ids.add(id);
  }
  return ids;
}

/** False only for a `pty_data` event of a terminal outside `ptyDataIds`. */
export function passesPtyDataFilter(
  event: BufferedEvent,
  ptyDataIds: ReadonlySet<string> | null,
): boolean {
  if (!ptyDataIds || event.category !== "pty") return true;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || payload.type !== "pty_data") return true;
  const inner = payload.event as Record<string, unknown> | null | undefined;
  const ptyId = inner && typeof inner === "object" && typeof inner.ptyId === "string" ? inner.ptyId : "";
  return !ptyId || ptyDataIds.has(ptyId);
}
