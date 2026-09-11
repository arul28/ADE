import type { BufferedEvent } from "./eventBuffer";

/**
 * Runtime events that carry a video frame rather than a state change.
 *
 * App Control's screencast is a CDP `Page.screencastFrame` pass-through: a
 * base64 JPEG at up to 1600x1000, quality 78, `everyNthFrame: 1`. That is
 * 80-350 KB per frame at monitor refresh, and it is pushed onto the runtime
 * event stream whenever a session is attached, whether or not anything is
 * watching.
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
