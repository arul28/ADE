/**
 * The Mac Desktop namespace for the hosted web client.
 *
 * The desktop's own namespace is a superset: it carries the permission and
 * Windows-setup steps, which belong to the machine itself. This one is the
 * live-view cut plus takeover: a browser tab can start and stop the lane's
 * display, watch its stream, and — when the host advertises
 * `hello.features.macDesktopControl` — take the input lease and drive the
 * pointer through `macDesktop.input`. A host that also serves the window and
 * capture commands (`supportsFullPane`) gets the desktop's full Work-tools
 * pane: window list, Add app, Record and Save screenshot.
 *
 * Members the full pane calls take the Electron contract's trailing runtime
 * pin. The federated adapter routes a pinned call to its machine's adapter;
 * here the pin is only checked against this adapter's own machine.
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
  MacDesktopClaimArgs,
  MacDesktopGetStatusArgs,
  MacDesktopInputResult,
  MacDesktopLeaseState,
  MacDesktopOpenArgs,
  MacDesktopOpenResult,
  MacDesktopRecordStartArgs,
  MacDesktopRecordingStatus,
  MacDesktopReleaseArgs,
  MacDesktopScreenshotArgs,
  MacDesktopScreenshotResult,
  MacDesktopStartArgs,
  MacDesktopStatus,
  MacDesktopStopArgs,
  MacDesktopStopResult,
  MacDesktopWindow,
  MacDesktopWindowActionArgs,
  MacDesktopWindowActionResult,
} from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopInputCall,
  SyncMacDesktopStatus,
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
  SyncMacDesktopStreamSubscribeResult,
} from "../../../shared/types/sync";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";
import type { AdapterInfra } from "./types";

/**
 * The commands the full pane needs beyond takeover. A host missing any one of
 * them keeps the web client on its watch-only pane, because a button that
 * fails its first call is worse than no button.
 */
export const MAC_DESKTOP_FULL_PANE_ACTIONS = [
  "macDesktop.getStatus",
  "macDesktop.start",
  "macDesktop.stop",
  "macDesktop.listWindows",
  "macDesktop.open",
  "macDesktop.claimWindow",
  "macDesktop.releaseWindow",
  "macDesktop.closeWindow",
  "macDesktop.screenshot",
  "macDesktop.startRecording",
  "macDesktop.stopRecording",
] as const;

/**
 * The sync status as the pane reads it: `recordingState` (the recording with
 * its host path removed) is the pane's `recording`.
 */
