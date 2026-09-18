/**
 * The Mac Desktop namespace for the hosted web client.
 *
 * The desktop's own namespace is a superset: it carries takeover, real input,
 * recording and window claiming, all of which need a local pointer and a local
 * renderer. This one is deliberately the read-only/live-view cut — a browser
 * tab can start and stop the lane's display and watch its stream, and nothing
 * here can move a pointer. Takeover stays a desktop-only move, which is what
 * `WORK_TOOLS_CONTROL_HINT` tells the viewer.
 *
 * `supportsLiveStream` and the push listeners are web-only members: the phone
 * has its own Swift client, and the Electron preload gets an IPC event fan-out.
 */

import type {
  MacDesktopGetStatusArgs,
  MacDesktopStartArgs,
  MacDesktopStatus,
  MacDesktopStopArgs,
  MacDesktopStopResult,
} from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
  SyncMacDesktopStreamSubscribeResult,
} from "../../../shared/types/sync";
import type { AdapterInfra } from "./types";

export type MacDesktopStreamSubscribeArgs = {
  laneId: string;
  subscriptionId: string;
  viewerLabel?: string | null;
};

export type MacDesktopWebApi = {
  getStatus: (args?: MacDesktopGetStatusArgs) => Promise<MacDesktopStatus | null>;
  start: (args: MacDesktopStartArgs) => Promise<MacDesktopStatus | null>;
  stop: (args: MacDesktopStopArgs) => Promise<MacDesktopStopResult | null>;
  /**
   * Both halves of the host contract — the `macDesktopStream` feature bit and
   * the `macDesktop.streamSubscribe` command — because either one missing
   * means the live view would mount and then fail its first RPC.
   */
  supportsLiveStream: () => boolean;
  streamSubscribe: (args: MacDesktopStreamSubscribeArgs) => Promise<SyncMacDesktopStreamSubscribeResult | null>;
  streamUnsubscribe: (args: { subscriptionId: string }) => Promise<unknown>;
  onStreamRecord: (listener: (record: SyncMacDesktopStreamRecordPayload) => void) => () => void;
  onStreamEnded: (listener: (ended: SyncMacDesktopStreamEndedPayload) => void) => () => void;
  /**
   * Transport + readiness transitions, so a view can drop its subscription
   * when the socket closes and re-subscribe after the reconnect handshake.
   */
  onConnectionChange: (listener: (connected: boolean) => void) => () => void;
};

export function createMacDesktopNamespace(infra: AdapterInfra): MacDesktopWebApi {
  const { client, commands } = infra;
  return {
    // The literal action strings are scanned by
    // `adapter/__tests__/hostCommandContract.test.ts` against the host's
    // registry; keep them inline rather than behind a variable.
    getStatus: (args) =>
      commands.call(
        "macDesktop.getStatus",
        { laneId: args?.laneId ?? null },
        { fallback: null as MacDesktopStatus | null },
      ),
    start: (args) =>
      commands.call(
        "macDesktop.start",
        {
          laneId: args.laneId,
          ...(args.laneName ? { laneName: args.laneName } : {}),
        },
        { fallback: null as MacDesktopStatus | null, idempotent: false },
      ),
    stop: (args) =>
      commands.call(
        "macDesktop.stop",
        { laneId: args.laneId },
        { fallback: null as MacDesktopStopResult | null, idempotent: false },
      ),
    supportsLiveStream: () => client.supportsMacDesktopStream(),
    streamSubscribe: (args) =>
      commands.call(
        "macDesktop.streamSubscribe",
        {
          laneId: args.laneId,
          subscriptionId: args.subscriptionId,
          ...(args.viewerLabel ? { viewerLabel: args.viewerLabel } : {}),
        },
        { fallback: null as SyncMacDesktopStreamSubscribeResult | null, idempotent: false },
      ),
    streamUnsubscribe: (args) =>
      commands.call(
        "macDesktop.streamUnsubscribe",
        { subscriptionId: args.subscriptionId },
        { fallback: null, idempotent: false },
      ),
    onStreamRecord: (listener) => client.onMacDesktopStreamRecord(listener),
    onStreamEnded: (listener) => client.onMacDesktopStreamEnded(listener),
    onConnectionChange: (listener) => client.subscribe((status) => {
      listener(status.state === "connected" && status.readiness === "ready");
    }),
  };
}
