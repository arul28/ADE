import type { AndroidEmulatorEvent, AndroidEmulatorServiceApi, AndroidStreamStatus } from "../../../shared/types/androidEmulator";
import type { AppleRemoteViewerProbe, AppleStreamOwningService } from "../ios/appleStreamRelayForService";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import type { BootedDevice } from "./androidDeviceShell";
import { requireLaneId } from "./androidEmulatorErrors";
import { asStreamFailure, type AndroidStreamHub } from "./androidStream";

/*
 * The lane's live stream: who holds it (a viewer on this machine, a remote
 * viewer through the relay, a recording), when it starts and when it stops.
 * The stream hub (`androidStream.ts`) runs one scrcpy stream per emulator;
 * this file keeps the lane's side of it.
 *
 * A phone or a web tab watches through the brain's stream relay
 * (`appleStreamRelayForService.ts`, the same relay as Apple's). The relay
 * stops only the streams it started. `relaySource` is its view of the lane:
 * a relay start never marks the local viewer, and a local stop or the end of
 * a recording hands the stop to the relay while a remote viewer still reads.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The part of the service's lane state the stream reads and writes. */
export type AndroidLaneStreamState = {
  laneId: string;
  /** The serial the lane's stream runs on, while it runs. */
  streamSerial: string | null;
  /** A viewer asked for the stream (`startStream`); a recording may hold it too. */
  streamViewer: boolean;
};

export type AndroidLaneStreamsDeps<S extends AndroidLaneStreamState> = {
  streams: AndroidStreamHub;
  /** The lane's state, when there is one. */
  peekLane: (laneId: string) => S | undefined;
  /** The lane's state, made when there is none. */
  laneState: (laneId: string) => S;
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  assertLive: () => void;
  assertWorkCopyLive: (laneId: string) => void;
  serverJarPath: string;
  emit: (event: AndroidEmulatorEvent) => void;
  logger: Logger | null;
  /** A recording on the stream ends first, so its last frames reach the file. */
  onStreamEnding: (laneId: string) => Promise<void>;
  /** True while a recording holds the lane's stream. */
  isRecording: (laneId: string) => boolean;
};

const NO_STREAM = { running: false, backend: null, transport: null, fps: null } as const;

