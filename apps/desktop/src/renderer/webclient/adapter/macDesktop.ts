/**
 * The Mac Desktop namespace for the hosted web client.
 *
 * The desktop's own namespace is a superset: it carries recording and window
 * claiming, which need a local renderer. This one is the live-view cut plus
 * takeover: a browser tab can start and stop the lane's display, watch its
 * stream, and — when the host advertises `hello.features.macDesktopControl` —
 * take the input lease and drive the pointer through `macDesktop.input`.
 *
 * The takeover methods carry a per-tab `controllerId`, which is a TOKEN, not a
 * lease identity: the host derives the real holder id as
 * `web:<socket connection id>:<token>`, so a token lifted from one tab is
 * inert on another socket and a client can only renew or return its own lease.
 *
 * `supportsLiveStream`, `supportsMacDesktopControl` and the push listeners are
 * web-only members: the phone has its own Swift client, and the Electron
 * preload gets an IPC event fan-out.
 */

import type {
  MacDesktopGetStatusArgs,
  MacDesktopInputResult,
  MacDesktopLeaseState,
  MacDesktopStartArgs,
  MacDesktopStatus,
  MacDesktopStopArgs,
  MacDesktopStopResult,
} from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopInputCall,
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

export type MacDesktopWebControlArgs = {
  laneId: string;
  /** The caller's per-tab token. See the file header. */
  controllerId: string;
  controllerLabel?: string | null;
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
  /**
   * Whether takeover is available here: the `macDesktopControl` feature bit
   * and the `macDesktop.takeControl` command, both halves again.
   */
  supportsMacDesktopControl: () => boolean;
  takeControl: (args: MacDesktopWebControlArgs) => Promise<MacDesktopLeaseState | null>;
  returnControl: (args: Omit<MacDesktopWebControlArgs, "controllerLabel">) => Promise<MacDesktopLeaseState | null>;
  /** Heartbeat. A renewal that answers null means the lease is gone. */
  renewLease: (args: Omit<MacDesktopWebControlArgs, "controllerLabel">) => Promise<MacDesktopLeaseState | null>;
  /**
   * One forwarded real-input call. The host forces `silent`, strips every
   * caller-asserted identity and re-fills the derived controller id.
   */
  input: (args: { laneId: string; call: SyncMacDesktopInputCall }) => Promise<MacDesktopInputResult | null>;
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
    supportsMacDesktopControl: () => client.supportsMacDesktopControl(),
    // Every control call is a mutation: `idempotent: false` makes an
    // unsupported host reject rather than resolving the null fallback, so a
    // pane cannot report a takeover that never happened.
    takeControl: (args) =>
      commands.call(
        "macDesktop.takeControl",
        {
          laneId: args.laneId,
          controllerId: args.controllerId,
          ...(args.controllerLabel ? { controllerLabel: args.controllerLabel } : {}),
        },
        { fallback: null as MacDesktopLeaseState | null, idempotent: false },
      ),
    returnControl: (args) =>
      commands.call(
        "macDesktop.returnControl",
        { laneId: args.laneId, controllerId: args.controllerId },
        { fallback: null as MacDesktopLeaseState | null, idempotent: false },
      ),
    renewLease: (args) =>
      commands.call(
        "macDesktop.renewLease",
        { laneId: args.laneId, controllerId: args.controllerId },
        { fallback: null as MacDesktopLeaseState | null, idempotent: false },
      ),
    input: (args) =>
      commands.call(
        "macDesktop.input",
        { laneId: args.laneId, call: args.call },
        { fallback: null as MacDesktopInputResult | null, idempotent: false },
      ),
  };
}
