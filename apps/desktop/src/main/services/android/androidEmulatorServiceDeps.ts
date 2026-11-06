import type {
  AndroidDeviceAnalyticsOutcome,
  AndroidEmulatorError,
  AndroidEmulatorEvent,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import type { AndroidEmulatorLaunch } from "./androidEmulatorProcess";
import type { AndroidEmulatorLifecycle } from "./androidEmulatorSweep";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";
import type { AndroidArtifactFiler } from "./androidProof";
import type { AndroidEnv } from "./androidSdk";
import type { AndroidStreamHub } from "./androidStream";

/*
 * The inputs of `createAndroidEmulatorService` and its state for one lane,
 * split out of `androidEmulatorService.ts`. Types and one constant only.
 */

/** A first boot of a new AVD measured 54 s on Windows; slower hosts need more. */
export const ANDROID_BOOT_TIMEOUT_MS = 180_000;

export type AndroidEmulatorServiceDeps = {
  /** The lane rows (`lane_android_devices`); `sqlAndroidLaneDeviceRepo(db)` in the app. */
  laneDevices: AndroidLaneDeviceRepo;
  /**
   * ADE's folder for this service's own files: the started-emulators state
   * file, the emulator logs, default screenshots.
   */
  dataDir: string;
  /** The bundled scrcpy server (`resolveScrcpyServerJarPath`). */
  serverJarPath: string;
  /**
   * The process's streams (`createAndroidStreamHub`), shared by every service
   * the process builds. Absent = a hub of this service's own.
   */
  streamHub?: AndroidStreamHub;
  /**
   * The lane's worktree. A screenshot `outPath` resolves against it and must
   * stay inside it; without one, a call that names an `outPath` is refused.
   */
  resolveLaneWorktreePath?: (laneId: string) => string | null;
  /**
   * The project's root, where chats on other machines keep their work copies
   * (`remoteWorkCopyService`). Without it a `remote-work-…` lane is refused.
   */
  projectRoot?: string | null;
  logger?: Logger | null;
  /** The SDK the user picked in Settings, read on every use. */
  readSdkSettingPath?: () => string | null;
  /**
   * P1 setup: the machine's Android settings file (`<ADE home>/android/settings.json`),
   * where "Use mine…" and a chosen install folder are kept. Also read for the SDK
   * when `readSdkSettingPath` is absent.
   */
  sdkSettingsFile?: string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
  discoveryDirs?: readonly string[];
  bootTimeoutMs?: number;
  /**
   * The brain sets this. Its exits are restarts (an update, a service
   * restart, a crash), so `dispose` leaves ADE's emulators running, they
   * start in their own process group, and the next service re-adopts them
   * through the state file. An in-process runtime leaves it off: closing the
   * project there stops every emulator ADE started for it.
   */
  handOffOnDispose?: boolean;
  /**
   * The brain's emulator lifecycle (`androidEmulatorSweep.ts`), one per
   * process: the machine-wide owner record of each emulator this service
   * starts, the "last used" clock and the pin, the sweep that stops idle and
   * abandoned emulators, and the memory guard's count of other brains'
   * boots. Absent (tests, the desktop's in-process copy): none of that, and
   * the guard counts this process's boots only.
   */
  emulatorLifecycle?: AndroidEmulatorLifecycle | null;
  now?: () => Date;
  onEvent?: (event: AndroidEmulatorEvent) => void;
  /**
   * P1 agent suite: the proof drawer (`computerUseArtifactBrokerService`). A
   * screenshot and a stopped recording file themselves into it under the
   * calling chat and the lane (`androidProof.ts`). Absent = captures stay
   * files only.
   */
  artifactFiler?: AndroidArtifactFiler | null;
  /**
   * One coarse product fact for each outcome in
   * `ANDROID_DEVICE_ANALYTICS_OUTCOMES` (an SDK or image install, an app
   * install, a filed render, a new lease, a fold, a preview render, a test
   * run; `captureAndroidDeviceAnalytics`). A failed or refused call sends nothing.
   */
  captureAnalytics?: (outcome: AndroidDeviceAnalyticsOutcome) => void;
};

/** The service's state for one lane. */
export type AndroidLaneState = {
  laneId: string;
  /** The tail of this lane's lifecycle queue. */
  queue: Promise<unknown>;
  transient: "starting" | "stopping" | null;
  /** The last start that failed or the emulator that died; cleared by a start or stop. */
  error: AndroidEmulatorError | null;
  /** The emulator this process launched for the lane, while it runs. */
  launch: AndroidEmulatorLaunch | null;
  /** Set by a stop that arrived while the start was booting. */
  stopRequested: boolean;
  /** That stop's end of the booting emulator, so the failing start does not stop it twice. */
  launchStop: Promise<void> | null;
  /** The serial the lane's stream runs on, while it runs. */
  streamSerial: string | null;
  /** A viewer asked for the stream (`startStream`); a recording may hold it too. */
  streamViewer: boolean;
};
