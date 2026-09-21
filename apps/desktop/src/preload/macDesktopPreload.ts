import { IPC } from "../shared/ipc";
import type { OpenProjectBinding } from "../shared/types";
import type {
  MacDesktopActionResult,
  MacDesktopClaimArgs,
  MacDesktopClickArgs,
  MacDesktopDragArgs,
  MacDesktopEventPayload,
  MacDesktopGetStatusArgs,
  MacDesktopInputResult,
  MacDesktopLeaseState,
  MacDesktopMoveArgs,
  MacDesktopObservation,
  MacDesktopObserveArgs,
  MacDesktopOpenArgs,
  MacDesktopOpenResult,
  MacDesktopPermissions,
  MacDesktopPressArgs,
  MacDesktopPresentArgs,
  MacDesktopRecordStartArgs,
  MacDesktopRecordingStatus,
  MacDesktopRecheckPermissionsArgs,
  MacDesktopReleaseArgs,
  MacDesktopRequestPermissionArgs,
  MacDesktopScreenshotArgs,
  MacDesktopScreenshotResult,
  MacDesktopScrollArgs,
  MacDesktopStartArgs,
  MacDesktopStartStreamArgs,
  MacDesktopStatus,
  MacDesktopStopArgs,
  MacDesktopStopResult,
  MacDesktopStreamStatus,
  MacDesktopTakeoverArgs,
  MacDesktopTypeArgs,
  MacDesktopWaitArgs,
  MacDesktopWaitResult,
  MacDesktopWindow,
} from "../shared/types/macDesktop";

/**
 * `window.ade.macDesktop`, built from a table rather than written out 24 times.
 *
 * Every method is the same shape — route through the `mac_desktop` action
 * domain, fall back to this process's own IPC channel — and writing that shape
 * once is what keeps the routing honest: the runtime-backed build has no
 * in-process service, so a method that called `ipcRenderer.invoke` directly
 * would work in dev and throw in production. The action string and the channel
 * constant stay literal at each entry so both remain greppable.
 *
 * It lives outside `preload.ts` so a test can call every method against fakes.
 * The contract test used to read `preload.ts` as text and slice it by
 * indentation, which checked the formatting as much as the behaviour.
 */

export type MacDesktopBridgeDeps = {
  /** `callMacDesktopActionOr`: the action domain first, `local` only as its fallback. */
  callAction: <T>(
    pin: OpenProjectBinding | null | undefined,
    action: string,
    request: { args?: Record<string, unknown> },
    local: () => Promise<T>,
  ) => Promise<T>;
  /** `ipcRenderer.invoke`, for the local arm only. */
  invoke: (channel: string, args: unknown) => Promise<unknown>;
  /** Rewrites the host's loopback URL for this desktop, forwarding if remote. */
  resolveStreamUrl: (
    streamUrl: string | null,
    pin?: OpenProjectBinding | null,
  ) => Promise<{ url: string | null; forwarded: boolean; error: string | null }>;
  onEvent: (
    cb: (payload: MacDesktopEventPayload) => void,
    pin?: OpenProjectBinding | null,
  ) => () => void;
};

