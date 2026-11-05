/**
 * The Android emulator contract, P3 fold: the hinge of a foldable AVD.
 * Re-exported from `androidEmulator.ts`; import from there.
 *
 * The emulator has a virtual hinge sensor (`hinge-angle0`). Android turns the
 * angle into a device state (closed, half open, open) and shows the screen
 * that goes with it: the cover screen when closed, the inner one otherwise.
 */

import type { AndroidLaneArgs } from "./androidEmulator";

/** The named folds: open flat (180°), half open (90°, tabletop or book) and shut (0°). */
export const ANDROID_FOLD_POSES = ["open", "half", "closed"] as const;
export type AndroidFoldPose = (typeof ANDROID_FOLD_POSES)[number];

export const ANDROID_FOLD_POSE_ANGLES: Record<AndroidFoldPose, number> = {
  open: 180,
  half: 90,
  closed: 0,
};

export const ANDROID_HINGE_MIN_ANGLE = 0;
export const ANDROID_HINGE_MAX_ANGLE = 180;

/** What Android made of the angle (`dumpsys device_state`). */
export type AndroidFoldState = "closed" | "half-open" | "open";

export type AndroidPosture = {
  laneId: string;
  /** False on a device with no hinge: every other field is null. */
  supported: boolean;
  /** The hinge in degrees: 0 is shut, 180 is flat. */
  angle: number | null;
  /** Null while Android has not settled, or for a state ADE does not name. */
  state: AndroidFoldState | null;
  /** The screen in front, in pixels, in its natural orientation. */
  screen: { width: number; height: number } | null;
};

export type AndroidSetPostureArgs = AndroidLaneArgs & {
  /** Degrees, 0 to 180. Give this or `pose`. */
  angle?: number | null;
  pose?: AndroidFoldPose | null;
};

export type AndroidSetPostureResult = AndroidPosture & {
  /** False when Android did not finish the change in time; read `posture` again later. */
  settled: boolean;
};

export type AndroidEmulatorPostureServiceApi = {
  getPosture(args: AndroidLaneArgs): Promise<AndroidPosture>;
  /** Moves the hinge and waits until Android shows the screen that goes with it. */
  setPosture(args: AndroidSetPostureArgs): Promise<AndroidSetPostureResult>;
};
