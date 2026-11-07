import type { AndroidEmulatorEvent, AndroidEmulatorServiceApi, AndroidStreamStatus } from "../../../shared/types/androidEmulator";
import type { AppleStreamOwningService } from "../ios/appleStreamRelayForService";
import { DEFAULT_ANDROID_MACHINE_PREFERENCES } from "../../../shared/types/androidEmulatorRecording";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import type { BootedDevice } from "./androidDeviceShell";
import { requireLaneId } from "./androidEmulatorErrors";
import { ANDROID_STREAM_DEFAULTS, asStreamFailure, type AndroidStreamHub } from "./androidStream";

/*
 * The lane's live stream: who holds it (a viewer on this machine, a remote
 * viewer through the relay, a recording), when it starts and when it stops.
 * The stream hub (`androidStream.ts`) runs one scrcpy stream per emulator;
 * this file keeps the lane's side of it.
 *
 * A phone or a web tab watches through the brain's stream relay
 * (`appleStreamRelayForService.ts`, the same relay as Apple's). A desktop on
 * another machine reads the same stream through a loopback forward and says
 * so with `remoteViewer`. `relaySource` is the relay's view of the lane.
 *
 * One encode per emulator, never two. The emulator's encoder is software
 * and a second scrcpy run doubles its CPU (see the README, "Remote viewers").
 * So the lane's stream has holders: the local viewer, a recording, the relay
 * and a remote desktop. The stream runs while any holder holds it, and its
 * bit rate follows the holders:
 *
 * - a local viewer or a recording holds it: the full default rate, so the
 *   picture on this machine and the recording are never capped;
 * - only remote viewers hold it: the machine's remote cap
 *   (`remoteBitrateKbpsCap`), lowered further by the relay's pacing when a
 *   viewer stalls and raised back when the link is quiet.
 *
 * A rate change restarts the scrcpy session on the same transport
 * (`AndroidStreamHub.recap`). The local viewer never sees one while it
 * watches: a cap applies only when no local viewer is there.
 *
 * A restart costs the viewers a short gap in the picture (0.5 to 4 s), and
 * the relay's pacing can ask for a new cap every 2 s while a link stalls. So
 * a cap change restarts the session at most once in
 * {@link RECAP_MIN_INTERVAL_MS}, and a raise (the link is quiet again, so it
 * is not urgent) at most once in {@link RECAP_RAISE_MIN_INTERVAL_MS}. A change
 * inside that time waits for its end and then applies the rate wanted at that
 * moment, so a run of steps costs one restart. The return to full rate for a
 * viewer here or a recording never waits.
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
  /** The relay started the stream for a phone or a web tab. */
  onRemoteViewerStarted?: () => void;
  /** The machine's remote cap in kbit/s, read on each change so a settings change lands. */
  remoteBitrateKbpsCap?: () => number;
};

/** The remote holders of one lane's stream, and the rate pacing chose. */
type RemoteHold = {
  relay: boolean;
  /** A desktop on another machine (`remoteViewer`). */
  desktop: boolean;
  recording: boolean;
  /** The relay's adaptive cap, below the machine's cap; null when untouched. */
  adaptiveKbps: number | null;
  /** The rate a local viewer asked for (`bitRateBps`); null is the default. */
  fullBitRate: number | null;
};

const NO_STREAM = { running: false, backend: null, transport: null, fps: null } as const;

/** The shortest time between two restarts of a lane's stream for a remote cap change. */
export const RECAP_MIN_INTERVAL_MS = 10_000;
/** The same for a raise of the remote cap: pacing steps up every 10 s, so about three steps go in one restart. */
export const RECAP_RAISE_MIN_INTERVAL_MS = 30_000;

/** One lane's restarts for a rate change: when the last began, and the change waiting for the interval. */
type RecapPacing = { lastAt: number; timer: ReturnType<typeof setTimeout> | null; dueAt: number };