function paneStatus(status: SyncMacDesktopStatus | MacDesktopStatus | null): MacDesktopStatus | null {
  if (!status) return null;
  if (!("recordingState" in status)) return status as MacDesktopStatus;
  const { recordingState, ...rest } = status;
  return { ...rest, recording: recordingState ?? null } as MacDesktopStatus;
}

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
  getStatus: (args?: MacDesktopGetStatusArgs, pin?: RuntimePinArg) => Promise<MacDesktopStatus | null>;
  start: (args: MacDesktopStartArgs, pin?: RuntimePinArg) => Promise<MacDesktopStatus | null>;
  stop: (args: MacDesktopStopArgs, pin?: RuntimePinArg) => Promise<MacDesktopStopResult | null>;
  /**
   * The watch-only Stop. Signs the private screen out through the
   * viewer-allowed `macDesktop.stopPrivate` command, so a phone or a
   * non-controller browser tab can stop the lane's Windows screen.
   */
  stopPrivate: (args: { laneId: string }) => Promise<MacDesktopStopResult | null>;
  /**
   * The watch-only Stop for the lane's Windows screen on either seat (private
   * or the user's main desktop), through the viewer-allowed
   * `macDesktop.stopSeat`. A Mac lane's display is refused by the host.
   */
  stopSeat: (args: { laneId: string }) => Promise<MacDesktopStopResult | null>;
  /** The host advertises `macDesktop.stopSeat`; an older one only has `stopPrivate`. */
  supportsStopSeat: () => boolean;
  /**
   * Both halves of the host contract — the `macDesktopStream` feature bit and
   * the `macDesktop.streamSubscribe` command — because either one missing
   * means the live view would mount and then fail its first RPC.
   */
  supportsLiveStream: (pin?: RuntimePinArg) => boolean;
  streamSubscribe: (
    args: MacDesktopStreamSubscribeArgs,
    pin?: RuntimePinArg,
  ) => Promise<SyncMacDesktopStreamSubscribeResult | null>;
  streamUnsubscribe: (args: { subscriptionId: string }, pin?: RuntimePinArg) => Promise<unknown>;
  onStreamRecord: (listener: (record: SyncMacDesktopStreamRecordPayload) => void, pin?: RuntimePinArg) => () => void;
  onStreamEnded: (listener: (ended: SyncMacDesktopStreamEndedPayload) => void, pin?: RuntimePinArg) => () => void;
  /**
   * Transport + readiness transitions, so a view can drop its subscription
   * when the socket closes and re-subscribe after the reconnect handshake.
   */
  onConnectionChange: (listener: (connected: boolean) => void, pin?: RuntimePinArg) => () => void;
  /**
   * Whether takeover is available here: the `macDesktopControl` feature bit
   * and the `macDesktop.takeControl` command, both halves again.
   */
  supportsMacDesktopControl: (pin?: RuntimePinArg) => boolean;
  /**
   * Whether the host serves the desktop's full pane: the live stream, takeover
   * and every command in `MAC_DESKTOP_FULL_PANE_ACTIONS`.
   */
  supportsFullPane: (pin?: RuntimePinArg) => boolean;
  takeControl: (args: MacDesktopWebControlArgs, pin?: RuntimePinArg) => Promise<MacDesktopLeaseState | null>;
  returnControl: (
    args: Omit<MacDesktopWebControlArgs, "controllerLabel">,
    pin?: RuntimePinArg,
  ) => Promise<MacDesktopLeaseState | null>;
  /**
   * Heartbeat. A renewal that answers null means the lease is gone.
   *
   * The desktop pane renews with `{ holderId }`, its own controller id. Here
   * that same value is the per-tab token, so `holderId` is read as the token
   * when `controllerId` is absent; the host derives the real holder either way.
   */
  renewLease: (
    args: { laneId: string; controllerId?: string; holderId?: string },
    pin?: RuntimePinArg,
  ) => Promise<MacDesktopLeaseState | null>;
  /**
   * One forwarded real-input call. The host forces `silent`, strips every
   * caller-asserted identity and re-fills the derived controller id.
   */
  input: (
    args: { laneId: string; call: SyncMacDesktopInputCall },
    pin?: RuntimePinArg,
  ) => Promise<MacDesktopInputResult | null>;
  /** Every window on the host's screen with no lane, or the lane's own. */
  listWindows: (args?: { laneId?: string | null }, pin?: RuntimePinArg) => Promise<MacDesktopWindow[]>;
  open: (args: MacDesktopOpenArgs, pin?: RuntimePinArg) => Promise<MacDesktopOpenResult>;
  claimWindow: (args: MacDesktopClaimArgs, pin?: RuntimePinArg) => Promise<MacDesktopWindow>;
  releaseWindow: (args: MacDesktopReleaseArgs, pin?: RuntimePinArg) => Promise<{ released: number }>;
  closeWindow: (args: MacDesktopWindowActionArgs, pin?: RuntimePinArg) => Promise<MacDesktopWindowActionResult>;
  /** `filePath` comes back null: the file is the host's, the proof row is the way to it. */
  screenshot: (args: MacDesktopScreenshotArgs, pin?: RuntimePinArg) => Promise<MacDesktopScreenshotResult>;
  startRecording: (args: MacDesktopRecordStartArgs, pin?: RuntimePinArg) => Promise<MacDesktopRecordingStatus>;
  stopRecording: (
    args: { laneId: string; chatSessionId?: string | null },
    pin?: RuntimePinArg,
  ) => Promise<MacDesktopRecordingStatus>;
};

