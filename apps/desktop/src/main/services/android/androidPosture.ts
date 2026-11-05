import {
  ANDROID_FOLD_POSE_ANGLES,
  ANDROID_FOLD_POSES,
  ANDROID_HINGE_MAX_ANGLE,
  ANDROID_HINGE_MIN_ANGLE,
  type AndroidEmulatorPostureServiceApi,
  type AndroidFoldState,
  type AndroidPosture,
  type AndroidSetPostureArgs,
  type AndroidSetPostureResult,
} from "../../../shared/types/androidEmulator";
import { sleep } from "../shared/utils";
import { runAdbOutput, runDeviceScript, runEmulatorConsole, type BootedDevice } from "./androidDeviceShell";
import { requireLaneId } from "./androidEmulatorErrors";
import { createAndroidLaneQueue } from "./androidLaneQueue";

/*
 * The hinge of a foldable AVD (P3 fold).
 *
 * The emulator console sets and reads the virtual hinge sensor
 * (`adb emu sensor set|get hinge-angle0`). Android turns the angle into a
 * device state with the AVD's posture ranges (the Pixel Fold profiles: shut
 * below 30°, half open to 150°, open above) and swaps the screen: the cover
 * screen when shut, the inner one otherwise. Measured on a Pixel 10 Pro Fold
 * AVD (macOS): the state changes in about 0.3 s and the screen in about 0.45 s.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const HINGE_SENSOR = "hinge-angle0";
/** How long `setPosture` waits for Android to show the new screen. */
const POSTURE_SETTLE_MS = 3_000;
const POSTURE_POLL_MS = 100;

/*
 * One device shell for the read: the committed and pending device state, the
 * angle Android last saw, the screen size and the size of a capture (the
 * screen in front). `screencap` warns on stderr that a foldable has two
 * displays; the header on stdout is the one in front.
 */
const READ_SCRIPT = [
  "dumpsys device_state | grep -E 'mCommittedState|mPendingState|hinge sensor'",
  "wm size",
  "echo \"capture=$(screencap 2>/dev/null | head -c 8 | od -An -tu4)\"",
].join("; ");

export type AndroidPostureDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** A fold swaps the screen: the lane's cached UI tree ends. */
  onScreenChanged: (laneId: string) => void;
  onPostureChanged: (laneId: string, posture: AndroidPosture) => void;
  signal: AbortSignal;
  now?: () => number;
};

/** What the device shell said, before it is joined with the console's angle. */
export type AndroidDevicePostureRead = {
  state: AndroidFoldState | null;
  /** True while Android has a state change pending. */
  pending: boolean;
  /** The angle the device-state service last saw, in degrees. */
  sensorAngle: number | null;
  screen: { width: number; height: number } | null;
  capture: { width: number; height: number } | null;
};

const FOLD_STATE_NAMES: Record<string, AndroidFoldState> = {
  CLOSED: "closed",
  HALF_OPENED: "half-open",
  OPENED: "open",
};

/** The console's `sensor get hinge-angle0` answer (`hinge-angle0 = 20`), or null for a device with no hinge. */
export function parseHingeAngle(text: string): number | null {
  const match = /hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/u.exec(text);
  return match ? Number(match[1]) : null;
}