export function createAndroidLaneStreams<S extends AndroidLaneStreamState>(deps: AndroidLaneStreamsDeps<S>) {
  const { streams, logger } = deps;
  const holds = new Map<string, RemoteHold>();
  const recaps = new Map<string, RecapPacing>();

  /** Drops the lane's waiting rate change (the stream stopped, or the rate is already right). */
  const cancelPendingRecap = (laneId: string): void => {
    const pacing = recaps.get(laneId);
    if (pacing?.timer) clearTimeout(pacing.timer);
    if (pacing) pacing.timer = null;
  };

  const holdOf = (laneId: string): RemoteHold => {
    let hold = holds.get(laneId);
    if (!hold) {
      hold = { relay: false, desktop: false, recording: false, adaptiveKbps: null, fullBitRate: null };
      holds.set(laneId, hold);
    }
    return hold;
  };

  /**
   * Every recording takes its hold through `holdForRecording`. Not
   * `deps.isRecording`: a recording that is finishing still reads as running
   * when it gives the stream back, and the stream must stop then.
   */
  const recordingHolds = (laneId: string): boolean => holds.get(laneId)?.recording === true;

  /** A viewer on this machine or a recording holds the stream: it runs at full rate. */
  const fullRateHeld = (laneId: string): boolean =>
    deps.peekLane(laneId)?.streamViewer === true || recordingHolds(laneId);

  const remoteHeld = (laneId: string): boolean => {
    const hold = holds.get(laneId);
    return Boolean(hold && (hold.relay || hold.desktop));
  };

  const machineCapKbps = (): number => {
    const cap = deps.remoteBitrateKbpsCap?.();
    return typeof cap === "number" && Number.isFinite(cap) && cap > 0
      ? Math.round(cap)
      : DEFAULT_ANDROID_MACHINE_PREFERENCES.remoteBitrateKbpsCap;
  };

  /** The rate the lane's encoder should run at now, in bit/s; null is the full default. */
  const wantedBitRate = (laneId: string): number | null => {
    if (fullRateHeld(laneId) || !remoteHeld(laneId)) return holds.get(laneId)?.fullBitRate ?? null;
    const ceiling = machineCapKbps();
    const adaptive = holds.get(laneId)?.adaptiveKbps ?? null;
    return Math.min(ceiling, adaptive ?? ceiling) * 1000;
  };

  /**
   * Puts the running stream at the rate its holders want. Never starts one.
   * Full rate for a viewer here or a recording applies at once; a remote cap
   * applies at most once per {@link RECAP_MIN_INTERVAL_MS} (see the top).
   */
  const retune = async (laneId: string): Promise<void> => {
    const serial = deps.peekLane(laneId)?.streamSerial ?? null;
    if (!serial) {
      cancelPendingRecap(laneId);
      return;
    }
    const bitRate = wantedBitRate(laneId);
    const runningKbps = streams.status(serial, laneId).capKbps ?? null;
    if (runningKbps !== null && runningKbps === Math.round((bitRate ?? ANDROID_STREAM_DEFAULTS.bitRate) / 1000)) {
      // Already at that rate: nothing to restart, and an older change waiting is moot.
      cancelPendingRecap(laneId);
      return;
    }
    let pacing = recaps.get(laneId);
    if (!pacing) {
      pacing = { lastAt: 0, timer: null, dueAt: 0 };
      recaps.set(laneId, pacing);
    }
    const raising = runningKbps !== null && bitRate !== null && bitRate / 1000 > runningKbps;
    const waitMs = fullRateHeld(laneId)
      ? 0
      : pacing.lastAt + (raising ? RECAP_RAISE_MIN_INTERVAL_MS : RECAP_MIN_INTERVAL_MS) - Date.now();
    if (waitMs > 0) {
      // A restart ran a moment ago: one more when the interval ends, at the
      // rate wanted then. A lowering may move a waiting raise earlier, never later.
      const dueAt = Date.now() + waitMs;
      if (pacing.timer && pacing.dueAt <= dueAt) return;
      cancelPendingRecap(laneId);
      const held = pacing;
      held.dueAt = dueAt;
      held.timer = setTimeout(() => {
        held.timer = null;
        void retune(laneId);
      }, waitMs);
      (held.timer as { unref?: () => void }).unref?.();
      return;
    }
    cancelPendingRecap(laneId);
    pacing.lastAt = Date.now();
    try {
      await streams.recap(serial, bitRate);
    } catch (error) {
      logger?.warn("android.stream_recap_failed", { laneId, serial, bitRate, error: getErrorMessage(error) });
    }
  };

  /** Stops the lane's stream, whoever holds it, and says so. */
  const stopRunning = async (state: S): Promise<void> => {
    cancelPendingRecap(state.laneId);
    recaps.delete(state.laneId);
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

  /** Ends the lane's stream: its recording first, then every holder and the stream. */
  const stopLaneStream = async (state: S): Promise<void> => {
    await deps.onStreamEnding(state.laneId);
    state.streamViewer = false;
    holds.delete(state.laneId);
    await stopRunning(state);
  };

  /** A holder let go: stop the stream when nobody holds it, else put it at the rate the rest want. */
  const releaseHolder = async (laneId: string): Promise<void> => {
    const state = deps.peekLane(laneId);
    if (!state) return;
    if (!fullRateHeld(laneId) && !remoteHeld(laneId)) {
      holds.delete(laneId);
      await stopRunning(state);
      return;
    }
    await retune(laneId);
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
    if (state.streamSerial && state.streamSerial !== serial) {
      // The emulator came back on another serial: the old stream ends, its
      // holders stay for the new one.
      await deps.onStreamEnding(laneId);
      await stopRunning(state);
    }
    // A new stream starts at the rate its holders want; a running one is retuned by the caller.
    const bitRate = options.bitRate ?? wantedBitRate(laneId) ?? undefined;
    const transport = await streams.startStream({
      adbPath, serial, serverJarPath: deps.serverJarPath, laneId, ...options, bitRate, logger,
    }).catch(asStreamFailure);
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
      const remote = args.remoteViewer === true;
      // Marked first, so a new stream starts at the right rate.
      if (remote) {
        holdOf(laneId).desktop = true;
      } else {
        deps.laneState(laneId).streamViewer = true;
        if (typeof args.bitRateBps === "number") holdOf(laneId).fullBitRate = args.bitRateBps;
      }
      let started: Awaited<ReturnType<typeof startLaneStream>>;
      try {
        started = await startLaneStream(laneId, {
          ...(typeof args.maxSize === "number" ? { maxSize: args.maxSize } : {}),
          ...(!remote && typeof args.bitRateBps === "number" ? { bitRate: args.bitRateBps } : {}),
          ...(typeof args.maxFps === "number" ? { maxFps: args.maxFps } : {}),
        });
      } catch (error) {
        if (remote) holdOf(laneId).desktop = false;
        else deps.laneState(laneId).streamViewer = false;
        throw error;
      }
      // A local viewer joining a capped stream lifts the cap before it reads,
      // so its first frame is already at full rate.
      await retune(laneId);
      const status = streams.status(started.serial, laneId);
      return { ...status, laneId, running: true, backend: "scrcpy", transport: started.transport };
    },

    async stopStream(args) {
      const laneId = requireLaneId(args.laneId);
      if (args.remoteViewer === true) {
        const hold = holds.get(laneId);
        if (hold) hold.desktop = false;
      } else {
        deps.laneState(laneId).streamViewer = false;
      }
      // A recording or another viewer still reads the stream: it stays, at
      // the rate the rest want.
      await releaseHolder(laneId);
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

    /**
     * Starts (or joins) the lane's stream for a recording; answers its serial.
     * A recording is never capped: a stream the remote viewers held at their
     * cap goes back to full rate before the first packet is taken.
     */
    async holdForRecording(laneId: string): Promise<string> {
      holdOf(laneId).recording = true;
      try {
        const { serial } = await startLaneStream(laneId);
        await retune(laneId);
        return serial;
      } catch (error) {
        holdOf(laneId).recording = false;
        throw error;
      }
    },

    /** The recording is done with the stream; it stops unless a viewer still watches. */
    async releaseForRecording(laneId: string): Promise<void> {
      const hold = holds.get(laneId);
      if (hold) hold.recording = false;
      await releaseHolder(laneId);
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
        const hold = holdOf(lane);
        hold.relay = true;
        hold.adaptiveKbps = null;
        let transport: Awaited<ReturnType<typeof startLaneStream>>["transport"];
        try {
          ({ transport } = await startLaneStream(lane));
        } catch (error) {
          hold.relay = false;
          throw error;
        }
        // Joined a stream nobody on this machine reads: it goes to the cap.
        await retune(lane);
        deps.onRemoteViewerStarted?.();
        return { transport };
      },
      /**
       * The relay's last viewer left. The relay calls this when it started the
       * stream; `liftStreamBitrateCap` below when it joined one. Both mean the
       * same here: the relay lets go, and the other holders decide.
       */
      async stopStream({ laneId }) {
        if (!laneId) return;
        const hold = holds.get(laneId);
        if (hold) {
          hold.relay = false;
          hold.adaptiveKbps = null;
        }
        await releaseHolder(laneId);
      },
      async liftStreamBitrateCap({ laneId }) {
        const hold = holds.get(laneId);
        if (hold) {
          hold.relay = false;
          hold.adaptiveKbps = null;
        }
        await releaseHolder(laneId);
      },
      /** Pacing lowered or raised the cap. Applied only while no full-rate holder is there. */
      async capLiveStream({ laneId, bitrateKbps }) {
        const hold = holds.get(laneId);
        if (!hold?.relay || !Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return;
        hold.adaptiveKbps = bitrateKbps >= machineCapKbps() ? null : Math.round(bitrateKbps);
        await retune(laneId);
      },
    } satisfies AppleStreamOwningService,

    /** The machine's remote cap, for the relay's ceiling. */
    remoteBitrateKbpsCap: machineCapKbps,

    /**
     * Someone uses the stream: a viewer here, a recording, or a remote viewer.
     * A stream with none of them (kept up after the last one left) is not use,
     * so the idle power-off does not wait on it.
     */
    held: (laneId: string): boolean => fullRateHeld(laneId) || remoteHeld(laneId),
  };
}