export function createMacDesktopNamespace(infra: AdapterInfra): MacDesktopWebApi {
  const { client, commands } = infra;
  const routable = (operation: string, pin: RuntimePinArg): void => {
    assertWebRuntimePinRoutable(operation, pin, infra);
  };
  /** A chat id for proof attribution, only when the pane names one. */
  const chat = (chatSessionId: string | null | undefined) => (chatSessionId ? { chatSessionId } : {});
  // Every window and capture command is a mutation or a controller read whose
  // empty answer would be a lie, so none of them resolves a fallback.
  const mutation = { fallback: null as never, idempotent: false } as const;
  return {
    // The literal action strings are scanned by
    // `adapter/__tests__/hostCommandContract.test.ts` against the host's
    // registry; keep them inline rather than behind a variable.
    getStatus: async (args, pin) => {
      routable("macDesktop.getStatus", pin);
      return paneStatus(await commands.call(
        "macDesktop.getStatus",
        { laneId: args?.laneId ?? null },
        { fallback: null as SyncMacDesktopStatus | null },
      ));
    },
    start: (args, pin) => {
      routable("macDesktop.start", pin);
      return commands.call(
        "macDesktop.start",
        {
          laneId: args.laneId,
          ...(args.laneName ? { laneName: args.laneName } : {}),
        },
        { fallback: null as MacDesktopStatus | null, idempotent: false },
      ).then(paneStatus);
    },
    stop: (args, pin) => {
      routable("macDesktop.stop", pin);
      return commands.call(
        "macDesktop.stop",
        { laneId: args.laneId },
        { fallback: null as MacDesktopStopResult | null, idempotent: false },
      );
    },
    stopPrivate: (args) =>
      commands.call(
        "macDesktop.stopPrivate",
        { laneId: args.laneId },
        { fallback: null as MacDesktopStopResult | null, idempotent: false },
      ),
    stopSeat: (args) =>
      commands.call(
        "macDesktop.stopSeat",
        { laneId: args.laneId },
        { fallback: null as MacDesktopStopResult | null, idempotent: false },
      ),
    supportsStopSeat: () => commands.hasAction("macDesktop.stopSeat"),
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
    supportsFullPane: () => client.supportsMacDesktopStream()
      && client.supportsMacDesktopControl()
      && MAC_DESKTOP_FULL_PANE_ACTIONS.every((action) => commands.hasAction(action)),
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
        { laneId: args.laneId, controllerId: args.controllerId ?? args.holderId },
        { fallback: null as MacDesktopLeaseState | null, idempotent: false },
      ),
    input: (args) =>
      commands.call(
        "macDesktop.input",
        { laneId: args.laneId, call: args.call },
        { fallback: null as MacDesktopInputResult | null, idempotent: false },
      ),
    listWindows: (args, pin) => {
      routable("macDesktop.listWindows", pin);
      return commands.call(
        "macDesktop.listWindows",
        { laneId: args?.laneId ?? null },
        { fallback: [] as MacDesktopWindow[], authoritative: true },
      );
    },
    open: (args, pin) => {
      routable("macDesktop.open", pin);
      return commands.call(
        "macDesktop.open",
        { laneId: args.laneId, target: args.target, ...(args.args ? { args: args.args } : {}) },
        mutation,
      );
    },
    claimWindow: (args, pin) => {
      routable("macDesktop.claimWindow", pin);
      return commands.call("macDesktop.claimWindow", { laneId: args.laneId, windowId: args.windowId }, mutation);
    },
    releaseWindow: (args, pin) => {
      routable("macDesktop.releaseWindow", pin);
      return commands.call(
        "macDesktop.releaseWindow",
        { laneId: args.laneId, ...(args.windowId != null ? { windowId: args.windowId } : {}) },
        mutation,
      );
    },
    closeWindow: (args, pin) => {
      routable("macDesktop.closeWindow", pin);
      return commands.call("macDesktop.closeWindow", { laneId: args.laneId, windowId: args.windowId }, mutation);
    },
    screenshot: (args, pin) => {
      routable("macDesktop.screenshot", pin);
      return commands.call(
        "macDesktop.screenshot",
        {
          laneId: args.laneId,
          ...(args.windowId != null ? { windowId: args.windowId } : {}),
          ...(args.caption ? { caption: args.caption } : {}),
          ...chat(args.chatSessionId),
        },
        mutation,
      );
    },
    startRecording: (args, pin) => {
      routable("macDesktop.startRecording", pin);
      return commands.call(
        "macDesktop.startRecording",
        {
          laneId: args.laneId,
          ...(args.caption ? { caption: args.caption } : {}),
          ...(args.fps != null ? { fps: args.fps } : {}),
          ...(args.keepIdle != null ? { keepIdle: args.keepIdle } : {}),
          ...(args.maxSeconds != null ? { maxSeconds: args.maxSeconds } : {}),
          ...chat(args.chatSessionId),
        },
        mutation,
      );
    },
    stopRecording: (args, pin) => {
      routable("macDesktop.stopRecording", pin);
      return commands.call(
        "macDesktop.stopRecording",
        { laneId: args.laneId, ...chat(args.chatSessionId) },
        mutation,
      );
    },
  };
}