/** The read script's output (see `READ_SCRIPT`). */
export function parseDevicePosture(text: string): AndroidDevicePostureRead {
  const committed = /mCommittedState=Optional\[DeviceState\{[^}]*name='([A-Z_]+)'/u.exec(text)?.[1] ?? null;
  const sensor = /hinge sensor\d* \(in degrees\)\s*:\s*\[(-?\d+(?:\.\d+)?)/u.exec(text)?.[1];
  const size = /Override size:\s*(\d+)x(\d+)/u.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/u.exec(text);
  const capture = /capture=\s*(\d+)\s+(\d+)/u.exec(text);
  return {
    state: committed ? FOLD_STATE_NAMES[committed] ?? null : null,
    pending: /mPendingState=Optional\[/u.test(text),
    sensorAngle: sensor === undefined ? null : Number(sensor),
    screen: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    capture: capture ? { width: Number(capture[1]), height: Number(capture[2]) } : null,
  };
}

/** The angle a `setPosture` asks for, checked: `angle` wins over `pose`. */
export function requestedHingeAngle(args: Pick<AndroidSetPostureArgs, "angle" | "pose">): number {
  if (args.angle !== undefined && args.angle !== null) {
    if (typeof args.angle !== "number" || !Number.isFinite(args.angle)) throw new Error("angle must be a number of degrees.");
    if (args.angle < ANDROID_HINGE_MIN_ANGLE || args.angle > ANDROID_HINGE_MAX_ANGLE) {
      throw new Error(`angle must be between ${ANDROID_HINGE_MIN_ANGLE} and ${ANDROID_HINGE_MAX_ANGLE} degrees.`);
    }
    return Math.round(args.angle);
  }
  const pose = args.pose;
  if (typeof pose === "string" && (ANDROID_FOLD_POSES as readonly string[]).includes(pose)) return ANDROID_FOLD_POSE_ANGLES[pose];
  throw new Error(`Give an angle (0 to 180) or a pose (${ANDROID_FOLD_POSES.join(", ")}).`);
}

/** Android is done with a fold: it saw the angle, it has no change pending, and a capture is the size of the screen in front. */
function settled(read: AndroidDevicePostureRead, angle: number): boolean {
  if (read.pending || read.sensorAngle === null || Math.abs(read.sensorAngle - angle) > 0.5) return false;
  if (!read.screen || !read.capture) return true;
  const { screen, capture } = read;
  // The capture is in the current rotation; the size is the natural one.
  return (capture.width === screen.width && capture.height === screen.height)
    || (capture.width === screen.height && capture.height === screen.width);
}

export function createAndroidPosture(deps: AndroidPostureDeps): AndroidEmulatorPostureServiceApi {
  const { signal } = deps;
  const now = deps.now ?? Date.now;
  /** One fold at a time per lane: a slider drag, a pinch and an agent can overlap. */
  const perLane = createAndroidLaneQueue();

  const consoleAngle = async (booted: BootedDevice): Promise<number | null> => {
    const answer = await runAdbOutput(booted, ["emu", "sensor", "get", HINGE_SENSOR], { timeoutMs: 15_000, signal });
    // A device with no hinge answers `KO: unknown sensor name` with exit 0.
    if (answer.exitCode !== 0) throw new Error(`The emulator console did not answer: ${answer.text.slice(0, 200) || `exit ${answer.exitCode}`}`);
    return parseHingeAngle(answer.text);
  };

  const readDevice = async (booted: BootedDevice) =>
    parseDevicePosture((await runDeviceScript(booted, READ_SCRIPT, { timeoutMs: 15_000, signal })).stdout);

  const posture = (laneId: string, angle: number | null, read: AndroidDevicePostureRead | null): AndroidPosture => (
    angle === null
      ? { laneId, supported: false, angle: null, state: null, screen: null }
      : { laneId, supported: true, angle, state: read?.state ?? null, screen: read?.screen ?? null }
  );

  const fold = async (laneId: string, angle: number): Promise<AndroidSetPostureResult> => {
    const booted = await deps.requireBooted(laneId);
    if ((await consoleAngle(booted)) === null) {
      throw new Error("This emulator has no hinge. Fold works on a foldable AVD, such as a Pixel Fold.");
    }
    await runEmulatorConsole(booted, ["sensor", "set", HINGE_SENSOR, String(angle)], "The emulator did not move the hinge", { signal });
    deps.onScreenChanged(laneId);
    const deadline = now() + POSTURE_SETTLE_MS;
    let read = await readDevice(booted);
    while (!settled(read, angle) && now() < deadline && !signal.aborted) {
      await sleep(POSTURE_POLL_MS);
      read = await readDevice(booted);
    }
    const done = settled(read, angle);
    // What the sensor reads, so a fold that did not settle never reports the angle it asked for.
    const result = posture(laneId, read.sensorAngle ?? angle, read);
    deps.onScreenChanged(laneId);
    deps.onPostureChanged(laneId, result);
    return { ...result, settled: done };
  };

  return {
    async getPosture(args) {
      const laneId = requireLaneId(args?.laneId);
      const booted = await deps.requireBooted(laneId);
      const angle = await consoleAngle(booted);
      return posture(laneId, angle, angle === null ? null : await readDevice(booted));
    },

    async setPosture(args) {
      const laneId = requireLaneId(args?.laneId);
      const angle = requestedHingeAngle(args ?? {});
      return perLane(laneId, () => fold(laneId, angle));
    },
  };
}