export function createMacDesktopBridge(deps: MacDesktopBridgeDeps) {
  /** One routed method: action name, then the local channel behind it. */
  const call = <A, R>(action: string, channel: string) =>
    (args: A, pin?: OpenProjectBinding | null): Promise<R> =>
      deps.callAction<R>(
        pin,
        action,
        { args: args as Record<string, unknown> },
        () => deps.invoke(channel, args) as Promise<R>,
      );

  /** The same routed method, for the two reads whose argument is optional. */
  const callOptional = <A, R>(action: string, channel: string) => {
    const routed = call<A, R>(action, channel);
    return (args: A = {} as A, pin?: OpenProjectBinding | null): Promise<R> => routed(args, pin);
  };

  return {
    getStatus: callOptional<MacDesktopGetStatusArgs, MacDesktopStatus>("getStatus", IPC.macDesktopGetStatus),
    recheckPermissions: callOptional<MacDesktopRecheckPermissionsArgs, MacDesktopPermissions>(
      "recheckPermissions",
      IPC.macDesktopRecheckPermissions,
    ),
    requestPermission: call<MacDesktopRequestPermissionArgs, MacDesktopPermissions>(
      "requestPermission",
      IPC.macDesktopRequestPermission,
    ),
    start: call<MacDesktopStartArgs, MacDesktopStatus>("start", IPC.macDesktopStart),
    stop: call<MacDesktopStopArgs, MacDesktopStopResult>("stop", IPC.macDesktopStop),
    listWindows: callOptional<{ laneId?: string | null }, MacDesktopWindow[]>("listWindows", IPC.macDesktopListWindows),
    open: call<MacDesktopOpenArgs, MacDesktopOpenResult>("open", IPC.macDesktopOpen),
    claimWindow: call<MacDesktopClaimArgs, MacDesktopWindow>("claimWindow", IPC.macDesktopClaimWindow),
    releaseWindow: call<MacDesktopReleaseArgs, { released: number }>("releaseWindow", IPC.macDesktopReleaseWindow),
    observe: call<MacDesktopObserveArgs, MacDesktopObservation>("observe", IPC.macDesktopObserve),
    click: call<MacDesktopClickArgs, MacDesktopActionResult>("click", IPC.macDesktopClick),
    type: call<MacDesktopTypeArgs, MacDesktopActionResult>("type", IPC.macDesktopType),
    press: call<MacDesktopPressArgs, MacDesktopActionResult>("press", IPC.macDesktopPress),
    scroll: call<MacDesktopScrollArgs, MacDesktopActionResult>("scroll", IPC.macDesktopScroll),
    drag: call<MacDesktopDragArgs, MacDesktopActionResult>("drag", IPC.macDesktopDrag),
    /** Silent by construction; see `MacDesktopMoveArgs`. */
    move: call<MacDesktopMoveArgs, MacDesktopInputResult>("move", IPC.macDesktopMove),
    wait: call<MacDesktopWaitArgs, MacDesktopWaitResult>("wait", IPC.macDesktopWait),
    screenshot: call<MacDesktopScreenshotArgs, MacDesktopScreenshotResult>("screenshot", IPC.macDesktopScreenshot),
    startRecording: call<MacDesktopRecordStartArgs, MacDesktopRecordingStatus>("startRecording", IPC.macDesktopStartRecording),
    stopRecording: call<{ laneId: string; chatSessionId?: string | null }, MacDesktopRecordingStatus>("stopRecording", IPC.macDesktopStopRecording),
    /** The only call that hands out the stream token; never cached, never logged. */
    startStream: call<MacDesktopStartStreamArgs, MacDesktopStreamStatus>("startStream", IPC.macDesktopStartStream),
    stopStream: call<{ laneId: string }, MacDesktopStreamStatus>("stopStream", IPC.macDesktopStopStream),
    getStreamStatus: call<{ laneId: string }, MacDesktopStreamStatus>("getStreamStatus", IPC.macDesktopGetStreamStatus),
    takeControl: call<MacDesktopTakeoverArgs, MacDesktopLeaseState>("takeControl", IPC.macDesktopTakeControl),
    returnControl: call<{ laneId: string; controllerId: string }, MacDesktopLeaseState | null>("returnControl", IPC.macDesktopReturnControl),
    renewLease: call<{ laneId: string; holderId: string }, MacDesktopLeaseState | null>("renewLease", IPC.macDesktopRenewLease),
    present: call<MacDesktopPresentArgs, { moved: number }>("present", IPC.macDesktopPresent),
    /**
     * Turn the host-encoded stream URL into one this desktop can open: the URL
     * names loopback on the Mac that owns the display, which is not this
     * machine whenever the lane is remote. Not a routed action — the forward
     * is built by this process.
     */
    resolveStreamUrl: deps.resolveStreamUrl,
    onEvent: deps.onEvent,
  };
}

export type MacDesktopBridge = ReturnType<typeof createMacDesktopBridge>;
