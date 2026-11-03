import { IPC } from "../shared/ipc";
import type { OpenProjectBinding } from "../shared/types";
import type {
  AndroidAttachDeviceArgs,
  AndroidCreateDeviceArgs,
  AndroidDeviceInventory,
  AndroidEmulatorEvent,
  AndroidEmulatorPreloadApi,
  AndroidEmulatorStatus,
  AndroidKeyArgs,
  AndroidLaneArgs,
  AndroidLaneDeviceStatus,
  AndroidReleaseDeviceArgs,
  AndroidRotateArgs,
  AndroidScreenshot,
  AndroidScreenshotArgs,
  AndroidStartStreamArgs,
  AndroidStreamStatus,
  AndroidTextArgs,
  AndroidTouchArgs,
} from "../shared/types/androidEmulator";

/**
 * `window.ade.androidEmulator`, built from a table the way `macDesktop` is.
 *
 * Every method routes through the `android_emulator` action domain and falls
 * back to this process's own IPC channel. The emulator lives on the machine
 * that owns the lane, so a pinned call must reach that machine; the local arm
 * only answers when this main process constructed the service.
 */

export type AndroidEmulatorBridgeDeps = {
  /** `callAndroidEmulatorActionOr`: the action domain first, `local` only as its fallback. */
  callAction: <T>(
    pin: OpenProjectBinding | null | undefined,
    action: string,
    request: { args?: Record<string, unknown> },
    local: () => Promise<T>,
  ) => Promise<T>;
  /** `ipcRenderer.invoke`, for the local arm only. */
  invoke: (channel: string, args: unknown) => Promise<unknown>;
  /** Rewrites the host's loopback URL for this desktop, forwarding if remote. */
  resolveStreamUrl: AndroidEmulatorPreloadApi["resolveStreamUrl"];
  onEvent: (
    cb: (event: AndroidEmulatorEvent) => void,
    pin?: OpenProjectBinding | null,
  ) => () => void;
};

export function createAndroidEmulatorBridge(deps: AndroidEmulatorBridgeDeps): AndroidEmulatorPreloadApi {
  /** One routed method: action name, then the local channel behind it. */
  const call = <A, R>(action: string, channel: string) =>
    (args: A, pin?: OpenProjectBinding | null): Promise<R> =>
      deps.callAction<R>(
        pin,
        action,
        { args: args as Record<string, unknown> },
        () => deps.invoke(channel, args) as Promise<R>,
      );

  /** The same routed method, for the reads whose argument is optional. */
  const callOptional = <A, R>(action: string, channel: string) => {
    const routed = call<A, R>(action, channel);
    return (args: A = {} as A, pin?: OpenProjectBinding | null): Promise<R> => routed(args, pin);
  };

  return {
    getStatus: callOptional<{ laneId?: string | null }, AndroidEmulatorStatus>(
      "getStatus",
      IPC.androidEmulatorGetStatus,
    ),
    listDevices: callOptional<{ laneId?: string | null }, AndroidDeviceInventory>(
      "listDevices",
      IPC.androidEmulatorListDevices,
    ),
    createDevice: call<AndroidCreateDeviceArgs, AndroidLaneDeviceStatus>("createDevice", IPC.androidEmulatorCreateDevice),
    attachDevice: call<AndroidAttachDeviceArgs, AndroidLaneDeviceStatus>("attachDevice", IPC.androidEmulatorAttachDevice),
    start: call<AndroidLaneArgs, AndroidLaneDeviceStatus>("start", IPC.androidEmulatorStart),
    stop: call<AndroidLaneArgs, AndroidLaneDeviceStatus>("stop", IPC.androidEmulatorStop),
    releaseDevice: call<AndroidReleaseDeviceArgs, { released: boolean; deletedAvd: string | null }>(
      "releaseDevice",
      IPC.androidEmulatorReleaseDevice,
    ),
    deleteDevice: call<{ avdName: string }, { deleted: boolean }>("deleteDevice", IPC.androidEmulatorDeleteDevice),
    /** The only call that hands out the stream token; never cached, never logged. */
    startStream: call<AndroidStartStreamArgs, AndroidStreamStatus>("startStream", IPC.androidEmulatorStartStream),
    stopStream: call<AndroidLaneArgs, AndroidStreamStatus>("stopStream", IPC.androidEmulatorStopStream),
    getStreamStatus: call<AndroidLaneArgs, AndroidStreamStatus>("getStreamStatus", IPC.androidEmulatorGetStreamStatus),
    sendTouch: call<AndroidTouchArgs, void>("sendTouch", IPC.androidEmulatorSendTouch),
    sendKey: call<AndroidKeyArgs, void>("sendKey", IPC.androidEmulatorSendKey),
    sendText: call<AndroidTextArgs, void>("sendText", IPC.androidEmulatorSendText),
    rotate: call<AndroidRotateArgs, void>("rotate", IPC.androidEmulatorRotate),
    screenshot: call<AndroidScreenshotArgs, AndroidScreenshot>("screenshot", IPC.androidEmulatorScreenshot),
    /**
     * Turn the host's loopback stream URL into one this desktop can open. Not a
     * routed action: the forward is built by this process.
     */
    resolveStreamUrl: deps.resolveStreamUrl,
    onEvent: deps.onEvent,
  };
}