export function createAndroidLaneStreams<S extends AndroidLaneStreamState>(deps: AndroidLaneStreamsDeps<S>) {
  const { streams, logger } = deps;
  /** The relay's answer to "does a remote viewer still read this lane?". */
  let remoteViewers: AppleRemoteViewerProbe | null = null;

  /** A remote viewer reads the lane's stream: the relay takes over its stop. */
  const handStopToRelay = (laneId: string): boolean => {
    if (!remoteViewers?.watching(laneId)) return false;
    remoteViewers.adopt(laneId);
    return true;
  };

  /** Stops the lane's stream, whoever holds it, and says so. */
  const stopRunning = async (state: S): Promise<void> => {
    const serial = state.streamSerial;
    if (!serial) return;
    state.streamSerial = null;
    try {
      await streams.stopStream(serial);
    } catch (error) {
      logger?.warn("android.stream_stop_failed", { laneId: state.laneId, serial, error: getErrorMessage(error) });
    }
    deps.emit({ type: "android.stream.state", laneId: state.laneId, running: false });
  };

  /** Ends the lane's stream: its recording first, then the viewer and the stream. */
  const stopLaneStream = async (state: S): Promise<void> => {
    await deps.onStreamEnding(state.laneId);
    state.streamViewer = false;
    await stopRunning(state);
  };

  /** The serial of the lane's live stream, when one runs (input then goes through scrcpy). */
  const liveStreamSerial = (laneId: string): string | null => {
    const serial = deps.peekLane(laneId)?.streamSerial ?? null;
    return serial && streams.status(serial, laneId).running ? serial : null;
  };

  /** Starts the lane's stream, or joins the one running; answers its serial and transport. */
  const startLaneStream = async (
    laneId: string,
    options: { maxSize?: number; bitRate?: number; maxFps?: number } = {},
  ) => {
    const { serial, adbPath } = await deps.requireBooted(laneId);
    const state = deps.laneState(laneId);
    if (state.streamSerial && state.streamSerial !== serial) await stopLaneStream(state);
    const transport = await streams.startStream({ adbPath, serial, serverJarPath: deps.serverJarPath, laneId, ...options, logger })
      .catch(asStreamFailure);
    const fresh = state.streamSerial !== serial;
    state.streamSerial = serial;
    if (fresh) deps.emit({ type: "android.stream.state", laneId, running: true });
    return { serial, transport, state };
  };

  const api: Pick<AndroidEmulatorServiceApi, "startStream" | "stopStream" | "getStreamStatus"> = {
    async startStream(args) {
      deps.assertLive();
      const laneId = requireLaneId(args.laneId);
      deps.assertWorkCopyLive(laneId);
      const { serial, transport, state } = await startLaneStream(laneId, {
        ...(typeof args.maxSize === "number" ? { maxSize: args.maxSize } : {}),
        ...(typeof args.bitRateBps === "number" ? { bitRate: args.bitRateBps } : {}),
        ...(typeof args.maxFps === "number" ? { maxFps: args.maxFps } : {}),
      });
      state.streamViewer = true;
      const status = streams.status(serial, laneId);
      return { ...status, laneId, running: true, backend: "scrcpy", transport };
    },

    async stopStream(args) {
      const laneId = requireLaneId(args.laneId);
      const state = deps.laneState(laneId);
      if (deps.isRecording(laneId) || handStopToRelay(laneId)) {
        // A recording or a remote viewer still reads the stream: the viewer
        // goes, the stream stays.
        state.streamViewer = false;
        return { laneId, ...NO_STREAM };
      }
      await stopLaneStream(state);
      return { laneId, ...NO_STREAM };
    },

    async getStreamStatus(args) {
      const laneId = requireLaneId(args.laneId);
      const serial = deps.peekLane(laneId)?.streamSerial ?? null;
      const status: AndroidStreamStatus = serial ? streams.status(serial, laneId) : { laneId, ...NO_STREAM };
      // Redacted: the token is only for the viewer that started the stream.
      return { ...status, laneId, transport: null };
    },
  };

  return {
    api,
    stopLaneStream,
    liveStreamSerial,

    /** Starts (or joins) the lane's stream for a recording; answers its serial. */
    holdForRecording: async (laneId: string): Promise<string> => (await startLaneStream(laneId)).serial,

    /** The recording is done with the stream; it stops unless a viewer still watches. */
    async releaseForRecording(laneId: string): Promise<void> {
      const state = deps.peekLane(laneId);
      if (!state || state.streamViewer || handStopToRelay(laneId)) return;
      await stopRunning(state);
    },

    /**
     * The lane's stream as the relay drives it, for a phone or a web tab.
     * Watching never boots: a lane whose emulator is off refuses with
     * `ANDROID_NOT_RUNNING`, which the viewer shows.
     */
    relaySource: {
      getStreamStatus: ({ laneId }) => ({ running: Boolean(laneId && liveStreamSerial(laneId)) }),
      async startStream({ laneId }) {
        deps.assertLive();
        const lane = requireLaneId(laneId);
        deps.assertWorkCopyLive(lane);
        // One encode serves every viewer (see `ANDROID_STREAM_DEFAULTS`), so
        // the relay's bitrate cap is not applied: a cap would restart the
        // encoder under the local view.
        const { transport } = await startLaneStream(lane);
        return { transport };
      },
      async stopStream({ laneId }) {
        const state = laneId ? deps.peekLane(laneId) : undefined;
        if (!state || state.streamViewer || deps.isRecording(state.laneId)) return;
        await stopRunning(state);
      },
      hasLocalViewer: (laneId) => deps.peekLane(laneId)?.streamViewer === true,
      setRemoteViewerProbe: (probe) => {
        remoteViewers = probe;
      },
    } satisfies AppleStreamOwningService,
  };
}
