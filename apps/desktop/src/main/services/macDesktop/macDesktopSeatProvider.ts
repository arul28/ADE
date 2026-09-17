/**
 * The Mac virtual-display backend, as a `DesktopSeatProvider`.
 *
 * One method per driver op and nothing else: no policy, no ownership, no
 * lease, no events. The service decides what to ask for and what to refuse;
 * this file is the only place that knows the op names, so a later Linux seat
 * backend is a sibling of this file rather than a second set of branches inside
 * the service.
 *
 * Replies that the service normalizes against state only it has — the display's
 * size, the lane's name, its clock — are passed through as `DesktopSeatReply`
 * rather than half-normalized here, so there is exactly one place each fallback
 * is applied.
 */

import type {
  DesktopSeatProvider,
  DesktopSeatReply,
  MacDesktopInputMode,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import { MAC_DESKTOP_DRIVER_OPS, type MacDesktopDriverClient } from "./macDesktopDriverClient";

/** Launching an app can wait on Gatekeeper and a first-run dialog. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** Finalizing a movie file is not a 20-second operation on a long recording. */
const RECORDING_STOP_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * The driver-reply normalizers.
 *
 * A driver field that answered with a string, an array or nothing at all must
 * be coerced exactly once, in one place, or the service and this file disagree
 * about what "no reply" looks like. `asReply` is local — every reply this file
 * produces is already normalized by the time the service sees it — while the
 * rest are exported because the service and `macDesktopInput.ts` read the same
 * loosely-typed driver payloads.
 */
const asReply = (value: unknown): DesktopSeatReply =>
  (value && typeof value === "object" && !Array.isArray(value) ? value as DesktopSeatReply : {});

/** A driver field that should have been a window list, whatever it actually is. */
export const asWindows = (value: unknown): MacDesktopWindow[] =>
  (Array.isArray(value) ? value as MacDesktopWindow[] : []);

/** A driver field that should have been an object. */
export const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** A driver field that should have been a finite number. */
export const asNumber = (value: unknown, fallback: number): number =>
  (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A driver field that should have been a non-empty string. */
export const asNullableString = (value: unknown): string | null =>
  (typeof value === "string" && value.trim().length ? value.trim() : null);

export function createMacVirtualDisplayProvider(client: MacDesktopDriverClient): DesktopSeatProvider {
  const request = async (
    op: (typeof MAC_DESKTOP_DRIVER_OPS)[keyof typeof MAC_DESKTOP_DRIVER_OPS],
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<DesktopSeatReply> => asReply(await client.request(op, payload, options));

  return {
    id: "mac-virtual-display",

    health: () => request(MAC_DESKTOP_DRIVER_OPS.health, {}, { timeoutMs: HEALTH_TIMEOUT_MS }),

    create: (args) => request(MAC_DESKTOP_DRIVER_OPS.createDisplay, { ...args }),

    destroy: (args) => request(MAC_DESKTOP_DRIVER_OPS.destroyDisplay, { laneId: args.laneId }),

    async reconcile(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.reconcileDisplays, { liveLaneIds: args.liveLaneIds });
    },

    async listWindows(args) {
      const reply = await request(
        MAC_DESKTOP_DRIVER_OPS.listWindows,
        args.laneId ? { laneId: args.laneId } : {},
      );
      return asWindows(reply.windows);
    },

    async park(args) {
      const reply = await request(MAC_DESKTOP_DRIVER_OPS.parkWindow, {
        laneId: args.laneId,
        windowId: args.windowId,
      });
      // Older helpers answered with the window itself rather than wrapping it.
      return (reply.window ? reply.window : reply) as MacDesktopWindow;
    },

    async unpark(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.unparkWindow, { windowId: args.windowId });
    },

    launch: (args) => request(MAC_DESKTOP_DRIVER_OPS.launch, {
      laneId: args.laneId,
      target: args.target,
      args: args.args,
    }, { timeoutMs: LAUNCH_TIMEOUT_MS }),

    present: (args) => request(MAC_DESKTOP_DRIVER_OPS.present, {
      laneId: args.laneId,
      destination: args.destination,
    }),

    observe: (args) => request(MAC_DESKTOP_DRIVER_OPS.observe, {
      laneId: args.laneId,
      windowId: args.windowId,
      limit: args.limit,
      map: args.map,
      screenshotPath: args.screenshotPath,
      ...(args.mapPath ? { mapPath: args.mapPath } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
    }),

    input: (args: {
      laneId: string;
      command: string;
      mode: MacDesktopInputMode;
      payload: Record<string, unknown>;
      timeoutMs?: number;
      lease?: { holderId: string } | null;
    }) => request(MAC_DESKTOP_DRIVER_OPS.input, {
      laneId: args.laneId,
      command: args.command,
      mode: args.mode,
      payload: args.payload,
      // The helper refuses a `CGEvent` post itself rather than trusting its
      // caller, so it is told which holder this process authorized.
      ...(args.lease ? { lease: { holderId: args.lease.holderId } } : {}),
    }, args.timeoutMs == null ? {} : { timeoutMs: args.timeoutMs }),

    screenshot: (args) => request(MAC_DESKTOP_DRIVER_OPS.screenshot, {
      laneId: args.laneId,
      windowId: args.windowId,
      path: args.path,
    }),

    async setLease(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.setLease, {
        laneId: args.laneId,
        holderId: args.holderId,
        expiresAt: args.expiresAt,
      });
    },

    async clearLease(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.clearLease, { laneId: args.laneId });
    },

    startStream: (args) => request(MAC_DESKTOP_DRIVER_OPS.startStream, {
      laneId: args.laneId,
      fps: args.fps,
    }),

    async setStreamRate(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.setStreamRate, { laneId: args.laneId, fps: args.fps });
    },

    async stopStream(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.stopStream, { laneId: args.laneId });
    },

    async startRecording(args) {
      await request(MAC_DESKTOP_DRIVER_OPS.startRecording, {
        laneId: args.laneId,
        fps: args.fps,
        filePath: args.filePath,
      });
    },

    stopRecording: (args) => request(
      MAC_DESKTOP_DRIVER_OPS.stopRecording,
      { laneId: args.laneId },
      { timeoutMs: RECORDING_STOP_TIMEOUT_MS },
    ),
  };
}
