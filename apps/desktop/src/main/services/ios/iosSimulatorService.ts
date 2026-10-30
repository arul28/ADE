import { findRemoteWorkCopyForLane, isRemoteWorkLaneId } from "../remoteWork/remoteWorkCopyService";
import { parseForeignCallerSessionId } from "../../../shared/runtimeClientNames";
import { externalChatContext } from "../chat/externalChats";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppleRuntimeDeleteArgs,
  AppleDeviceAnalyticsOutcome,
  AppleRuntimeInstallArgs,
  AppleRuntimePruneArgs,
  AppleDeviceAttachArgs,
  AppleDeviceStartArgs,
  AppleDeviceStatePhase,
  AppleDeviceStopArgs,
  AppleDeviceStopResult,
  AppleDeviceCleanupArgs,
  AppleDeviceCleanupResult,
  AppleDeviceCreateArgs,
  AppleDeviceListArgs,
  AppleRunTestsArgs,
  AppleRunTestsResult,
  AppleInstallAppArgs,
  AppleInstallAppResult,
  AppleWindowLayoutArgs,
  AppleWindowLayoutResult,
  AppleDeviceListResult,
  AppleDeviceOrientation,
  AppleFrameArgs,
  AppleFrameResult,
  AppleHardwareButtonName,
  ApplePressButtonArgs,
  ApplePressButtonResult,
  AppleRotateArgs,
  AppleRotateFrame,
  AppleRotateResult,
  AppleScrollArgs,
  AppleScrollDirection,
  AppleScrollResult,
  AppleHelperToolInfo,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleRecordDeleteArgs,
  AppleRecordListArgs,
  AppleRecordStartArgs,
  AppleRecordStopArgs,
  IosElementContextItem,
  IosInspectableElement,
  IosInspectableFrame,
  IosInspectableScreen,
  IosInspectorSnapshot,
  IosScreenElement,
  IosScreenSnapshot,
  IosScreenSnapshotArgs,
  IosSimulatorClaimArgs,
  IosSimulatorEnsurePreviewWorkspaceArgs,
  IosSimulatorEnsurePreviewWorkspaceResult,
  IosSimulatorOpenPreviewWorkspaceArgs,
  IosSimulatorListPreviewsArgs,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorPreviewWindow,
  IosSimulatorRenderCurrentPreviewArgs,
  IosSimulatorRenderCurrentPreviewResult,
  IosSimulatorRenderPreviewArgs,
  IosSimulatorRenderPreviewResult,
  IosSimulatorDrawerMode,
  IosSimulatorEventPayload,
  IosSimulatorDragArgs,
  IosSimulatorInspectPointArgs,
  IosSimulatorInspectResult,
  IosSimulatorLaunchProgress,
  IosSimulatorLaunchStepId,
  IosSimulatorLaunchStepStatus,
  IosSimulatorPoint,
  IosSimulatorCapabilities,
  IosSimulatorDevice,
  IosSimulatorLaunchArgs,
  IosSimulatorLaunchResult,
  IosSimulatorLaunchTarget,
  IosSimulatorListLaunchTargetsArgs,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
  IosSimulatorStreamBackend,
  IosSimulatorStartStreamArgs,
  IosSimulatorStreamStatus,
  IosSimulatorToolStatus,
  IosSimulatorScreenshot,
  IosSimulatorScreenshotArgs,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorAppLifecycleArgs,
  IosSimulatorRelaunchArgs,
  IosSimulatorForegroundApp,
  IosSimulatorAssertVisibleArgs,
  IosSimulatorCloseDeviceArgs,
  IosSimulatorDeviceArgs,
  IosSimulatorEventLogArgs,
  IosSimulatorFillElementArgs,
  IosSimulatorFindElementArgs,
  IosSimulatorOpenDeviceArgs,
  IosSimulatorOpenUrlArgs,
  IosSimulatorProofBundleArgs,
  IosSimulatorPushArgs,
  IosSimulatorSetAccessibilityArgs,
  IosSimulatorSetAppearanceArgs,
  IosSimulatorSetContentSizeArgs,
  IosSimulatorSetLocationArgs,
  IosSimulatorSetPermissionArgs,
  IosSimulatorStartEventLogArgs,
  IosSimulatorStopEventLogArgs,
  IosSimulatorStatus,
  IosSimulatorStatusArgs,
  IosSimulatorStatusRecording,
  IosSimulatorStatusStream,
  IosSimulatorStatusBarArgs,
  IosSimulatorTapElementArgs,
  IosSimulatorUninstallAppArgs,
  IosSimulatorWaitForElementArgs,
} from "../../../shared/types";
import {
  APPLE_AGENT_ACTIONS,
  APPLE_BUTTON_UNSUPPORTED_CODE,
  APPLE_DEVICE_IS_EXTRA_CODE,
  APPLE_DEVICE_NOT_LANE_OWNED_CODE,
  APPLE_DEVICE_OFF_CODE,
  APPLE_DEVICE_ORIENTATIONS,
  APPLE_ROTATE_NOT_ADOPTED_CODE,
  APPLE_ROTATE_SEND_FAILED_CODE,
  APPLE_ROTATE_UNMEASURABLE_CODE,
  APPLE_SCROLL_DIRECTIONS,
  APPLE_HARDWARE_BUTTONS,
  APPLE_STREAM_NOT_RUNNING_CODE,
  APPLE_TEST_RUN_BUSY_CODE,
  IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE,
  IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE,
  IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE,
  IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE,
  IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
  IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE,
  APPLE_KEY_MODIFIER_USAGES,
  APPLE_NAMED_KEY_USAGES,
  appleKeyUsage,
  APPLE_LONG_PRESS_DEFAULT_MS,
  APPLE_LONG_PRESS_MAX_MS,
  APPLE_LONG_PRESS_MIN_MS,
  type IosSimulatorLongPressArgs,
  type IosSimulatorPressKeyArgs,
} from "../../../shared/types/iosSimulator";
import { abbreviatePathTail } from "../../../shared/pathDisplay";
import { APPLE_AUTO_RECORD_SETTING_KEY } from "../../../shared/appleDeviceSettings";
import { createAppleWindowControl } from "./appleWindowControl";
import { commandExistsCached } from "../ai/utils";
import type { Logger } from "../logging/logger";
import { pngDimensions } from "../shared/imageDimensions";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, isRecord, resolvePathWithinRoot, signalChildProcessTree } from "../shared/utils";
import { createIosDeviceHub, type IosDeviceHub } from "./iosDeviceHub";
import { buildElementRef, describeElement } from "./iosSemanticActions";
import { AppleDeviceExistsError, AppleDeviceNotLaneOwnedError, AppleLaneDeviceReleasedError } from "./appleDeviceErrors";
import { createLaneDeviceRegistry, type AppleLaneDeviceRelease } from "./laneDeviceRegistry";
import {
  appleDeviceDataRoot,
  appleInstalledSimulatorsFrom,
  deviceTypeBundlePath,
  deviceTypeScreenScale,
  parseAppleInstalledRuntimes,
  parseSimctlDevices,
} from "./appleSimulatorCatalog";
import { appleRuntimeScore } from "../../../shared/appleRuntimeVersions";
import { APPLE_RELEASES_FEED_URL, createAppleRuntimeManager, type AppleRuntimeManager } from "./appleRuntimeManager";
import { readAppleDeviceMarker } from "./appleDeviceMarker";

import { appleAppOnDevice, appleLaneDerivedDataPath, healMovedDerivedData } from "./laneDeviceRelease";
import { runXcodebuildTests } from "./appleTestRun";
import type { LaneDeviceStore } from "./laneDeviceRows";
import {
  createLaneDeviceMaintenance,
  describeDevicePowerOff,
  type AppleDevicePowerOffRecord,
  type LaneDeviceMaintenance,
} from "./laneDeviceMaintenance";
import {
  createSimHelperClient,
  resolveSimHelperExecutablePath,
  simHelperProtocolMessage,
  simHelperSearchSummary,
  SIM_HELPER_EXITED_EVENT,
  SimHelperError,
  type SimHelperClient,
  type SimHelperTransport,
} from "./simHelperClient";
import {
  createSimRecordingService,
  readArtifactId,
  type AppleInputSource,
  type SimRecording,
  type SimRecordingService,
  type SimRecordingServiceDeps,
} from "./recording/simRecordingService";
import { createLaneDeviceLifecycle } from "./laneDeviceLifecycle";
import { createAppleDuoService, parseHelperPosture } from "./appleDuoService";
import { createAppleDeviceLeases } from "./appleDeviceLease";
import { normalizeBuildConfiguration, normalizeLaunchArguments } from "./iosLaunchArgs";
import { appleDeviceTypeSupportsDuo, appleOrientationFamily, isAppleDeviceOrientation } from "../../../shared/appleOrientation";
import { createSimulatorPower } from "./simulatorPower";
import type { AppleRemoteViewerProbe } from "./appleStreamRelay";
import { SIMCTL_MISSING } from "../../../shared/xcodeToolchain";
import { AdeExpectedError } from "../../../shared/expectedError";

const execFile = promisify(execFileCallback);

const ADE_IOS_BUNDLE_ID = "com.ade.ios";
const ADE_IOS_PROJECT = path.join("apps", "ios", "ADE.xcodeproj");
const ADE_IOS_SCHEME = "ADE";
const ADE_IOS_INSPECTOR_SNAPSHOT_PATH = path.join("Documents", "ade-inspector-elements.json");
const IOS_APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";
const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";
const TOOL_STATUS_CACHE_MS = 10_000;
const SIMCTL_MISSING_RECHECK_MS = 60_000;
const STATUS_THROTTLE_MS = 500;
const DEVICE_LIST_THROTTLE_MS = 500;
const SIMCTL_BOOTSTATUS_TIMEOUT_MS = 90_000;
const SIMCTL_INSTALL_TIMEOUT_MS = 180_000;
// A swipe with no duration reads as a flick and does not scroll or drag.
const DEFAULT_SWIPE_DURATION_MS = 180;
/**
 * How far apart a drag's `move` events are.
 *
 * idb took a duration and did its own stepping; the helper's gesture IS the
 * move events, so the cadence lives here. 16ms is one display frame: coarser
 * reads as a flick to UIKit's velocity tracker, finer just costs round trips.
 */
const DRAG_STEP_MS = 16;
const INSTALL_HINT_XCODE = "Install Xcode from the App Store, then run xcode-select --install.";
const INSTALL_HINT_SIM_HELPER = "Install or update ADE.app on this Mac (or run `ade brain update`), then restart the ADE brain. In a source checkout: run `npm run build:sim-helper` in apps/desktop.";
const INSTALL_HINT_XCODE_CLI = "Run xcode-select --install to install the Xcode command line tools.";
const XCODE_MCP_SESSION_ID = "906026e2-d248-4770-8654-032d0e1fbb54";
const XCODE_MCP_APPROVAL_TIMEOUT_MS = 90_000;
const MACOS_ONLY_MESSAGE = "iOS Simulator control is only available on macOS.";
const SCREENSHOT_CACHE_SEGMENTS = [".ade", "cache", "ios-simulator", "screenshots"] as const;
const SCREENSHOT_KEEP_COUNT = 20;
/** Where a `frame` grab lands when the caller named no path. */
const FRAME_CACHE_SEGMENTS = [".ade", "cache", "ios-simulator", "frames"] as const;

/**
 * Helper `orientation` values. These match `HIDInjector`'s
 * UIInterfaceOrientation constants (landscape-right=3, landscape-left=4),
 * not UIDeviceOrientation, which swaps the two landscapes.
 */
const HELPER_ORIENTATION_VALUE: Record<AppleDeviceOrientation, number> = {
  portrait: 1,
  "portrait-upside-down": 2,
  "landscape-right": 3,
  "landscape-left": 4,
};

function isAppleHardwareButtonName(value: string): value is AppleHardwareButtonName {
  return (APPLE_HARDWARE_BUTTONS as readonly string[]).includes(value);
}

function frameAxis(frame: AppleRotateFrame): "portrait" | "landscape" | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (frame.width === frame.height) return null;
  return frame.width > frame.height ? "landscape" : "portrait";
}

/** How long to let iOS finish a rotation before calling it refused. */
const APPLE_ROTATE_SETTLE_TIMEOUT_MS = 3_000;
/** A Duo turn may wait twice (it resends once), so its control slot is longer than the default. */
const APPLE_ROTATE_CONTROL_TIMEOUT_MS = 12_000;
/** The longest drag the helper performs: under the 8 s control slot, which a gesture must not outlive. */
const MAX_SWIPE_DURATION_MS = 5_000;

/**
 * The framebuffer's pixel size, read from the device rather than from ADE.
 *
 * `simctl io screenshot` is the reading, not `simctl io enumerate`: enumerate
 * reports the display's NATIVE surface and does not move with the interface
 * (measured 2026-09-21 on a device sitting in landscape — screenshot said
 * 2622x1206, enumerate still said 1206x2622). The screenshot round-trip costs
 * about 390ms, which is the price of an answer that is true.
 *
 * Returns null when the reading cannot be taken at all, so a caller can say
 * "do not know" instead of guessing.
 */
async function readSimulatorFramebufferGeometry(deviceUdid: string): Promise<AppleRotateFrame | null> {
  const probePath = path.join(
    os.tmpdir(),
    `ade-orientation-probe-${randomUUID().slice(0, 8)}.png`,
  );
  try {
    await run("xcrun", ["simctl", "io", deviceUdid, "screenshot", "--type=png", probePath], {
      timeoutMs: 15_000,
    });
    const buffer = await fs.promises.readFile(probePath);
    const dimensions = pngDimensions(buffer);
    if (!dimensions?.width || !dimensions.height) return null;
    return { width: dimensions.width, height: dimensions.height };
  } catch {
    return null;
  } finally {
    // A probe is not an artifact. Leaving multi-megabyte PNGs in the temp dir
    // once per rotate is how a machine that is already short on disk runs out.
    await fs.promises.rm(probePath, { force: true }).catch(() => {});
  }
}

function isAppleScrollDirection(value: string): value is AppleScrollDirection {
  return (APPLE_SCROLL_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * One screenful, near enough, in device pixels.
 *
 * The helper's gain maps a wheel notch (~120) to a full-screen drag, so a
 * default of five notches is "keep going until I see something new" — the
 * amount an agent means when it asks to scroll and says nothing else. It
 * re-anchors past the bezel, so overshooting costs nothing.
 */
const APPLE_SCROLL_DEFAULT_AMOUNT = 600;

/**
 * Which picture an input's points are measured on (the helper's `space`). A
 * viewer (the pane, a remote window, the phone; all `source: "user"`) maps a
 * click onto the raw framebuffer it draws turned; everyone else measures on
 * what a screenshot and the accessibility tree show. The helper turns the
 * second onto the first where the picture sits turned on its framebuffer: any
 * device held landscape, and the iPhone Duo's inner display always.
 */
type HelperPointSpace = "frame" | "screen";

function inputPointSpace(source: AppleInputSource | undefined): HelperPointSpace {
  return source === "user" ? "frame" : "screen";
}

/**
 * Viewport direction to the helper's scroll delta, which reads like a wheel's:
 * positive `deltaY` reveals what is below (the helper swipes the finger up),
 * positive `deltaX` what is to the right. Measured on an iPhone 17 and the
 * iPhone Duo: the opposite signs, used until 2026-10, scrolled every agent
 * the wrong way.
 */
const APPLE_SCROLL_DELTAS: Record<AppleScrollDirection, (amount: number) => { deltaX: number; deltaY: number }> = {
  down: (amount) => ({ deltaX: 0, deltaY: amount }),
  up: (amount) => ({ deltaX: 0, deltaY: -amount }),
  right: (amount) => ({ deltaX: amount, deltaY: 0 }),
  left: (amount) => ({ deltaX: -amount, deltaY: 0 }),
};

type RunCommand = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
type SpawnProcess = typeof spawn;
type CommandExistsProbe = (command: string) => boolean;

function describeClaimAge(claimedAt: string | null | undefined): string | null {
  if (!claimedAt) return null;
  const claimedMs = Date.parse(claimedAt);
  if (!Number.isFinite(claimedMs)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - claimedMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Every error below states the FACT and the CODE and stops there.
 *
 * These messages are read by the drawer, the daemon action log, the iOS app,
 * and the CLI, and only the CLI knows the reader is at a terminal — so the
 * "now run `ade ios-sim ...`" half lives in `iosSimulatorErrorHint` in
 * apps/ade-cli/src/cli.ts, keyed off the code. Embedding a command here made
 * every other surface print a shell line its user could not run.
 */
export class IosSimulatorOwnedBySessionError extends Error {
  readonly code: typeof IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE = IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE;
  readonly currentChatSessionId: string | null;
  readonly currentSession: IosSimulatorSession | null;

  constructor(currentSession: IosSimulatorSession | null) {
    const owner = currentSession?.chatSessionId ?? null;
    const age = describeClaimAge(currentSession?.claimedAt ?? currentSession?.startedAt);
    super([
      `${IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE}: simulator is owned by chat session ${owner ?? "unknown"}`,
      currentSession?.laneId ? ` on lane ${currentSession.laneId}` : "",
      age ? ` (claimed ${age})` : "",
      ".",
    ].join(""));
    this.name = "IosSimulatorOwnedBySessionError";
    this.currentChatSessionId = owner;
    this.currentSession = currentSession;
  }
}

/**
 * A viewer asked to watch a device that is powered off.
 *
 * The message names the device and the one way on, because it reaches agents
 * as text: an agent that called `stream-start` without meaning to boot reads
 * it and runs `ade apple start`.
 */
export class AppleDeviceOffError extends Error {
  readonly code: typeof APPLE_DEVICE_OFF_CODE = APPLE_DEVICE_OFF_CODE;
  readonly udid: string;

  constructor(device: { udid: string; name: string }) {
    super(`${APPLE_DEVICE_OFF_CODE}: ${device.name} is off. Watching a device never boots it; start it with \`ade apple start\` or the pane's Start button.`);
    this.name = "AppleDeviceOffError";
    this.udid = device.udid;
  }
}

export class IosSimulatorLaunchInProgressError extends Error {
  readonly code: typeof IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE = IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE;
  readonly launchId: string;

  constructor(launchId: string) {
    super(`${IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE}: an iOS simulator launch (${launchId}) is already running.`);
    this.name = "IosSimulatorLaunchInProgressError";
    this.launchId = launchId;
  }
}

export class IosSimulatorTargetRootMismatchError extends Error {
  readonly code: typeof IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE = IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE;

  constructor(detail: string) {
    super(`${IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE}: ${detail}`);
    this.name = "IosSimulatorTargetRootMismatchError";
  }
}

/**
 * A lane was named but no worktree resolved for it. Falling back to the primary
 * checkout builds and screenshots code the lane agent never wrote, and every
 * assertion downstream passes against the wrong tree — so this is a hard stop.
 */
export class IosSimulatorLaneUnresolvedError extends Error {
  readonly code: typeof IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE = IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE;
  readonly laneId: string;

  constructor(laneId: string) {
    super(`${IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE}: no worktree resolved for lane ${laneId}, so there is no build root to use. Pass an explicit --project-root for the checkout you want.`);
    this.name = "IosSimulatorLaneUnresolvedError";
    this.laneId = laneId;
  }
}

/**
 * An `--out` path resolved outside the build root. Fact and code only — the CLI
 * layer owns the "run this instead" advice.
 */
export class IosSimulatorOutPathOutsideRootError extends Error {
  readonly code: typeof IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE = IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE;

  constructor(outPath: string, root: string) {
    // Says which paths ARE allowed: callers over MCP or the web see only this
    // message, not the CLI's hint.
    super(
      `${IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE}: ${outPath} is outside the build root ${root}. `
      + `--out must be a path inside that root; a relative path resolves under it (for example .ade/tmp/shot.png).`,
    );
    this.name = "IosSimulatorOutPathOutsideRootError";
  }
}

export class IosSimulatorNoBuildableTargetError extends Error {
  readonly code: typeof IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE = IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE;

  constructor(detail: string) {
    super(`${IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE}: ${detail}`);
    this.name = "IosSimulatorNoBuildableTargetError";
  }
}

type CreateIosSimulatorServiceArgs = {
  projectRoot: string;
  logger: Logger;
  onEvent?: ((payload: IosSimulatorEventPayload) => void) | null;
  /**
   * Maps a lane id to its worktree path. Without it a lane-scoped call falls
   * back to the primary checkout, which is how an agent could build code it
   * had not written.
   */
  resolveLaneWorktreePath?: ((laneId: string) => Promise<string | null> | string | null) | null;
  /**
   * The reverse: which lane's worktree contains this path.
   *
   * Synchronous, because `resolveRuntime` is. Without it a caller that names
   * no lane — every OpenCode agent, whose shell has no `ADE_LANE_ID` — is
   * resolved by guessing which lane is busy, and its captures land in a
   * stranger's proof drawer.
   */
  resolveLaneIdForPath?: ((absolutePath: string) => string | null) | null;
  /** Human name for a lane, used to name its simulator. */
  resolveLaneName?: ((laneId: string) => string | null) | null;
  /**
   * The lanes DB, for the `lane_apple_devices` table.
   *
   * Optional because the CLI's chat-only runtime has no database; the registry
   * then keeps lane devices in memory for the life of the process rather than
   * refusing to create one.
   */
  laneDeviceStore?: LaneDeviceStore | null;
  /** Unit 2C's recording service. Defaults to the inert stub. */
  recordingService?: SimRecordingService | null;
  /**
   * The halves of the recording service that live OUTSIDE this service.
   *
   * The helper transport is private to this file, so only this file can build
   * a recording service that can actually record. The proof-drawer broker, the
   * overlay settings, and the theme accent all live in `main.ts` / the CLI
   * bootstrap. Passing them in is what makes the constructed instance the wired
   * one, rather than a second, inert service shadowing it.
   */
  recordingDeps?: Pick<SimRecordingServiceDeps, "artifactFiler" | "readOverlaySetting" | "accentColor" | "fps">;
  /** One closed product fact per Apple panel outcome (`APPLE_DEVICE_ANALYTICS_OUTCOMES`); deduplicated by the caller. */
  captureAnalytics?: (outcome: AppleDeviceAnalyticsOutcome) => void;
  /**
   * Run the lane-device cleanup pass and idle power-off in the background
   * (`laneDeviceMaintenance.ts`). The hosts that own a project turn it on; a
   * service built for one call does not.
   */
  backgroundMaintenance?: boolean | null;
};

type RootScope = {
  projectRoot?: string | null;
  laneId?: string | null;
};

type ResolvedLaunchTarget = {
  target: IosSimulatorLaunchTarget;
  projectPath: string | null;
  scheme: string | null;
  bundleId: string | null;
  appBundlePath: string | null;
  shouldBuild: boolean;
  shouldInstall: boolean;
};

type PbxApplicationTarget = {
  id: string;
  targetName: string;
  productName: string;
};

type XcodeSchemeDefinition = {
  name: string;
  blueprintIdentifiers: string[];
  blueprintNames: string[];
  buildableNames: string[];
};

type IosSourceMatch = {
  sourceFile: string;
  sourceLine: number;
  confidence: "exact" | "candidate";
  reason: string;
  snippet: string | null;
};

type InferredSwiftUITabItem = {
  label: string;
  sourceFile: string;
  sourceLine: number;
  snippet: string | null;
  /** `Tab(…, role: .search)`: iOS draws it apart from the others, at the end. */
  searchRole: boolean;
};

/** The tabs of ONE `TabView` in the source, in source order. */
type InferredSwiftUITabGroup = {
  sourceFile: string;
  items: InferredSwiftUITabItem[];
};

type RawIosInspectorSnapshot = {
  schemaVersion?: number;
  generatedAt?: string;
  screen?: {
    width?: number;
    height?: number;
    scale?: number;
  };
  elements?: Array<{
    id?: string;
    componentId?: string;
    sourceFile?: string;
    sourceLine?: number;
    frame?: Partial<IosInspectableElement["frame"]>;
    pixelFrame?: Partial<IosInspectableElement["pixelFrame"]>;
    metadata?: Record<string, unknown>;
    accessibilityIdentifier?: string | null;
  }>;
};

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

type XcodeMcpPendingRequest = {
  description: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type XcodeMcpBridge = {
  child: ChildProcess;
  initialized: boolean;
  initializing: Promise<void> | null;
  nextId: number;
  pending: Map<number | string, XcodeMcpPendingRequest>;
  stderr: string;
  stdoutBuffer: Buffer<ArrayBufferLike>;
};

type SwiftPreviewDefinition = {
  title: string;
  line: number;
  index: number;
  kind: IosSimulatorPreviewTarget["kind"];
  position: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

const SIMCTL_SCREENSHOT_TIMEOUT_MS = 30_000;

function isTerminatedByTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === "SIGTERM";
}

/**
 * A failed `simctl io … screenshot`. It often exits with nothing on stderr but
 * its "Note: No display specified" line, so the error says how it ended (a
 * timeout, an exit code, a signal) instead of only echoing the command.
 */
function simctlScreenshotFailure(error: unknown, deviceName: string, timeoutMs: number): Error {
  if (isTerminatedByTimeout(error)) {
    return new Error(`Simulator ${deviceName} did not return a screenshot within ${Math.round(timeoutMs / 1000)}s. CoreSimulator may be stuck; shut that simulator down and try again.`);
  }
  if (!(error instanceof Error)) return new Error(String(error));
  const record = error as { code?: unknown; signal?: unknown };
  const ending = typeof record.code === "number"
    ? `exit code ${record.code}`
    : typeof record.signal === "string" && record.signal
      ? `signal ${record.signal}`
      : null;
  if (!ending || error.message.includes(ending)) return error;
  error.message = `${error.message.trimEnd()}\n(simctl ended with ${ending})`;
  return error;
}

function outputToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return "";
}

function commandFailureOutput(error: unknown): string {
  if (!error || typeof error !== "object") return error instanceof Error ? error.message : String(error);
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [
    outputToString(record.stderr),
    outputToString(record.stdout),
    typeof record.message === "string" ? record.message : null,
  ].filter((part): part is string => Boolean(part?.trim())).join("\n");
}

function buildFailureSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) => (
    /\berror:|fatal error:|BUILD FAILED|The following build commands failed|Provisioning profile|No such module|CodeSign|Signing for|Command SwiftCompile failed|Command CompileSwiftSources failed/i.test(line)
  ));
  const selected = important.length ? important : lines.slice(-30);
  return selected.slice(-40).join("\n").slice(0, 4000);
}

function formatXcodeBuildFailure(error: unknown, context: { projectPath: string; scheme: string; deviceName: string }): Error {
  const output = commandFailureOutput(error);
  const summary = buildFailureSummary(output);
  const resultBundle = /Writing error result bundle to\s+([^\n]+\.xcresult)/i.exec(output)?.[1]?.trim() ?? null;
  const schemeMissing = /does not contain a scheme named/i.test(output);
  const nextAction = schemeMissing
    ? "ADE could not find that scheme in the project. Refresh the iOS simulator drawer and choose one of the listed schemes; if Xcode only has a user-local scheme, share it from Xcode so command-line builds can see it."
    : "Open the project in Xcode or rerun the shown xcodebuild command to see the full compiler output, then fix the build error and launch again.";
  return new Error([
    `Could not build ${context.scheme} for ${context.deviceName}.`,
    `Project: ${context.projectPath}`,
    `Scheme: ${context.scheme}`,
    resultBundle ? `Result bundle: ${resultBundle}` : null,
    summary ? `Build output:\n${summary}` : null,
    `Next action: ${nextAction}`,
  ].filter(Boolean).join("\n"));
}

const defaultRunCommand: RunCommand = async (command, args, options = {}) => {
  const result = await execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
};

let run: RunCommand = defaultRunCommand;
let spawnProcess: SpawnProcess = spawn;
// Machine-wide and off the event loop once answered: every project's service
// asked again every 10 s with a synchronous login shell (about 35 ms each for
// xcrun and xcodebuild), on the brain's loop, on a project's first status read.
let commandExistsProbe: CommandExistsProbe = commandExistsCached;

/**
 * The helper-client factory, swappable for tests.
 *
 * A seam rather than an injected dep on `CreateIosSimulatorServiceArgs`: both
 * production hosts construct the service the same way and neither should have
 * to know the helper exists. The tests hand back a fake transport instead of
 * forking a Swift binary that needs a real simulator.
 */
let simHelperFactory: typeof createSimHelperClient = createSimHelperClient;

export function __testSetIosSimulatorHelperFactory(factory: typeof createSimHelperClient): () => void {
  const previous = simHelperFactory;
  simHelperFactory = factory;
  return () => {
    simHelperFactory = previous;
  };
}

export function __testSetIosSimulatorProcessHooks(hooks: {
  run?: RunCommand;
  spawn?: SpawnProcess;
  commandExists?: CommandExistsProbe;
}): () => void {
  const previous = { run, spawnProcess, commandExistsProbe };
  if (hooks.run) run = hooks.run;
  if (hooks.spawn) spawnProcess = hooks.spawn;
  if (hooks.commandExists) commandExistsProbe = hooks.commandExists;
  return () => {
    run = previous.run;
    spawnProcess = previous.spawnProcess;
    commandExistsProbe = previous.commandExistsProbe;
  };
}

export function shouldOpenSimulatorAppForLaunch(keepSimulatorInBackground?: boolean | null): boolean {
  return keepSimulatorInBackground !== true;
}

/**
 * Keeps a caller's scale or quality ratio inside what the helper accepts.
 *
 * `capture-start` takes `scale` as a fraction between 0 and 1 and refuses
 * anything else, so an out-of-range value is treated as "not asked for" rather
 * than passed through to fail the whole stream.
 */
export function clampStreamRatio(value: number | null | undefined): number | null {
  if (value == null) return null;
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return null;
  if (ratio <= 0 || ratio > 1) return null;
  return Math.round(ratio * 100) / 100;
}

/**
 * The encoder bitrate a caller asked for, in kbps, or null to leave the helper
 * at its default. Bounds match the helper protocol so a bad value is refused
 * here rather than as an NDJSON parse failure after the device has booted.
 */
export function clampStreamBitrateKbps(value: number | null | undefined): number | null {
  if (value == null) return null;
  const kbps = Number(value);
  if (!Number.isFinite(kbps)) return null;
  return Math.max(100, Math.min(20_000, Math.round(kbps)));
}

/**
 * The frame rate the stream asks the encoder for.
 *
 * `Math.round(NaN)` is NaN and every clamp around it keeps it, so a caller that
 * passed NaN or infinity used to reach the encoder as `fps: NaN`. The stream
 * then reported itself running and only failed when a viewer connected.
 */
export function clampStreamFps(value: number | null | undefined): number {
  const fps = Number(value ?? 60);
  if (!Number.isFinite(fps)) return 60;
  return Math.max(1, Math.min(60, Math.round(fps)));
}

/** There is one backend now; the name is kept so a status read still says which. */
export const IOS_SIMULATOR_STREAM_BACKEND: IosSimulatorStreamBackend = "helper-h264";

function encodeMcpMessage(message: JsonRpcMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function extractMcpMessages(buffer: Buffer<ArrayBufferLike>): { messages: JsonRpcMessage[]; rest: Buffer<ArrayBufferLike> } {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;
  while (rest.length) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = rest.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) break;
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      if (!Number.isFinite(length) || rest.length < start + length) break;
      const body = rest.subarray(start, start + length).toString("utf8");
      try {
        messages.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed frames from a crashing bridge; stderr carries details.
      }
      rest = rest.subarray(start + length);
      continue;
    }

    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.subarray(0, newline).toString("utf8").trim();
    rest = rest.subarray(newline + 1);
    if (!line.startsWith("{")) continue;
    try {
      messages.push(JSON.parse(line) as JsonRpcMessage);
    } catch {
      // Keep scanning; this fallback handles line-delimited JSON-RPC bridges.
    }
  }
  return { messages, rest: Buffer.from(rest) };
}

function disposeXcodeMcpBridge(bridge: XcodeMcpBridge, reason: Error): void {
  for (const [id, pending] of bridge.pending) {
    clearTimeout(pending.timer);
    pending.reject(reason);
    bridge.pending.delete(id);
  }
  bridge.child.stdout?.removeAllListeners();
  bridge.child.stderr?.removeAllListeners();
  bridge.child.removeAllListeners();
  if (bridge.child.exitCode == null && bridge.child.signalCode == null) bridge.child.kill("SIGTERM");
}

function handleXcodeMcpMessage(bridge: XcodeMcpBridge, message: JsonRpcMessage): void {
  if (message.id == null) return;
  const pending = bridge.pending.get(message.id);
  if (!pending) return;
  bridge.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) {
    pending.reject(new Error(message.error.message ?? `${pending.description} failed.`));
    return;
  }
  pending.resolve(message.result);
}

function createXcodeMcpBridge(onTerminated: (bridge: XcodeMcpBridge, reason: Error) => void): XcodeMcpBridge {
  const child = spawnProcess("xcrun", ["mcpbridge"], {
    env: {
      ...process.env,
      MCP_XCODE_SESSION_ID: XCODE_MCP_SESSION_ID,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridge: XcodeMcpBridge = {
    child,
    initialized: false,
    initializing: null,
    nextId: 1,
    pending: new Map(),
    stderr: "",
    stdoutBuffer: Buffer.alloc(0),
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    bridge.stderr = `${bridge.stderr}${chunk.toString()}`.slice(-8000);
  });
  child.once("error", (error) => {
    onTerminated(bridge, error);
  });
  child.once("exit", (code, signal) => {
    const detail = bridge.stderr.trim();
    onTerminated(bridge, new Error(detail || `xcrun mcpbridge exited with ${signal ?? code ?? "unknown status"}.`));
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    bridge.stdoutBuffer = Buffer.concat([bridge.stdoutBuffer, chunk]);
    const extracted = extractMcpMessages(bridge.stdoutBuffer);
    bridge.stdoutBuffer = extracted.rest;
    for (const message of extracted.messages) handleXcodeMcpMessage(bridge, message);
  });
  return bridge;
}

function sendXcodeMcpRequest(bridge: XcodeMcpBridge, method: string, params: unknown, timeoutMs: number, description: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = bridge.nextId++;
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new Error(`Timed out waiting for ${description}. If Xcode is showing an "Allow" prompt, click Allow and press Retry. If no prompt is visible, open Xcode > Settings > Intelligence and enable "Allow external agents to use Xcode tools" under Model Context Protocol.`));
    }, timeoutMs);
    timer.unref?.();
    bridge.pending.set(id, {
      description,
      reject,
      resolve,
      timer,
    });
    bridge.child.stdin?.write(encodeMcpMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }));
  });
}

async function ensureXcodeMcpInitialized(bridge: XcodeMcpBridge): Promise<void> {
  if (bridge.initialized) return;
  if (bridge.initializing) return bridge.initializing;
  bridge.initializing = (async () => {
    await sendXcodeMcpRequest(bridge, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "ADE iOS Simulator Preview Lab",
        version: "0.1.0",
      },
    }, 20_000, "Xcode MCP initialize");
    bridge.child.stdin?.write(encodeMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
    bridge.initialized = true;
  })().finally(() => {
    bridge.initializing = null;
  });
  return bridge.initializing;
}

function textFromMcpResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const toolResult = isRecord(record.result) ? record.result as McpToolCallResult : record as McpToolCallResult;
  const structured = isRecord(toolResult.structuredContent) ? JSON.stringify(toolResult.structuredContent) : null;
  const contentText = Array.isArray(toolResult.content)
    ? toolResult.content
      .map((entry) => typeof entry?.text === "string" ? entry.text : "")
      .filter(Boolean)
      .join("\n")
    : "";
  return structured ?? contentText;
}

function objectFromMcpResult(result: unknown): Record<string, unknown> {
  const record = isRecord(result) ? result : {};
  const toolResult = isRecord(record.result) ? record.result as McpToolCallResult : record as McpToolCallResult;
  if (isRecord(toolResult.structuredContent)) return toolResult.structuredContent;
  const text = textFromMcpResult(result).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Some Xcode tools return human-readable text; regex readers handle that.
  }
  return { message: text };
}

async function readPlistValue(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", `Print:${key}`, plistPath], { timeoutMs: 10_000 });
    const value = stdout.trim();
    return value.length ? value : null;
  } catch {
    return null;
  }
}

function targetId(parts: Array<string | null | undefined>): string {
  return Buffer.from(parts.filter(Boolean).join("|")).toString("base64url");
}

function decodeTargetId(id: string | null | undefined): string[] {
  if (!id) return [];
  try {
    return Buffer.from(id, "base64url").toString("utf8").split("|").filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeProjectPath(root: string, rawProjectPath?: string | null): string | null {
  if (!rawProjectPath) return null;
  const resolved = path.isAbsolute(rawProjectPath) ? rawProjectPath : path.join(root, rawProjectPath);
  return resolved.endsWith(".xcodeproj") && fs.existsSync(resolved) ? resolved : null;
}

function relativeToRoot(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : absolutePath;
}

function readSourceSnippet(projectRoot: string, sourceFile: string | null, sourceLine: number | null): string | null {
  if (!sourceFile || !sourceLine) return null;
  const filePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(projectRoot, sourceFile);
  const relative = path.relative(projectRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const lineIndex = Math.max(0, sourceLine - 1);
    const start = Math.max(0, lineIndex - 3);
    const end = Math.min(lines.length, lineIndex + 4);
    return lines
      .slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n");
  } catch {
    return null;
  }
}

function quotedSwiftLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectSwiftFiles(root: string): string[] {
  const iosRoot = path.join(root, "apps", "ios");
  const startRoot = fs.existsSync(iosRoot) ? iosRoot : root;
  const files: string[] = [];
  const skip = new Set([".build", ".git", "DerivedData", "Build", "node_modules"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 9) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(next, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        files.push(next);
      }
    }
  };
  walk(startRoot, 0);
  return files;
}

function resolveSwiftSourceFile(root: string, sourceFile?: string | null): string | null {
  const raw = sourceFile?.trim();
  if (!raw) return null;
  const candidates = [
    path.isAbsolute(raw) ? raw : path.join(root, raw),
    path.join(root, "apps", "ios", raw),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  const normalized = raw.replace(/\\/g, "/");
  return collectSwiftFiles(root).find((filePath) => {
    const relativeRoot = relativeToRoot(root, filePath).replace(/\\/g, "/");
    const relativeIos = path.relative(path.join(root, "apps", "ios"), filePath).replace(/\\/g, "/");
    return relativeRoot.endsWith(normalized)
      || relativeIos.endsWith(normalized)
      || path.basename(filePath) === path.basename(normalized);
  }) ?? null;
}

function resolveIosProjectDir(root: string): string {
  const projectPath = path.join(root, ADE_IOS_PROJECT);
  return fs.existsSync(projectPath) ? path.dirname(projectPath) : root;
}

function sourceFilePathForXcode(projectRoot: string, absoluteSourceFile: string): string {
  const iosProjectDir = resolveIosProjectDir(projectRoot);
  const relativeToProject = path.relative(iosProjectDir, absoluteSourceFile);
  if (relativeToProject && !relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject)) {
    return relativeToProject;
  }
  return relativeToRoot(projectRoot, absoluteSourceFile);
}

export function parseXcodePreviewWindows(raw: string, projectRoot: string): IosSimulatorPreviewWindow[] {
  const windows: IosSimulatorPreviewWindow[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
  const addWindow = (tabIdentifier: string, line: string) => {
    if (!tabIdentifier || seen.has(tabIdentifier)) return;
    seen.add(tabIdentifier);
    const workspacePath = /workspacePath\s*:\s*([^,\n]+)/i.exec(line)?.[1]?.trim()
      ?? /((?:\/[^,\n\t]+?)(?:\.xcworkspace|\.xcodeproj|\/apps\/ios|\/[^,\n\t]+ADE[^,\n\t]*))/i.exec(line)?.[1]?.trim()
      ?? null;
    const title = /(?:title|name|window|workspace)\s*[:=]\s*"?([^,"\n]+)"?/i.exec(line)?.[1]?.trim() ?? null;
    windows.push({
      tabIdentifier,
      title,
      workspacePath,
      raw: line.trim(),
    });
  };

  for (const line of lines) {
    const tabMatch = /tabIdentifier\s*:\s*([^,\s\n]+)/i.exec(line);
    if (tabMatch?.[1]) addWindow(tabMatch[1].trim(), line);
  }

  const uuidPattern = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
  const fullTextMatches = [...raw.matchAll(uuidPattern)];
  const sourceLines = lines.length ? lines : [raw];
  for (const match of fullTextMatches) {
    const tabIdentifier = match[0];
    const line = sourceLines.find((candidate) => candidate.includes(tabIdentifier)) ?? raw.slice(Math.max(0, match.index - 240), Math.min(raw.length, match.index + 420));
    addWindow(tabIdentifier, line);
  }
  if (!windows.length && raw.trim()) {
    windows.push({
      tabIdentifier: "",
      title: null,
      workspacePath: raw.includes(projectRoot) ? projectRoot : null,
      raw: raw.trim(),
    });
  }
  return windows;
}

function parseSwiftPreviewDefinitions(text: string): SwiftPreviewDefinition[] {
  const definitions: SwiftPreviewDefinition[] = [];
  const lineForPosition = (position: number) => text.slice(0, position).split(/\r?\n/).length;
  const macroPattern = /#Preview(?:\s*\(\s*"((?:\\.|[^"\\])+)")?/g;
  let macroMatch: RegExpExecArray | null;
  while ((macroMatch = macroPattern.exec(text)) !== null) {
    const title = macroMatch[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
    definitions.push({
      title: title?.length ? title : `Preview ${definitions.length + 1}`,
      line: lineForPosition(macroMatch.index),
      index: 0,
      kind: "preview-macro",
      position: macroMatch.index,
    });
  }
  const providerPattern = /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*PreviewProvider\b/g;
  let providerMatch: RegExpExecArray | null;
  while ((providerMatch = providerPattern.exec(text)) !== null) {
    definitions.push({
      title: providerMatch[1] ?? `PreviewProvider ${definitions.length + 1}`,
      line: lineForPosition(providerMatch.index),
      index: 0,
      kind: "preview-provider",
      position: providerMatch.index,
    });
  }
  return definitions
    .sort((a, b) => a.position - b.position)
    .map((definition, index) => ({ ...definition, index }));
}

function previewProximity(projectRoot: string, previewFile: string, selectedFile: string | null): IosSimulatorPreviewTarget["proximity"] {
  if (!selectedFile) return "project";
  if (path.resolve(previewFile) === path.resolve(selectedFile)) return "selected-file";
  const selectedDir = path.dirname(selectedFile);
  const previewDir = path.dirname(previewFile);
  const selectedFeature = path.relative(path.join(projectRoot, "apps", "ios", "ADE", "Views"), selectedDir).split(path.sep)[0];
  const previewFeature = path.relative(path.join(projectRoot, "apps", "ios", "ADE", "Views"), previewDir).split(path.sep)[0];
  if (selectedDir === previewDir || (selectedFeature && selectedFeature === previewFeature)) return "feature-file";
  return "project";
}

function humanizeSwiftName(name: string): string {
  const spaced = name
    .replace(/(?:View|Screen|Controller|Coordinator)$/u, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced || name;
}

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function previewSearchText(value: string | null | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function previewContextTerms(args: Pick<IosSimulatorListPreviewsArgs, "elementLabel" | "componentId">): string[] {
  const values = [
    args.elementLabel,
    args.componentId?.split(/[\\/]/).filter(Boolean).pop(),
  ];
  return Array.from(new Set(values.map(previewSearchText).filter((term) => term.length >= 3)));
}

function previewSuggestionForSource(
  projectRoot: string,
  selectedFile: string | null,
  args: Pick<IosSimulatorListPreviewsArgs, "elementLabel" | "componentId">,
): Pick<IosSimulatorPreviewMatch, "suggestedTitle" | "suggestedSourceFile" | "suggestedSourceFilePath"> {
  if (!selectedFile) {
    return {
      suggestedTitle: null,
      suggestedSourceFile: null,
      suggestedSourceFilePath: null,
    };
  }
  const rawIdentity = args.elementLabel?.trim()
    || args.componentId?.split(/[\\/]/).filter(Boolean).pop()?.trim()
    || humanizeSwiftName(path.basename(selectedFile, ".swift"));
  const title = `${titleCaseWords(humanizeSwiftName(rawIdentity))} Preview`;
  const selectedDir = path.dirname(selectedFile);
  const selectedBase = path.basename(selectedFile, ".swift").replace(/View$/u, "");
  const suggestedFile = path.join(selectedDir, `${selectedBase}Previews.swift`);
  return {
    suggestedTitle: title,
    suggestedSourceFile: relativeToRoot(projectRoot, suggestedFile),
    suggestedSourceFilePath: sourceFilePathForXcode(projectRoot, suggestedFile),
  };
}

const SWIFT_STRING_LABEL = /\b(?:Label|Text)\s*\(\s*"((?:\\.|[^"\\])+)"/;
const SWIFT_TAB_CALL = /\bTab\s*\(\s*"((?:\\.|[^"\\])+)"/;
const SWIFT_TAB_VIEW = /\bTabView\s*[({]/;

function unescapeSwiftString(raw: string): string {
  return raw.replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
}

/**
 * The tabs each SwiftUI `TabView` in the lane declares, one group per
 * `TabView`, so a label is never borrowed from an unrelated file or another
 * tab view. Two spellings: `.tabItem { Label("Library", …) }` (the label is
 * read inside the `.tabItem` closure, never from the tab's content before it,
 * which named a tab "Settings page" after its `Text`) and iOS 18's
 * `Tab("Search", systemImage: …, role: .search)`.
 */
function inferSwiftUITabGroups(projectRoot: string | null | undefined): InferredSwiftUITabGroup[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const groups: InferredSwiftUITabGroup[] = [];
  for (const filePath of collectSwiftFiles(root)) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(".tabItem") && !SWIFT_TAB_CALL.test(text)) continue;
    const sourceFile = relativeToRoot(root, filePath);
    const lines = text.split(/\r?\n/);
    // Keyed by the line of the `TabView` the tab sits under (-1: none seen).
    const byTabView = new Map<number, InferredSwiftUITabGroup>();
    const seenByTabView = new Map<number, Set<string>>();
    let tabViewLine = -1;
    const add = (label: string, line: number, searchRole: boolean) => {
      const seen = seenByTabView.get(tabViewLine) ?? new Set<string>();
      seenByTabView.set(tabViewLine, seen);
      if (!label || seen.has(label.toLowerCase())) return;
      seen.add(label.toLowerCase());
      let group = byTabView.get(tabViewLine);
      if (!group) {
        group = { sourceFile, items: [] };
        byTabView.set(tabViewLine, group);
      }
      group.items.push({
        label,
        sourceFile,
        sourceLine: line + 1,
        snippet: readSourceSnippet(root, sourceFile, line + 1),
        searchRole,
      });
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (SWIFT_TAB_VIEW.test(line)) tabViewLine = index;
      const tabCall = SWIFT_TAB_CALL.exec(line);
      if (tabCall?.[1]) {
        add(unescapeSwiftString(tabCall[1]), index, /role\s*:\s*\.search\b/.test(line));
        continue;
      }
      const tabItemAt = line.indexOf(".tabItem");
      if (tabItemAt < 0) continue;
      const searchEnd = Math.min(lines.length, index + 10);
      for (let cursor = index; cursor < searchEnd; cursor += 1) {
        const candidate = cursor === index ? line.slice(tabItemAt) : (lines[cursor] ?? "");
        // A second `.tabItem` before a label: this one had none.
        if (cursor > index && candidate.includes(".tabItem")) break;
        const match = SWIFT_STRING_LABEL.exec(candidate);
        if (!match?.[1]) continue;
        add(unescapeSwiftString(match[1]), cursor, false);
        break;
      }
    }
    for (const group of byTabView.values()) {
      if (group.items.length) groups.push({ ...group, items: group.items.slice(0, 12) });
    }
  }
  return groups;
}

function sourceTermsForElement(element: IosScreenElement): string[] {
  const raw = [
    element.label,
    element.identifier,
    element.value,
    element.componentId,
  ];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of raw) {
    const normalized = value?.trim();
    if (!normalized || normalized.length < 2 || seen.has(normalized.toLowerCase())) continue;
    const candidates = [
      normalized,
      ...normalized
        .split(/\s+[·•|]\s+|[,;:]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3),
    ];
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(candidate);
    }
  }
  return terms;
}

function swiftUiLiteralReason(trimmedLine: string, quoted: string): { reason: string; confidence: IosSourceMatch["confidence"] } | null {
  if (trimmedLine.startsWith("//") || trimmedLine.startsWith("///") || trimmedLine.startsWith("*")) return null;
  if (/^(?:(?:private|fileprivate|internal|public|static)\s+)*(?:let|var)\s+/.test(trimmedLine)) return null;
  const escaped = escapeRegExp(quoted);
  const modifier = (name: string) => (
    new RegExp(`\\.${name}\\s*\\([^\\n]*${escaped}`).test(trimmedLine)
    || new RegExp(`\\.${name}\\s*\\(\\s*Text\\s*\\(\\s*${escaped}`).test(trimmedLine)
  );
  const call = (name: string) => new RegExp(`\\b${name}\\s*\\(\\s*(?:verbatim:\\s*)?${escaped}`).test(trimmedLine);
  if (trimmedLine.includes(quoted)) {
    if (modifier("accessibilityLabel")) return { reason: `accessibilityLabel(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityIdentifier")) return { reason: `accessibilityIdentifier(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityValue")) return { reason: `accessibilityValue(${quoted})`, confidence: "exact" };
    if (modifier("accessibilityHint")) return { reason: `accessibilityHint(${quoted})`, confidence: "exact" };
    if (modifier("navigationTitle")) return { reason: `navigationTitle(${quoted})`, confidence: "exact" };
    for (const name of ["Text", "Button", "Label", "NavigationLink", "Toggle", "Picker", "Menu", "Section"]) {
      if (call(name)) return { reason: `${name}(${quoted})`, confidence: "exact" };
    }
    if (new RegExp(`\\bImage\\s*\\(\\s*systemName:\\s*${escaped}`).test(trimmedLine)) {
      return { reason: `Image(systemName: ${quoted})`, confidence: "exact" };
    }
  }
  return null;
}

function quotedSwiftStrings(line: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    out.push(match[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\") ?? "");
  }
  return out;
}

function swiftUiTermReason(trimmedLine: string, term: string): { reason: string; confidence: IosSourceMatch["confidence"] } | null {
  const exact = swiftUiLiteralReason(trimmedLine, quotedSwiftLiteral(term));
  if (exact) return exact;
  if (trimmedLine.startsWith("//") || trimmedLine.startsWith("///") || trimmedLine.startsWith("*")) return null;
  if (/^(?:(?:private|fileprivate|internal|public|static)\s+)*(?:let|var)\s+/.test(trimmedLine)) return null;
  const quoted = quotedSwiftStrings(trimmedLine);
  const lowerTerm = term.toLowerCase();
  const matchedLiteral = quoted.find((value) => value.toLowerCase().includes(lowerTerm));
  if (!matchedLiteral) return null;

  const quotedMatch = quotedSwiftLiteral(matchedLiteral);
  const construct = (name: string) => new RegExp(`\\.${name}\\s*\\(|\\b${name}\\s*\\(`).test(trimmedLine);
  if (construct("accessibilityLabel")) return { reason: `accessibilityLabel contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityIdentifier")) return { reason: `accessibilityIdentifier contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityValue")) return { reason: `accessibilityValue contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("accessibilityHint")) return { reason: `accessibilityHint contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  if (construct("navigationTitle")) return { reason: `navigationTitle contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  for (const name of ["Text", "Button", "Label", "NavigationLink", "Toggle", "Picker", "Menu", "Section"]) {
    if (construct(name)) return { reason: `${name} contains ${quotedSwiftLiteral(term)} in ${quotedMatch}`, confidence: "candidate" };
  }
  return null;
}

function isTrustedSourceMatch(match: IosSourceMatch): boolean {
  return match.confidence === "exact" && !match.reason.startsWith("contains");
}

function findSourceMatchesForElement(projectRoot: string | null | undefined, element: IosScreenElement): IosSourceMatch[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const terms = sourceTermsForElement(element);
  if (!terms.length) return [];
  const matches: IosSourceMatch[] = [];
  for (const filePath of collectSwiftFiles(root)) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const term of terms) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        const match = swiftUiTermReason(trimmed, term);
        if (!match) continue;
        const relativeFile = relativeToRoot(root, filePath);
        matches.push({
          sourceFile: relativeFile,
          sourceLine: index + 1,
          confidence: match.confidence,
          reason: match.reason,
          snippet: readSourceSnippet(root, relativeFile, index + 1),
        });
      }
    }
  }
  const score = (match: IosSourceMatch): number => {
    let value = match.confidence === "exact" ? 100 : 40;
    if (match.reason.startsWith("accessibilityLabel")) value += 40;
    if (match.reason.startsWith("accessibilityIdentifier")) value += 35;
    if (match.reason.startsWith("Button")) value += 25;
    if (match.reason.startsWith("Label")) value += 20;
    if (match.reason.startsWith("Text")) value += 15;
    if (/\/Views\//.test(match.sourceFile)) value += 10;
    return value;
  };
  const deduped = new Map<string, IosSourceMatch>();
  for (const match of matches) {
    const key = `${match.sourceFile}:${match.sourceLine}:${match.reason}`;
    if (!deduped.has(key)) deduped.set(key, match);
  }
  return Array.from(deduped.values())
    .sort((a, b) => score(b) - score(a) || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine)
    .slice(0, 5);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundFrame(frame: IosInspectableFrame | null | undefined): IosInspectableFrame | null {
  if (!frame) return null;
  return {
    x: rounded(frame.x),
    y: rounded(frame.y),
    width: rounded(frame.width),
    height: rounded(frame.height),
  };
}

function frameCenter(frame: IosInspectableFrame): { x: number; y: number } {
  return {
    x: frame.x + (frame.width / 2),
    y: frame.y + (frame.height / 2),
  };
}

function frameContainsFrame(outer: IosInspectableFrame, inner: IosInspectableFrame): boolean {
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
  );
}

function frameIntersectionArea(a: IosInspectableFrame, b: IosInspectableFrame): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function frameDistance(a: IosInspectableFrame, b: IosInspectableFrame): number {
  const centerA = frameCenter(a);
  const centerB = frameCenter(b);
  return Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
}

function compactScreenElement(element: IosScreenElement): Record<string, unknown> {
  return {
    id: element.id,
    source: element.source,
    layer: element.layer,
    label: element.label,
    value: element.value,
    role: element.role,
    elementType: element.elementType,
    identifier: element.identifier,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    frame: roundFrame(element.frame),
    screenshotFrame: roundFrame(element.pixelFrame),
  };
}

function nearbyScreenElements(snapshot: IosScreenSnapshot, selected: IosScreenElement, limit = 12): Array<Record<string, unknown>> {
  const selectedFrame = selected.pixelFrame;
  const relationFor = (otherFrame: IosInspectableFrame, intersection: number): string => {
    if (frameContainsFrame(otherFrame, selectedFrame)) return "ancestor-or-container";
    if (frameContainsFrame(selectedFrame, otherFrame)) return "descendant";
    if (intersection > 0) return "overlapping";
    return "nearby";
  };
  const relationBoostFor = (relation: string): number => {
    if (relation === "ancestor-or-container" || relation === "descendant") return -120;
    if (relation === "overlapping") return -80;
    return 0;
  };
  return snapshot.elements
    .filter((element) => element.id !== selected.id)
    .filter((element) => element.pixelFrame.width > 0 && element.pixelFrame.height > 0)
    .map((element) => {
      const intersection = frameIntersectionArea(selectedFrame, element.pixelFrame);
      const relation = relationFor(element.pixelFrame, intersection);
      const distance = frameDistance(selectedFrame, element.pixelFrame);
      const sameSourceBoost = element.source === selected.source ? 0 : 20;
      return {
        element,
        distance,
        relation,
        score: distance + sameSourceBoost + relationBoostFor(relation),
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ element, distance, relation }) => ({
      ...compactScreenElement(element),
      relation,
      distancePx: Math.round(distance),
    }));
}

function screenPacket(snapshot: IosScreenSnapshot): Record<string, unknown> {
  return {
    deviceUdid: snapshot.deviceUdid,
    capturedAt: snapshot.capturedAt,
    screenWidth: snapshot.screen.width,
    screenHeight: snapshot.screen.height,
    screenScale: snapshot.screen.scale,
    screenshotWidth: snapshot.screenshot.width,
    screenshotHeight: snapshot.screenshot.height,
  };
}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function normalizeLaunchMode(mode: unknown): "snapshot" | "live" {
  if (mode == null) return "snapshot";
  if (mode === "snapshot" || mode === "live") return mode;
  throw new Error("iOS Simulator launch mode must be `snapshot` or `live`.");
}

function normalizeLaunchEnvironment(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("iOS Simulator launch environment must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid iOS Simulator launch environment key: ${key}`);
    }
    if (rawValue == null) continue;
    normalized[key] = String(rawValue);
  }
  return normalized;
}


function normalizeCoordinate(value: unknown, label: string): number {
  const coordinate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(coordinate) || coordinate < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return coordinate;
}

function normalizeFrame(value: Partial<IosInspectableElement["frame"]> | undefined): IosInspectableElement["frame"] | null {
  if (!value) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function cleanClaimId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeAnyFrame(value: unknown): IosInspectableFrame | null {
  if (!isRecord(value)) return null;
  const direct = normalizeFrame(value);
  if (direct) return direct;
  const origin = isRecord(value.origin) ? value.origin : null;
  const size = isRecord(value.size) ? value.size : null;
  if (!origin || !size) return null;
  const x = readNumber(origin, ["x"]);
  const y = readNumber(origin, ["y"]);
  const width = readNumber(size, ["width", "w"]);
  const height = readNumber(size, ["height", "h"]);
  if ([x, y, width, height].every((number) => number != null)) {
    return { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 };
  }
  return null;
}

function containsPoint(frame: IosInspectableElement["pixelFrame"] | IosScreenElement["pixelFrame"], x: number, y: number): boolean {
  return (
    x >= frame.x
    && y >= frame.y
    && x <= frame.x + frame.width
    && y <= frame.y + frame.height
  );
}

function hasSelectableIdentity(element: IosScreenElement): boolean {
  return Boolean(
    element.sourceFile
    || element.componentId
    || element.identifier
    || element.label
    || element.value,
  );
}

function findSmallestScreenElementAt(elements: IosScreenElement[], x: number, y: number): IosScreenElement | null {
  const hits = elements.filter((element) => containsPoint(element.pixelFrame, x, y));
  const byArea = (a: IosScreenElement, b: IosScreenElement) => {
    const areaA = a.pixelFrame.width * a.pixelFrame.height;
    const areaB = b.pixelFrame.width * b.pixelFrame.height;
    if (areaA !== areaB) return areaA - areaB;
    return (a.label ?? a.componentId ?? a.id).localeCompare(b.label ?? b.componentId ?? b.id);
  };
  const describedHits = hits.filter(hasSelectableIdentity);
  const inspectorHits = describedHits.filter((element) => element.source === "ade-inspector").sort(byArea);
  if (inspectorHits.length) return inspectorHits[0] ?? null;
  if (describedHits.length) return describedHits.sort(byArea)[0] ?? null;
  return hits.sort(byArea)[0] ?? null;
}

function inspectorElementToScreenElement(element: IosInspectableElement): IosScreenElement {
  return {
    id: `ade-inspector:${element.id}`,
    source: "ade-inspector",
    layer: "app",
    label: typeof element.metadata.label === "string" ? element.metadata.label : element.componentId,
    value: typeof element.metadata.value === "string" ? element.metadata.value : null,
    role: typeof element.metadata.role === "string" ? element.metadata.role : null,
    elementType: typeof element.metadata.elementType === "string" ? element.metadata.elementType : null,
    identifier: element.accessibilityIdentifier ?? element.componentId,
    frame: element.frame,
    pixelFrame: element.pixelFrame,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    metadata: {
      ...element.metadata,
      inspectorElementId: element.id,
    },
  };
}

function accessibilityElementSignature(element: IosScreenElement): string {
  const frame = element.pixelFrame;
  const label = element.label ?? "";
  const identifier = element.identifier ?? "";
  return [
    Math.round(frame.x),
    Math.round(frame.y),
    Math.round(frame.width),
    Math.round(frame.height),
    identifier || label || element.role || element.elementType || "",
  ].join(":");
}

/** A number written as text that is not a number at all ("nan", "inf"). */
const NON_FINITE_VALUE = /^[+-]?(?:nan|inf(?:inity)?)$/i;

/**
 * An element's value as a person would read it. The app's own description
 * ("0:29 of 0:49", "50%") comes first: a SwiftUI adjustable element's raw
 * value is a number, NaN when the app set only a description, which read as
 * "nan". A value that is not a finite number is no value (an older helper
 * still writes "nan").
 */
function accessibilityValueOf(record: Record<string, unknown>): string | null {
  const value = readString(record, ["value", "AXValueDescription", "placeholderValue", "placeholder", "text", "AXValue"]);
  return value !== null && NON_FINITE_VALUE.test(value) ? null : value;
}

function collectAccessibilityElements(raw: unknown): IosScreenElement[] {
  const elements: IosScreenElement[] = [];
  const visit = (value: unknown, indexPath: number[]) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...indexPath, index]));
      return;
    }
    if (!isRecord(value)) return;
    const frame = normalizeAnyFrame(value.frame)
      ?? normalizeAnyFrame(value.rect)
      ?? normalizeAnyFrame(value.bounds);
    if (frame && frame.width > 0 && frame.height > 0) {
      const label = readString(value, ["label", "name", "title", "text", "accessibilityLabel", "AXLabel", "AXTitle"]);
      const identifier = readString(value, ["identifier", "accessibilityIdentifier", "id", "AXIdentifier", "AXUniqueId"]);
      const role = readString(value, ["role", "traits", "class", "type", "role_description"]);
      elements.push({
        id: `accessibility:${indexPath.join(".")}`,
        source: "accessibility",
        layer: "accessibility",
        label,
        value: accessibilityValueOf(value),
        role,
        elementType: readString(value, ["type", "className", "class"]),
        identifier,
        frame,
        pixelFrame: frame,
        componentId: null,
        sourceFile: null,
        sourceLine: null,
        metadata: value,
      });
    }
    for (const key of ["children", "subviews", "elements"]) {
      const child = value[key];
      if (child != null) visit(child, [...indexPath, elements.length]);
    }
  };
  visit(raw, []);
  return elements;
}

function inferAccessibilityScale(
  elements: IosScreenElement[],
  shot: IosSimulatorScreenshot,
): number | null {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!elements.length || width <= 0 || height <= 0) return null;

  const logicalWidth = elements.reduce((max, element) => Math.max(max, element.frame.x + element.frame.width), 0);
  const logicalHeight = elements.reduce((max, element) => Math.max(max, element.frame.y + element.frame.height), 0);
  const candidates = [1, 2, 3, 4];
  const usableRatios = [
    logicalWidth > 0 ? width / logicalWidth : null,
    logicalHeight > 0 ? height / logicalHeight : null,
  ].filter((ratio): ratio is number => Boolean(ratio && Number.isFinite(ratio) && ratio > 0));
  if (!usableRatios.length) return null;

  const averageRatio = usableRatios.reduce((sum, ratio) => sum + ratio, 0) / usableRatios.length;
  const nearestDeviceScale = candidates
    .map((scale) => ({ scale, distance: Math.abs(scale - averageRatio) }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearestDeviceScale && nearestDeviceScale.distance <= 0.65) {
    return nearestDeviceScale.scale;
  }
  return usableRatios[0] ?? null;
}

/**
 * The screenshot's scale from the helper's own point size for the screen on
 * show (the live stream's transport), when the two describe the same picture:
 * both axes give the same ratio. That is the plane `tap` maps into, so the
 * snapshot's `screen` then agrees with it. The element-frame guess picked @2x
 * for the Duo's inner panel, which is @3x.
 */
function measuredScreenshotScale(
  shot: IosSimulatorScreenshot,
  pointSize: { width: number; height: number } | null,
): number | null {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!pointSize || pointSize.width <= 0 || pointSize.height <= 0 || width <= 0 || height <= 0) return null;
  const across = width / pointSize.width;
  const down = height / pointSize.height;
  if (!Number.isFinite(across) || across <= 0 || Math.abs(across - down) / across > 0.02) return null;
  return across;
}

function scaleAccessibilityElementsToScreenshot(
  elements: IosScreenElement[],
  shot: IosSimulatorScreenshot,
  pointSize: { width: number; height: number } | null = null,
  deviceScale: number | null = null,
): { elements: IosScreenElement[]; screen: IosInspectableScreen | null } {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!elements.length || width <= 0 || height <= 0) {
    return { elements, screen: null };
  }
  // The stream's point size first, then the device type's own scale (a
  // screenshot is in the device's native pixels), and the guess from the
  // element frames only when neither is known.
  const scale = measuredScreenshotScale(shot, pointSize)
    ?? deviceScale
    ?? inferAccessibilityScale(elements, shot);
  if (!scale || !Number.isFinite(scale) || scale <= 0) {
    return { elements, screen: null };
  }
  const nextElements = elements.map((element) => ({
    ...element,
    pixelFrame: {
      x: element.frame.x * scale,
      y: element.frame.y * scale,
      width: element.frame.width * scale,
      height: element.frame.height * scale,
    },
  }));
  return {
    elements: nextElements,
    screen: {
      width: width / scale,
      height: height / scale,
      scale,
    },
  };
}

function mergeScreenElements(inspectorElements: IosScreenElement[], accessibilityElements: IosScreenElement[]): IosScreenElement[] {
  const merged = new Map<string, IosScreenElement>();
  for (const element of inspectorElements) {
    merged.set(accessibilityElementSignature(element), element);
  }
  for (const element of accessibilityElements) {
    const signature = accessibilityElementSignature(element);
    const existing = merged.get(signature);
    if (!existing) {
      merged.set(signature, element);
      continue;
    }
    merged.set(signature, {
      ...existing,
      label: existing.label ?? element.label,
      value: existing.value ?? element.value,
      role: existing.role ?? element.role,
      elementType: existing.elementType ?? element.elementType,
      identifier: existing.identifier ?? element.identifier,
      metadata: {
        ...existing.metadata,
        accessibility: element.metadata,
      },
    });
  }
  return Array.from(merged.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === "ade-inspector" ? -1 : 1;
    const areaA = a.pixelFrame.width * a.pixelFrame.height;
    const areaB = b.pixelFrame.width * b.pixelFrame.height;
    if (areaA !== areaB) return areaA - areaB;
    return (a.label ?? a.componentId ?? a.id).localeCompare(b.label ?? b.componentId ?? b.id);
  });
}

/** A tab bar ever shows at most this many tabs on an iPhone; more are behind "More". */
const MAX_COMPACT_TAB_SLOTS = 5;
/** The narrowest tab iOS draws; a bar too narrow for that many is minimised or not a bar. */
const MIN_TAB_SLOT_POINTS = 44;

function isTabBarElement(element: IosScreenElement): boolean {
  if (element.metadata?.synthetic === true) return false;
  const label = element.label?.toLowerCase() ?? "";
  const role = element.role?.toLowerCase() ?? "";
  const type = element.elementType?.toLowerCase() ?? "";
  return label === "tab bar" || (label.includes("tab") && (role.includes("group") || type.includes("group")));
}

function frameCenterInside(inner: IosInspectableFrame, outer: IosInspectableFrame): boolean {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
}

/** The tab items the accessibility tree itself shows inside a Tab Bar. */
function realTabItemsIn(bar: IosScreenElement, elements: IosScreenElement[]): IosScreenElement[] {
  const barArea = bar.frame.width * bar.frame.height;
  return elements.filter((element) => element !== bar
    && element.metadata?.synthetic !== true
    && Boolean(element.label?.trim())
    && element.frame.width > 0
    && element.frame.height > 0
    && element.frame.width * element.frame.height < barArea * 0.8
    && frameCenterInside(element.frame, bar.frame));
}

function tabLabelMatches(elementLabel: string, tabLabel: string): boolean {
  const left = elementLabel.trim().toLowerCase();
  const right = tabLabel.trim().toLowerCase();
  if (!right || !left.startsWith(right)) return false;
  return !/[\p{L}\p{N}]/u.test(left.charAt(right.length));
}

/**
 * SwiftUI tab items, from the source, matched to the Tab Bar on screen.
 *
 * When the bar exposes its own tab items (the usual case), nothing is
 * invented: each real item whose label a `TabView` declares gets that
 * declaration's file and line. Before this, ADE added equal slices of the bar
 * in source order next to the real items, so a tab label matched twice and a
 * tap could land on a slice that was not where the tab is drawn (ledger #4,
 * #35: a search-role tab is drawn last, out of source order).
 *
 * Only when the bar exposes no items at all are slices made, and only when
 * they can be right: the labels come from one `TabView`, no tab has the
 * search role (drawn apart, so the slices would be out of order), there are
 * no more of them than an iPhone bar shows, and each slice is at least a
 * tab's width (a minimised bar is narrower). The slices say they are
 * inferred (`metadata.synthetic`), sort after every element read from the
 * screen, and `tap-element` refuses one (it names the point to tap instead).
 *
 * The lane's sources are read only when the screen has a Tab Bar.
 */
function applySwiftUITabBarSource(projectRoot: string | null | undefined, elements: IosScreenElement[]): IosScreenElement[] {
  const tabBars = elements.filter(isTabBarElement);
  if (!tabBars.length) return elements;
  const groups = inferSwiftUITabGroups(projectRoot);
  if (!groups.length) return elements;
  // A label names a source line only when one TabView declares it.
  const byLabel = new Map<string, InferredSwiftUITabItem | null>();
  for (const group of groups) {
    for (const item of group.items) {
      const key = item.label.toLowerCase();
      const known = byLabel.get(key);
      byLabel.set(key, known === undefined ? item : null);
    }
  }
  const sourced = new Map<IosScreenElement, InferredSwiftUITabItem>();
  const synthesized: IosScreenElement[] = [];
  for (const tabBar of tabBars) {
    if (tabBar.frame.width <= 0 || tabBar.pixelFrame.width <= 0) continue;
    const realItems = realTabItemsIn(tabBar, elements);
    if (realItems.length) {
      for (const element of realItems) {
        if (element.sourceFile) continue;
        const label = element.label ?? "";
        const item = byLabel.get(label.trim().toLowerCase())
          ?? [...byLabel.values()].find((candidate) => candidate && tabLabelMatches(label, candidate.label))
          ?? null;
        if (item) sourced.set(element, item);
      }
      continue;
    }
    if (groups.length !== 1) continue;
    const tabs = groups[0]!.items;
    if (tabs.length < 2 || tabs.some((tab) => tab.searchRole)) continue;
    const maxSlots = tabBar.frame.width >= 600 ? Math.floor(tabBar.frame.width / 80) : MAX_COMPACT_TAB_SLOTS;
    if (tabs.length > maxSlots) continue;
    const frameWidth = tabBar.frame.width / tabs.length;
    if (frameWidth < MIN_TAB_SLOT_POINTS) continue;
    const pixelWidth = tabBar.pixelFrame.width / tabs.length;
    tabs.forEach((tab, index) => {
      synthesized.push({
        id: `accessibility:synthetic-tab:${tab.label}:${index}`,
        source: "accessibility",
        layer: "accessibility",
        label: tab.label,
        value: null,
        role: "Button",
        elementType: "TabItem",
        identifier: null,
        frame: {
          x: tabBar.frame.x + (frameWidth * index),
          y: tabBar.frame.y,
          width: frameWidth,
          height: tabBar.frame.height,
        },
        pixelFrame: {
          x: tabBar.pixelFrame.x + (pixelWidth * index),
          y: tabBar.pixelFrame.y,
          width: pixelWidth,
          height: tabBar.pixelFrame.height,
        },
        componentId: `TabItem.${tab.label}`,
        sourceFile: tab.sourceFile,
        sourceLine: tab.sourceLine,
        metadata: {
          synthetic: true,
          inferred: "The Tab Bar exposed no tab items, so ADE placed this tab at an equal slice of the bar, in source order. Its frame is a guess.",
          generatedFrom: "SwiftUI tab labels in source and the accessibility Tab Bar frame",
          tabBarElementId: tabBar.id,
          sourceSnippet: tab.snippet,
        },
      });
    });
  }
  if (!sourced.size && !synthesized.length) return elements;
  const enriched = sourced.size
    ? elements.map((element) => {
      const item = sourced.get(element);
      if (!item) return element;
      return {
        ...element,
        sourceFile: item.sourceFile,
        sourceLine: item.sourceLine,
        metadata: { ...element.metadata, sourceFrom: "SwiftUI tab label in source", sourceSnippet: item.snippet },
      };
    })
    : elements;
  // After every element read from the screen: a guess never outranks one.
  return synthesized.length ? [...enriched, ...synthesized] : enriched;
}

async function findAppBundles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        found.push(next);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(next, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function findAppBundle(
  root: string,
  criteria: {
    bundleId?: string | null;
    scheme?: string | null;
    /**
     * Xcode product name produced by the app target ("MyApp" → "MyApp.app").
     * Preferred over `scheme` because schemes can build multiple `.app`
     * bundles or use a name that differs from the produced bundle.
     */
    productName?: string | null;
    appBundlePath?: string | null;
    /** Only a bundle that matches by id or name; never the first one found. */
    matchOnly?: boolean;
  },
): Promise<string | null> {
  if (criteria.appBundlePath && fs.existsSync(criteria.appBundlePath)) return criteria.appBundlePath;
  const appBundles = await findAppBundles(root);
  // productName is the most accurate hint (scheme name can drift from the
  // produced .app); fall back to scheme, then the well-known ADE.app name.
  const expectedNames = [
    criteria.productName ? `${criteria.productName}.app` : null,
    criteria.scheme ? `${criteria.scheme}.app` : null,
    "ADE.app",
  ].filter((value): value is string => Boolean(value));
  if (criteria.bundleId) {
    for (const appBundle of appBundles) {
      const bundleId = await readPlistValue(path.join(appBundle, "Info.plist"), "CFBundleIdentifier");
      if (bundleId === criteria.bundleId) return appBundle;
    }
  }
  for (const expectedName of expectedNames) {
    const match = appBundles.find((candidate) => path.basename(candidate) === expectedName);
    if (match) return match;
  }
  return criteria.matchOnly ? null : appBundles[0] ?? null;
}

function unquotePbxValue(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return value.replace(/^"|"$/g, "").trim();
}

function readPbxAssignment(block: string, key: string): string | null {
  return unquotePbxValue(new RegExp(`\\n\\s*${escapeRegExp(key)} = ([^;]+);`).exec(block)?.[1]);
}

function normalizePbxName(value: string | null, fallback: string): string {
  if (!value || value.includes("$(")) return fallback;
  return value;
}

function parseApplicationTargetsFromPbxproj(projectPath: string): PbxApplicationTarget[] {
  const pbxPath = path.join(projectPath, "project.pbxproj");
  let text = "";
  try {
    text = fs.readFileSync(pbxPath, "utf8");
  } catch {
    return [];
  }
  const nativeTargetSection = /\/\* Begin PBXNativeTarget section \*\/([\s\S]*?)\/\* End PBXNativeTarget section \*\//.exec(text)?.[1] ?? "";
  const targets: PbxApplicationTarget[] = [];
  const targetBlocks = nativeTargetSection.matchAll(/^\s*([A-Za-z0-9]+) \/\* ([^*]+) \*\/ = \{([\s\S]*?)^\s*\};/gm);
  for (const match of targetBlocks) {
    const id = match[1]?.trim();
    const block = match[3] ?? "";
    if (!id) continue;
    if (!block.includes(`productType = "${IOS_APPLICATION_PRODUCT_TYPE}"`)) continue;
    const fallbackName = match[2]?.trim() ?? id;
    const targetName = normalizePbxName(readPbxAssignment(block, "name"), fallbackName);
    const productName = normalizePbxName(readPbxAssignment(block, "productName"), targetName);
    if (targetName) targets.push({ id, targetName, productName });
  }
  return targets;
}

function parseXmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function readXcodeSchemeDefinitions(projectPath: string): XcodeSchemeDefinition[] {
  const schemeDirs = [
    path.join(projectPath, "xcshareddata", "xcschemes"),
  ];
  const xcuserdataDir = path.join(projectPath, "xcuserdata");
  try {
    for (const entry of fs.readdirSync(xcuserdataDir, { withFileTypes: true })) {
      if (entry.isDirectory()) schemeDirs.push(path.join(xcuserdataDir, entry.name, "xcschemes"));
    }
  } catch {
    // Shared schemes and target-name fallback cover normal projects.
  }

  const byName = new Map<string, XcodeSchemeDefinition>();
  for (const schemeDir of schemeDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(schemeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".xcscheme")) continue;
      const name = path.basename(entry.name, ".xcscheme");
      if (byName.has(name)) continue;
      const schemePath = path.join(schemeDir, entry.name);
      let text = "";
      try {
        text = fs.readFileSync(schemePath, "utf8");
      } catch {
        text = "";
      }
      const blueprintIdentifiers = new Set<string>();
      const blueprintNames = new Set<string>();
      const buildableNames = new Set<string>();
      for (const refMatch of text.matchAll(/<BuildableReference\b([^>]*)\/?>/g)) {
        const attrs = parseXmlAttributes(refMatch[1] ?? "");
        if (attrs.BlueprintIdentifier) blueprintIdentifiers.add(attrs.BlueprintIdentifier);
        if (attrs.BlueprintName) blueprintNames.add(attrs.BlueprintName);
        if (attrs.BuildableName) buildableNames.add(attrs.BuildableName);
      }
      byName.set(name, {
        name,
        blueprintIdentifiers: Array.from(blueprintIdentifiers),
        blueprintNames: Array.from(blueprintNames),
        buildableNames: Array.from(buildableNames),
      });
    }
  }
  return Array.from(byName.values());
}

function schemeMatchesApplicationTarget(scheme: XcodeSchemeDefinition, target: PbxApplicationTarget): boolean {
  if (scheme.blueprintIdentifiers.includes(target.id)) return true;
  if (scheme.blueprintNames.includes(target.targetName) || scheme.blueprintNames.includes(target.productName)) return true;
  if (scheme.buildableNames.includes(`${target.targetName}.app`) || scheme.buildableNames.includes(`${target.productName}.app`)) return true;
  return scheme.name === target.targetName || scheme.name === target.productName;
}

function schemesForApplicationTarget(projectPath: string, target: PbxApplicationTarget): string[] {
  const matchedSchemes = readXcodeSchemeDefinitions(projectPath)
    .filter((scheme) => schemeMatchesApplicationTarget(scheme, target))
    .map((scheme) => scheme.name);
  return matchedSchemes.length ? Array.from(new Set(matchedSchemes)) : [target.targetName];
}

async function discoverXcodeProjectPaths(projectRoot: string): Promise<string[]> {
  const projectPaths = new Set<string>();
  const addProjectPath = async (candidate: string) => {
    if (!candidate.endsWith(".xcodeproj")) return;
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isDirectory()) return;
      projectPaths.add(path.resolve(candidate));
    } catch {
      // Missing or unreadable projects are ignored during best-effort discovery.
    }
  };
  const scanDirectory = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map((entry) => addProjectPath(path.join(dir, entry.name))));
  };

  await addProjectPath(path.join(projectRoot, ADE_IOS_PROJECT));
  await scanDirectory(projectRoot);

  const appsRoot = path.join(projectRoot, "apps");
  await scanDirectory(appsRoot);
  let appEntries: fs.Dirent[];
  try {
    appEntries = await fs.promises.readdir(appsRoot, { withFileTypes: true });
  } catch {
    appEntries = [];
  }
  await Promise.all(appEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => scanDirectory(path.join(appsRoot, entry.name))));

  return Array.from(projectPaths);
}

function targetPathWithinRoot(root: string, target: IosSimulatorLaunchTarget): boolean {
  if (target.kind === "project" && target.projectPath) {
    return isPathInside(path.resolve(root, target.projectPath), root);
  }
  if (target.kind === "built" && target.appBundlePath) {
    return isPathInside(path.resolve(root, target.appBundlePath), root);
  }
  return true;
}

function recoverStaleLaunchTarget(
  targetIdValue: string | null | undefined,
  targets: IosSimulatorLaunchTarget[],
  projectRoot: string,
): IosSimulatorLaunchTarget | null {
  const parts = decodeTargetId(targetIdValue);
  // Every recovery candidate must live under the resolved root. Recovering
  // across roots is how a lane launch ends up running the primary checkout.
  const inRoot = targets.filter((candidate) => targetPathWithinRoot(projectRoot, candidate));
  if (parts[0] === "project" && parts[1]) {
    const matches = inRoot.filter((candidate) => candidate.kind === "project" && candidate.projectPath === parts[1]);
    if (matches.length === 1) return matches[0];
    const projectBasename = path.basename(parts[1]);
    const basenameMatches = inRoot.filter((candidate) => (
      candidate.kind === "project"
      && candidate.projectPath
      && path.basename(candidate.projectPath) === projectBasename
    ));
    return basenameMatches.length === 1 ? basenameMatches[0] : null;
  }
  if (parts[0] === "built" && parts[1]) {
    const matches = inRoot.filter((candidate) => candidate.kind === "built" && candidate.appBundlePath === parts[1]);
    return matches.length === 1 ? matches[0] : null;
  }
  if (parts[0] === "installed" && parts[2]) {
    return inRoot.find((candidate) => candidate.kind === "installed" && candidate.bundleId === parts[2]) ?? null;
  }
  return null;
}

/**
 * Target ids are stable across roots by design (project ids carry a relative
 * path), so a drawer id from another checkout looks valid here. Reject the two
 * shapes that provably point outside the resolved root before any build runs.
 */
function assertTargetIdWithinRoot(targetIdValue: string, projectRoot: string): void {
  const parts = decodeTargetId(targetIdValue);
  if (parts[0] === "project" && parts[1]) {
    const absolute = path.resolve(projectRoot, parts[1]);
    if (!isPathInside(absolute, projectRoot)) {
      throw new IosSimulatorTargetRootMismatchError(`launch target project ${parts[1]} is outside the build root ${projectRoot}.`);
    }
    return;
  }
  if (parts[0] === "built" && parts[1] && path.isAbsolute(parts[1]) && !isPathInside(parts[1], projectRoot)) {
    throw new IosSimulatorTargetRootMismatchError(`launch target app bundle ${parts[1]} was built under a different root than ${projectRoot}.`);
  }
}

export type IosSimulatorService = ReturnType<typeof createIosSimulatorService>;

/** What an agent hears when its lane has no device and the action needs one. */
const AGENT_NO_LANE_DEVICE_MESSAGE =
  "This lane has no Apple device yet. Run `ade apple start` to give it its own (it makes a new device and boots it), "
  + "or `ade apple device-create`.";

/**
 * Actions that drive or read a device: for an agent they run on the lane's own
 * device only, and refuse when the lane has none (`launch` and `openDevice`
 * create it). See `guardAgentDeviceActions`.
 */
const AGENT_DEVICE_DRIVING_ACTIONS = [
  "launch", "openDevice", "screenshot", "getScreenSnapshot", "getInspectorSnapshot", "inspectPoint",
  "startStream", "frame", "tap", "longPress", "pressButton", "rotate", "setPosture", "getPosture", "duoAppStoreScreenshots", "typeText", "pressKey", "drag", "swipe", "scroll", "selectPoint",
  "recordStart", "getDeviceSettings", "setAppearance", "setContentSize", "setAccessibilityOption", "setLocation",
  "clearLocation", "setPermission", "sendPushNotification", "openUrl", "relaunchApp", "terminateApp",
  "uninstallApp", "setStatusBar", "clearStatusBar", "getAppState", "getForegroundApp", "startEventLog",
  "findElement", "tapElement", "fillElement", "waitForElement", "assertVisible", "captureProofBundle",
  "runTests", "installApp", "windowLayout",
] as const;

/** Driving actions that give a lane with no device its own device first, instead of refusing. */
const AGENT_DEVICE_CREATING_ACTIONS = new Set<string>(["launch", "openDevice", "runTests", "installApp"]);

/**
 * Actions that may name a device but need none: an agent's explicit udid must
 * still be its lane's device (`stop --udid` must not power off someone else's).
 */
const AGENT_DEVICE_CHECKED_ACTIONS = [
  "deviceStop", "closeDevice", "stopStream", "stopEventLog", "getEventLog", "listLaunchTargets",
] as const;

/**
 * Actions that work the lane's live view, its claim, its recordings or its
 * builds, which belong to the lane's own device: `--device <extra>` on one of
 * them is refused rather than quietly acting on (or rebinding) the lane's
 * device. Everything else acts on the device it is given.
 */
const AGENT_EXTRA_DEVICE_REFUSED_ACTIONS = new Set<string>([
  "launch", "runTests", "startStream", "stopStream", "closeDevice", "deviceStop",
  "recordStart", "startEventLog", "stopEventLog", "getEventLog", "selectPoint", "duoAppStoreScreenshots", "getInspectorSnapshot",
  "frame",
]);

/** A result an extra note can ride on: a plain object, not an array, a Buffer or a class instance. */
function isPlainResultObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `installApp` met another xcodebuild in the lane's DerivedData (or a launch or test met an install). */
const APPLE_BUILD_BUSY_CODE = "APPLE_BUILD_BUSY";

/** The lane setting (`ade apple auto-record off`), in the project's KV. */
function appleAutoRecordKey(laneKey: string): string {
  return `apple.autoRecord.lane.${laneKey}`;
}

/**
 * The lease of one of a lane's devices: the lane's own device under the
 * lane's key (it follows whichever device the lane holds), an extra under its
 * udid. Each device takes turns on its own.
 */
function appleDeviceLeaseKey(laneKey: string, extraUdid: string | null): string {
  return extraUdid ? `${laneKey}\u0000${extraUdid}` : laneKey;
}

/**
 * `start --udid <extra>` and `device-attach --simulator <extra>` on the lane
 * that owns the extra: the answer is the promote verb, not a second device.
 */
function extraIsNotLaneDeviceError(extra: Pick<AppleLaneDevice, "name" | "udid">): AdeExpectedError {
  return new AdeExpectedError(
    `${APPLE_DEVICE_IS_EXTRA_CODE}: ${extra.name} is one of this lane's extra devices, not its own device, so it `
    + "cannot stream, record or launch builds. To make it the lane's device (the old one stays installed), run: "
    + `ade apple device-promote --device ${extra.udid}`,
    "user",
  );
}

/** Who holds the session, when it is an agent on another machine. */
function remoteHolderOf(chatSessionId: string | null): IosSimulatorStatus["remoteHolder"] {
  if (!chatSessionId || !parseForeignCallerSessionId(chatSessionId)) return null;
  return { machineName: externalChatContext(chatSessionId)?.machineName ?? null };
}

/** A PNG's pixel size from its IHDR chunk, or null for anything else. */
function readPngSize(filePath: string): { width: number; height: number } | null {
  try {
    const header = Buffer.alloc(24);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, header, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return null;
  }
}

export function createIosSimulatorService(args: CreateIosSimulatorServiceArgs) {
  let lastSelectedItem: IosElementContextItem | null = null;
  let controlQueue: Promise<void> = Promise.resolve();
  /**
   * Who asked for each in-flight launch. `launch-progress` events broadcast
   * project-wide, so without an owner stamp a second drawer renders another
   * chat's stepper over its own live view — and, because that foreign launch
   * never emits a terminal step this drawer recognises, the overlay sticks.
   * Keyed by launch id rather than held in one variable because `shutdown
   * --force` clears the lane's `activeLaunchId` out from under a still-running
   * launch, which would otherwise leave its remaining steps unattributed.
   * Entries are removed in `launch`'s own `finally`.
   */
  const launchOwners = new Map<string, { chatSessionId: string | null; laneId: string | null }>();
  /** DerivedData folders a build or test in this service is writing; cleaners skip them. */
  const activeBuildDataPaths = new Map<string, number>();
  /** Mark a DerivedData folder in use until the returned release runs. */
  const claimBuildDataPath = (derivedDataPath: string): (() => void) => {
    const key = path.resolve(derivedDataPath);
    activeBuildDataPaths.set(key, (activeBuildDataPaths.get(key) ?? 0) + 1);
    return () => {
      const remaining = (activeBuildDataPaths.get(key) ?? 1) - 1;
      if (remaining > 0) activeBuildDataPaths.set(key, remaining);
      else activeBuildDataPaths.delete(key);
    };
  };
  /** Devices an `xcodebuild test` from this service is running on. */
  const activeTestUdids = new Set<string>();
  /** Set once the registry and power path exist; see `laneDeviceMaintenance.ts`. */
  let maintenance: LaneDeviceMaintenance | null = null;
  let disposed = false;
  let xcodeMcpBridge: XcodeMcpBridge | null = null;
  const toolAvailabilityCache = new Map<string, { available: boolean; checkedAt: number }>();
  let simulatorAppCache: { path: string | null; checkedAt: number } | null = null;
  let cachedDevices: { value: IosSimulatorDevice[]; computedAt: number; inflight: Promise<IosSimulatorDevice[]> | null } = {
    value: [],
    computedAt: 0,
    inflight: null,
  };

  const emptyStreamStatus = (): IosSimulatorStreamStatus => ({
    deviceUdid: null,
    running: false,
    backend: null,
    fps: null,
    targetFps: null,
    frameCount: null,
    startedAt: null,
    lastFrameAt: null,
    lastError: null,
    error: null,
    streamUrl: null,
    averageLatencyMs: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    helperPid: null,
    inputBackend: null,
  });

  /**
   * Everything a single lane owns.
   *
   * One simulator per lane is the locked model, so the app session, the device
   * session (and with it the log process), the live stream and the launch lock
   * are all per-lane state. They used to be one set of variables for the whole
   * project, which is why a second lane's `launch` reported
   * IOS_SIMULATOR_LAUNCH_IN_PROGRESS against a launch it had nothing to do with
   * and why `stream-stop` on one lane killed another lane's picture.
   *
   * The empty-string key is the un-laned bucket: a CLI call that names no lane,
   * and the projectless chats that have none to name. It behaves exactly like a
   * lane, so nothing has to special-case "no lane" beyond resolving the key.
   */
  type LaneRuntime = {
    key: string;
    laneId: string | null;
    activeSession: IosSimulatorSession | null;
    activeLaunchId: string | null;
    streamStatus: IosSimulatorStreamStatus;
    streamRequestContext: Pick<IosSimulatorStreamStatus, "requestedBackend" | "fallbackReason" | "degradationReason">;
    hub: IosDeviceHub | null;
    cachedStatus: { value: IosSimulatorStatus; computedAt: number; inflight: Promise<IosSimulatorStatus> | null };
    /**
     * Serialises `deviceStart` against `deviceStop` for this lane.
     *
     * Bringing a device up is boot → bootstatus → capture, several seconds
     * long; powering it off is one `simctl shutdown`. Without a queue the two
     * interleave, and the interleaving that matters is the one round 5 §S1
     * names: the tab's close powers the device off while a start that was
     * already in flight — a retry, a second viewer, the pane's own effect
     * re-running — boots it straight back and the user watches the simulator
     * they just closed come back to life.
     */
    deviceLifecycleQueue: Promise<unknown>;
  };

  const runtimes = new Map<string, LaneRuntime>();

  const laneKey = (laneId?: string | null): string => laneId?.trim() ?? "";

  const createRuntime = (key: string): LaneRuntime => ({
    key,
    laneId: key || null,
    activeSession: null,
    activeLaunchId: null,
    streamStatus: emptyStreamStatus(),
    streamRequestContext: { requestedBackend: null, fallbackReason: null, degradationReason: null },
    hub: null,
    deviceLifecycleQueue: Promise.resolve(),
    cachedStatus: {
      value: {
        platform: process.platform,
        supported: false,
        tools: [],
        activeDevice: null,
        activeSession: null,
      },
      computedAt: 0,
      inflight: null,
    },
  });

  const runtimeForKey = (key: string): LaneRuntime => {
    const existing = runtimes.get(key);
    if (existing) return existing;
    const created = createRuntime(key);
    runtimes.set(key, created);
    return created;
  };

  /**
   * Any OTHER lane's live session holding this simulator.
   *
   * `resolveRuntime` gives a caller its own lane's bucket, which is the right
   * scope for almost everything — and exactly the wrong scope for an ownership
   * question, because the simulator is one device shared by the machine. A
   * caller naming a different lane used to slip past the guard entirely.
   */
  const findActiveSessionForDevice = (
    deviceUdid: string,
    except: LaneRuntime,
  ): IosSimulatorSession | null => {
    for (const candidate of runtimes.values()) {
      if (candidate === except) continue;
      const session = candidate.activeSession;
      if (session?.deviceUdid === deviceUdid) return session;
    }
    // An app session only. A hub DEVICE session (`open-device` with no launch)
    // is a weaker claim and a different type, and the hole that was actually
    // demonstrated was a `launch` naming another lane — which always sets an
    // app session. Widening this to device sessions needs the error to accept
    // both shapes, which is a change to its public `currentSession`, so it is
    // deliberately not bundled in with a security fix.
    return null;
  };

  const resolveLaneIdForPath = args.resolveLaneIdForPath ?? null;
  const deviceLeases = createAppleDeviceLeases();

  /**
   * The lane a call is about, and a note that its device was used.
   *
   * Every verb resolves its lane through here, including the pane's status
   * poll while it is on screen, so this is where "someone is using this lane's
   * device" is recorded for idle power-off.
   */
  const resolveRuntime = (
    scope: { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null } = {},
  ): LaneRuntime => {
    const runtime = resolveRuntimeUntracked(scope);
    if (runtime.key && maintenance) {
      const device = laneDevices.get(runtime.key);
      if (device) maintenance.touch(device.udid);
    }
    return runtime;
  };

  /**
   * Which lane a call belongs to.
   *
   * An explicit lane always wins. Failing that the CALLING CHAT decides: a chat
   * that launched on lane B and then ran a bare `tap` means lane B, and the old
   * project-wide state made that accidentally true. Next the caller's PATH: a
   * `projectRoot` inside a lane worktree names that lane. Only when none of
   * those says anything does the one busy lane, or else the un-laned bucket,
   * answer — the bucket is also what a fresh process with no sessions returns.
   */
  const resolveRuntimeUntracked = (
    scope: { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null } = {},
  ): LaneRuntime => {
    const explicit = laneKey(scope.laneId);
    if (explicit) return runtimeForKey(explicit);
    const chatSessionId = scope.chatSessionId?.trim();
    if (chatSessionId) {
      for (const runtime of runtimes.values()) {
        if (runtime.activeSession?.chatSessionId === chatSessionId) return runtime;
        if (runtime.hub?.getDeviceSession()?.chatSessionId === chatSessionId) return runtime;
      }
    }
    /*
     * The lane the caller is STANDING IN, before any guess about what is busy.
     *
     * `ade apple` sends the caller's workspace as `projectRoot` when it has no
     * lane id to send — which is always, for an agent whose shell carries no
     * `ADE_LANE_ID`: a shared `opencode serve` cannot hold a per-chat
     * environment, so every OpenCode agent is in that position. The service
     * used the path for the BUILD root and then resolved the lane by the
     * fallback below, so a capture taken by lane A was filed against lane B
     * because B happened to be the one lane with something running. That is a
     * cross-lane leak of an agent's own proof, and it is fixed by using the
     * answer the caller already gave.
     */
    const callerPath = scope.projectRoot?.trim();
    if (callerPath && resolveLaneIdForPath) {
      const laneFromPath = laneKey(resolveLaneIdForPath(callerPath));
      if (laneFromPath) return runtimeForKey(laneFromPath);
    }
    // Neither said anything, and exactly one lane is running something: that is
    // what the caller means. This is what keeps the cooperative ownership rule
    // intact across the move to per-lane state — an anonymous `shutdown` still
    // reaches the one running session and is still REFUSED by its owner guard,
    // rather than quietly succeeding against an empty bucket and telling the
    // caller nothing was running.
    const occupied = [...runtimes.values()].filter((runtime) => (
      runtime.activeSession || runtime.streamStatus.running || runtime.hub?.getDeviceSession()
    ));
    if (occupied.length === 1) return occupied[0];
    return runtimeForKey("");
  };

  /**
   * Move a runtime into a different lane's bucket.
   *
   * `claim --lane X` on a session that started un-laned is the case this
   * exists for. The whole record moves — session, stream, hub, launch lock —
   * because they all describe the same simulator; splitting them across two
   * keys is how a lane ends up owning a session whose stream it cannot stop.
   */
  const retargetRuntime = (runtime: LaneRuntime, laneId: string): LaneRuntime => {
    const nextKey = laneKey(laneId);
    if (nextKey === runtime.key) return runtime;
    const occupant = runtimes.get(nextKey);
    // A lane that already has its own session keeps it: silently overwriting it
    // would evict a running chat with no error anyone could read.
    if (occupant && (occupant.activeSession || occupant.streamStatus.running)) return runtime;
    runtimes.delete(runtime.key);
    runtime.key = nextKey;
    runtime.laneId = nextKey || null;
    runtimes.set(nextKey, runtime);
    return runtime;
  };

  const emit = (payload: IosSimulatorEventPayload) => {
    args.onEvent?.(payload);
  };

  /**
   * The device half of the surface, one per lane: device sessions, device
   * settings, the event log, semantic actions and proof bundles.
   *
   * Every dependency is a lambda rather than a direct reference. The functions
   * it needs are declared below this line, and the module-level `run` and
   * `spawnProcess` are swapped by the test hooks, so capturing either one by
   * value here would freeze the wrong implementation.
   *
   * One hub PER LANE, because a hub owns a device session and a `log stream`
   * child. Sharing one across lanes meant lane B's `log-start` replaced lane
   * A's running log and lane A's `close-device` shut down lane B's simulator.
   */
  const hub = (runtime: LaneRuntime): IosDeviceHub => {
    if (!runtime.hub) {
      runtime.hub = createIosDeviceHub({
        run: (file, commandArgs, options) => run(file, commandArgs, options),
        spawnLogStream: (deviceUdid, predicate) => spawnLogStreamProcess(deviceUdid, predicate),
        openSimulatorApp: () => {
          spawnProcess("open", ["-g", "-a", "Simulator"], { detached: true, stdio: "ignore" }).unref();
        },
        resolveDevice: (deviceUdid) => resolveDevice(deviceUdid, runtime),
        resolveControlDeviceUdid: (deviceUdid) => resolveControlDeviceUdid(deviceUdid, runtime),
        getScreenSnapshot: (snapshotArgs) => getScreenSnapshot({ ...snapshotArgs, laneId: snapshotArgs.laneId ?? runtime.laneId }),
        // `proof: false`: this dep serves `captureProofBundle`, whose `screen.png`
        // is already the artifact. Filing it again would put two rows in the
        // drawer for one capture.
        screenshot: (shotArgs) => screenshot({ ...shotArgs, laneId: shotArgs.laneId ?? runtime.laneId, proof: false }),
        tap: (tapArgs) => tap({ ...tapArgs, laneId: runtime.laneId }),
        longPress: (pressArgs) => longPress({ ...pressArgs, laneId: runtime.laneId }),
        // `fill-element` reads its field back itself, a better check than focus.
        typeText: (textArgs) => typeText({ ...textArgs, laneId: runtime.laneId }, { checkFocus: false }),
        readElementAt: (deviceUdid, x, y) => readAccessibilityElementAt(deviceUdid, x, y),
        bootDevice: (device) => power.bootDevice(device),
        powerOffDevice: (deviceUdid) => power.powerOffDevice(deviceUdid, "hub-power"),
        resolveBuildRoot: (scope) => resolveScopedRootForSession(scope, runtime),
        getAppSessionOwner: () => runtime.activeSession?.chatSessionId ?? null,
        getAppSessionDeviceUdid: () => runtime.activeSession?.deviceUdid ?? null,
        emit,
        logger: args.logger,
      });
    }
    return runtime.hub;
  };

  /* ───────────────────────── vendored Swift helper ───────────────────────── */

  // Resolved on first use: finding the helper stats a long list of candidate paths
  // (about 8 ms, on Windows and Linux for a helper that can never be there), and
  // this service is built every time a project opens.
  let resolvedHelperBinaryPath: string | null = null;
  const helperBinaryPath = (): string => (resolvedHelperBinaryPath ??= resolveSimHelperExecutablePath());
  let helperClient: SimHelperClient | null = null;
  const helperEventListeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();

  /**
   * The one helper process, lazily started.
   *
   * ONE process drives every simulator on this Mac — that is the whole reason
   * the protocol carries a `udid` on each command and echoes an `id` on each
   * reply. Starting one per lane would multiply the CoreSimulator handles for
   * no benefit and make a crash in one lane take out none of the others'
   * capture sessions anyway, because they are already separate sockets.
   */
  const helper = (): SimHelperClient => {
    if (!helperClient) {
      helperClient = simHelperFactory({
        binaryPath: helperBinaryPath(),
        logger: args.logger,
      });
      helperClient.onEvent((event) => {
        for (const listener of [...helperEventListeners]) {
          try {
            listener(event);
          } catch {
            // A subscriber's failure must not stop the others from hearing it.
          }
        }
        handleHelperEvent(event);
      });
    }
    return helperClient;
  };

  /**
   * Handed to unit 2C's recording service, which needs to send `record-*`
   * commands and hear `record-*` events on the same process ADE already drives.
   */
  const helperTransport: SimHelperTransport = {
    send: (command) => helper().send(command),
    onEvent: (listener) => {
      // Touch the client so a subscriber alone is enough to bring the helper
      // up: 2C subscribes before any input happens.
      helper();
      helperEventListeners.add(listener);
      return () => {
        helperEventListeners.delete(listener);
      };
    },
    get binaryPath() {
      return helperBinaryPath();
    },
  };

  /** Lane runtimes keyed by the udid they are streaming, for helper events. */
  const runtimeStreamingUdid = (udid: string): LaneRuntime | null => {
    for (const runtime of runtimes.values()) {
      if (runtime.streamStatus.running && runtime.streamStatus.deviceUdid === udid) return runtime;
    }
    return null;
  };

  /**
   * Publish a lane's stream as stopped, the way `stopStream` does, without
   * asking the helper for anything: used when the helper already dropped the
   * capture, or died with it.
   */
  const markStreamGone = (runtime: LaneRuntime): void => {
    if (runtime.laneId) localViewerLanes.delete(runtime.laneId);
    const status = setStreamStopped(runtime, null);
    emit({ type: "stream-stopped", status });
  };

  /**
   * The helper process died (the client restarts it on its own).
   *
   * Everything it held died with it: every capture socket, every recording,
   * every HID client. Proven live on 2026-09-23: after a helper restart
   * `getStreamStatus` still said `running: true` with the dead `helperPid`
   * and `transport.port`, `startStream`'s "already running" fast path handed
   * that dead port to every new viewer, and nothing recovered until someone
   * called `stopStream` by hand. So every lane's stream is published stopped
   * (the next `startStream` opens a real capture on the new helper) and the
   * recording service forgets the recordings the dead helper was writing.
   */
  const handleHelperExited = (event: { type: string } & Record<string, unknown>): void => {
    const deadPid = typeof event.pid === "number" ? event.pid : null;
    let stopped = 0;
    for (const runtime of runtimes.values()) {
      if (!runtime.streamStatus.running) continue;
      markStreamGone(runtime);
      stopped += 1;
    }
    // A lane that was not streaming can still carry a viewer mark from a
    // renderer; with no capture behind it the mark describes nothing.
    localViewerLanes.clear();
    const endedRecordings = recordings.helperExited();
    args.logger.warn("apple.sim_helper_exited", {
      pid: deadPid,
      code: event.code ?? null,
      signal: event.signal ?? null,
      streamsStopped: stopped,
      recordingsEnded: endedRecordings.length,
    });
  };

  const handleHelperEvent = (event: { type: string } & Record<string, unknown>): void => {
    if (event.type === SIM_HELPER_EXITED_EVENT) {
      handleHelperExited(event);
      return;
    }
    if (event.type === "posture-changed") {
      handlePostureChanged(event);
      return;
    }
    if (event.type !== "capture-stopped") return;
    const udid = typeof event.udid === "string" ? event.udid : null;
    if (!udid) return;
    const runtime = runtimeStreamingUdid(udid);
    if (!runtime) return;
    const reason = typeof event.reason === "string" ? event.reason : null;
    // "requested" is ADE's own capture-stop echoing back; `stopStream` has
    // already published the stopped status and emitting again would make the
    // drawer flash an error on a clean stop.
    if (reason === "requested") return;
    // "device-reset" is ADE's own `device-reset` around a power change: a
    // clean stop ADE asked for, so it reads as stopped rather than as an error.
    if (reason === "device-reset") {
      markStreamGone(runtime);
      return;
    }
    const status = setStreamStopped(runtime, reason || "The simulator capture stopped.");
    emit({ type: "stream-error", status });
  };

  /**
   * A foldable changed pose or active panel (the helper watches every Duo it
   * streams). The stream now carries the other panel, at its own size, so the
   * transport's pixel and point sizes are replaced before anyone maps a tap
   * against them, then the pane hears the pose itself.
   */
  const handlePostureChanged = (event: { type: string } & Record<string, unknown>): void => {
    const udid = typeof event.udid === "string" ? event.udid : null;
    if (!udid) return;
    const posture = parseHelperPosture(event);
    duo.notePosture(udid, posture);
    const runtime = runtimeStreamingUdid(udid);
    const transport = runtime?.streamStatus.transport;
    if (runtime && transport) {
      const width = typeof event.pixelWidth === "number" ? event.pixelWidth : transport.width;
      const height = typeof event.pixelHeight === "number" ? event.pixelHeight : transport.height;
      const pointWidth = typeof event.pointWidth === "number" ? event.pointWidth : transport.pointWidth;
      const pointHeight = typeof event.pointHeight === "number" ? event.pointHeight : transport.pointHeight;
      if (width !== transport.width || height !== transport.height
        || pointWidth !== transport.pointWidth || pointHeight !== transport.pointHeight) {
        runtime.streamStatus = { ...runtime.streamStatus, transport: { ...transport, width, height, pointWidth, pointHeight } };
        emit({ type: "stream-status", status: runtime.streamStatus });
      }
    }
    emit({ type: "apple.device.posture", laneId: runtime?.key ?? laneIdHoldingUdid(udid), udid, posture });
  };

  /**
   * Tell the helper to forget everything it holds for a device, best effort.
   *
   * The helper builds a per-device session once — HID client, capture engine —
   * and those are bound to the boot they were built against. Proven live on
   * 2026-09-23: a lane simulator was powered off and booted again while the
   * helper stayed up, and every tap afterwards answered `ok` in ~11 ms while
   * the screen never changed; killing only the helper fixed it at once. So ADE
   * resets the device's session right before it powers the device off and
   * right after it boots one that was off, and the next command builds a
   * fresh session against the new boot.
   *
   * Not covered: a reboot done outside ADE (Xcode, `simctl` in a terminal,
   * Simulator.app's own menu). Nothing tells ADE about those; the fix there is
   * a helper-side staleness check, which this does not attempt.
   *
   * Skipped when no helper is running: a fresh helper has no session to drop,
   * and spawning one only to tell it to forget nothing is waste. Never throws
   * — an older helper answers `unknown-command`, and neither that nor a dead
   * helper may fail the power-off or boot the user asked for.
   */
  const resetHelperDevice = async (udid: string, reason: "power-off" | "boot" | "delete" | "hub-power"): Promise<void> => {
    const client = helperClient;
    if (!client || client.pid() == null) return;
    await client.send({ type: "device-reset", udid }).catch((error: unknown) => {
      args.logger.debug("apple.helper_device_reset_failed", {
        udid,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    });
  };

  /* ───────────────────────── per-lane devices ───────────────────────── */

  // A Mac with the Command Line Tools but no Xcode has `xcrun` and no
  // `simctl`. It has no simulators: answer that, and only look again once a
  // minute so an Xcode install is noticed without a spawn on every poll.
  let simctlMissingAt = 0;
  const listInstalledSimulators = async (): Promise<AppleInstalledSimulator[]> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return [];
    if (simctlMissingAt && Date.now() - simctlMissingAt < SIMCTL_MISSING_RECHECK_MS) return [];
    try {
      const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"], { timeoutMs: 30_000 });
      simctlMissingAt = 0;
      return appleInstalledSimulatorsFrom(parseSimctlDevices(stdout));
    } catch (error) {
      if (!SIMCTL_MISSING.test(error instanceof Error ? error.message : String(error))) throw error;
      if (!simctlMissingAt) args.logger.info("apple.simctl_missing", { hint: "Xcode is not installed" });
      simctlMissingAt = Date.now();
      return [];
    }
  };

  /**
   * The device's own pixels per point, from its device type's profile. A
   * device never changes type, so each udid is read once. Null when anything
   * on the way is missing; the snapshot then falls back to its guess.
   */
  const deviceScreenScales = new Map<string, Promise<number | null>>();
  const deviceScreenScale = (deviceUdid: string): Promise<number | null> => {
    const known = deviceScreenScales.get(deviceUdid);
    if (known) return known;
    const read = (async (): Promise<number | null> => {
      // Only the profile's own answer is remembered. A device or profile not
      // found yet (a list read while simctl was busy, a device type still
      // installing) is asked again by the next snapshot.
      const device = (await listInstalledSimulators()).find((entry) => entry.udid === deviceUdid);
      if (!device?.deviceTypeIdentifier) throw new Error("device type not listed");
      const { stdout: types } = await run("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs: 30_000 });
      const bundlePath = deviceTypeBundlePath(types, device.deviceTypeIdentifier);
      if (!bundlePath) throw new Error(`no profile for ${device.deviceTypeIdentifier}`);
      const capabilitiesPath = path.join(bundlePath, "Contents", "Resources", "capabilities.plist");
      const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", capabilitiesPath], { timeoutMs: 10_000 });
      return deviceTypeScreenScale(JSON.parse(stdout) as unknown);
    })().catch((error: unknown) => {
      // Not remembered: the next snapshot asks again.
      deviceScreenScales.delete(deviceUdid);
      args.logger.debug("apple.device_scale_unread", {
        deviceUdid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    deviceScreenScales.set(deviceUdid, read);
    return read;
  };

  /**
   * Whether a device's CoreSimulator type folds, by its type identifier. A
   * device never changes type, so an answer is kept per udid; a device not
   * listed yet is asked again (null).
   */
  const deviceFoldsByUdid = new Map<string, boolean>();
  const deviceSupportsDuo = async (deviceUdid: string): Promise<boolean | null> => {
    const known = deviceFoldsByUdid.get(deviceUdid);
    if (known !== undefined) return known;
    const device = (await listInstalledSimulators()).find((entry) => entry.udid === deviceUdid);
    if (!device?.deviceTypeIdentifier) return null;
    const folds = appleDeviceTypeSupportsDuo(device.deviceTypeIdentifier);
    deviceFoldsByUdid.set(deviceUdid, folds);
    return folds;
  };

  const laneDevices = createLaneDeviceRegistry({
    run: (command, commandArgs, options) => run(command, commandArgs, options),
    powerOffDevice: (udid) => power.powerOffDevice(udid, "delete"),
    listInstalledSimulators,
    // Same rule as the simulators: no `xcrun` spawn off a Mac or on a Mac
    // with no `simctl`, where the answer is "none" (the picker asks on open).
    listInstalledRuntimes: async () => {
      if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return [];
      if (simctlMissingAt && Date.now() - simctlMissingAt < SIMCTL_MISSING_RECHECK_MS) return [];
      try {
        const { stdout } = await run("xcrun", ["simctl", "list", "runtimes", "available", "--json"], { timeoutMs: 30_000 });
        simctlMissingAt = 0;
        return parseAppleInstalledRuntimes(stdout);
      } catch (error) {
        if (!SIMCTL_MISSING.test(error instanceof Error ? error.message : String(error))) throw error;
        if (!simctlMissingAt) args.logger.info("apple.simctl_missing", { hint: "Xcode is not installed" });
        simctlMissingAt = Date.now();
        return [];
      }
    },
    resolveLaneName: args.resolveLaneName ?? null,
    store: args.laneDeviceStore ?? null,
    projectRoot: args.projectRoot,
    // The cleanup pass is about to power off or delete this device: nothing in
    // this process may still be reading it.
    releaseDeviceHolds: async (udid) => {
      await stopDeviceRecording(udid, "device-off");
      await lifecycle.releaseUnlanedHolds(udid);
      invalidateDeviceList();
    },
    logger: args.logger,
    /**
     * A lane is losing its device to another lane's takeover.
     *
     * What is released: the lane's live stream, its chat session claim, and
     * its hub device session. What is NOT: the simulator's power. A takeover
     * hands the running device over as it stands — the lane taking it is about
     * to stream the same udid, and powering it off just to boot it again would
     * cost the user the device's state for nothing.
     *
     * Deferred by design (this runs long after construction), and never
     * allowed to fail the move: the registry logs a rejection and re-keys the
     * binding anyway, because a stream that will not stop must not leave one
     * simulator owned by two lanes.
     */
    releaseLaneDevice: async (device) => {
      await lifecycle.releaseLaneHold(device);
      args.logger.info("apple.lane_device_released_for_takeover", {
        laneId: device.laneId,
        udid: device.udid,
      });
    },
  });

  /**
   * Which lease a `lease --device` call is about: the lane's own device
   * (no device, or its udid or name), or one of its extras. Anything else is
   * not this lane's to take turns on.
   */
  const leaseTarget = (
    runtime: LaneRuntime,
    wanted: string | null | undefined,
  ): { key: string; device: { udid: string | null; name: string | null; extra: boolean } } => {
    const own = runtime.key ? laneDevices.get(runtime.key) : null;
    const value = wanted?.trim() || null;
    if (!value || (own && (own.udid === value || own.name === value))) {
      return { key: appleDeviceLeaseKey(runtime.key, null), device: { udid: own?.udid ?? null, name: own?.name ?? null, extra: false } };
    }
    const extra = runtime.key ? laneDevices.findExtra(runtime.key, value) : null;
    if (!extra) {
      throw new AdeExpectedError(
        `${APPLE_DEVICE_NOT_LANE_OWNED_CODE}: ${value} is neither this lane's device nor one of its extra devices, so there is no lease to take on it. `
          + "Run ade apple device-list to see the lane's devices.",
        "user",
      );
    }
    return { key: appleDeviceLeaseKey(runtime.key, extra.udid), device: { udid: extra.udid, name: extra.name, extra: true } };
  };

  /**
   * Run `install`, and record the app as ADE's on an attached lane device only
   * when it was certainly absent before and is present after. An app the user
   * already had is theirs, even after ADE installs a new build over it; a check
   * that could not answer counts as "they had it"; and a build that failed
   * installed nothing.
   */
  const installTracked = async <T,>(udid: string, bundleId: string | null, install: () => Promise<T>): Promise<T> => {
    if (!bundleId || !laneDevices.tracksInstallsOn(udid)) return install();
    const before = await appleAppOnDevice(run, udid, bundleId);
    const result = await install();
    if (before === "absent" && (await appleAppOnDevice(run, udid, bundleId)) === "present") {
      laneDevices.noteAppInstalled({ udid, bundleId });
    }
    return result;
  };

  /** Who holds a device's lease, unless it is the asking chat (under any --holder name). */
  const otherLeaseHolder = (leaseKey: string, chatSessionId: string | null): string | null => {
    const lease = deviceLeases.status(leaseKey);
    if (!lease.held || !lease.current) return null;
    if (chatSessionId && deviceLeases.heldByChat(leaseKey, chatSessionId)) return null;
    return lease.current.holder;
  };

  /** Detach, delete, takeover and the picker's delete, over the registry above. */
  const lifecycle = createLaneDeviceLifecycle<LaneRuntime>({
    laneDevices,
    runtimeForLane: (laneId) => runtimes.get(laneKey(laneId)) ?? null,
    allRuntimes: () => [...runtimes.values()],
    resolveRuntime: (scope) => resolveRuntime(scope),
    requireLaneScope: (scope) => requireLaneScope(scope),
    serializeDeviceLifecycle: (runtime, step) => serializeDeviceLifecycle(runtime, step),
    assertDarwin: () => assertDarwin(),
    assertSessionOwner: (runtime, caller) => assertSessionOwner(runtime, caller),
    shutdown: (shutdownArgs) => shutdown(shutdownArgs),
    stopRuntimeStream: (runtime) => stopRuntimeStream(runtime),
    stopDeviceRecording: (udid, reason) => stopDeviceRecording(udid, reason),
    invalidateStatus: (runtime) => invalidateStatus(runtime),
    invalidateDeviceList: () => invalidateDeviceList(),
    laneDeviceBusyReason: (runtime, device, chatSessionId) => {
      if (runtime.streamStatus.running && runtime.streamStatus.deviceUdid === device.udid) {
        return "streaming its live view";
      }
      if (recordings.active({ laneId: runtime.key })) return "recording";
      if (activeTestUdids.has(device.udid)) return "running tests";
      if (runtime.activeLaunchId) return "launching a build";
      const holder = otherLeaseHolder(appleDeviceLeaseKey(runtime.key, null), chatSessionId);
      return holder ? `leased to ${holder}` : null;
    },
    extraLeaseHolder: (runtime, extra, chatSessionId) => otherLeaseHolder(appleDeviceLeaseKey(runtime.key, extra.udid), chatSessionId),
    emit: (payload) => emit(payload),
    logger: args.logger,
  });

  /**
   * The recording half. Unit 2C owns the implementation; this service only
   * calls `noteInput` from every injected-input path and `pinActiveOrLatest`
   * from `proof-bundle`, per the auto-record contract.
   */
  const recordings: SimRecordingService = args.recordingService ?? createSimRecordingService({
    ...args.recordingDeps,
    transport: helperTransport,
    projectRoot: args.projectRoot,
    logger: args.logger,
    onRecordingChange: ({ laneId, phase, recording }) => {
      emit({
        type: "apple.recording.state",
        laneId,
        phase,
        recordingId: recording.id,
        chatSessionId: recording.chatSessionId ?? null,
      });
    },
    // The proof caption says "Simulator recording · ADE Repro · 0:23", and the
    // recorder only ever knows the udid. The lane registry is already the
    // place that maps one to the other.
    resolveDeviceName: (udid: string) => {
      for (const runtime of runtimes.values()) {
        const device = laneDevices.get(runtime.key);
        if (device?.udid === udid) return device.name;
      }
      return null;
    },
  });

  /** The lane's switch and the machine's, as `auto-record status` reports them. */
  const autoRecordState = (laneKey: string) => {
    const machine = (() => {
      try {
        return args.recordingDeps?.readOverlaySetting?.(APPLE_AUTO_RECORD_SETTING_KEY) !== false;
      } catch (error) {
        // Unreadable reads as on, the default.
        args.logger.warn("apple.auto_record_read_failed", {
          setting: "machine",
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    })();
    const lane = laneAutoRecord(laneKey);
    return { laneId: laneKey || null, lane, machine, enabled: lane && machine };
  };

  /** The lane's auto-record switch; on unless `auto-record off` was set for it. */
  const laneAutoRecord = (laneKey: string): boolean => {
    if (!laneKey || !args.laneDeviceStore) return true;
    try {
      return args.laneDeviceStore.getJson<{ enabled?: unknown }>(appleAutoRecordKey(laneKey))?.enabled !== false;
    } catch (error) {
      // Unreadable reads as on, the default.
      args.logger.warn("apple.auto_record_read_failed", {
        setting: "lane",
        laneId: laneKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };

  /**
   * Announce an injected input to the recording service.
   *
   * Never awaited on the input path and never allowed to throw: auto-recording
   * is verification sugar, and a tap that failed because a recording could not
   * start would be a strictly worse product than a tap with no recording.
   */
  const noteInput = (
    runtime: LaneRuntime,
    input: {
      udid: string;
      kind: "tap" | "type" | "drag" | "select" | "open-url";
      x?: number;
      y?: number;
      text?: string;
      /**
       * Who drove the device. `user` never starts a recording (round 3, A2).
       *
       * Absent means `agent`: every caller that is NOT the desktop pane — the
       * CLI, an agent's `ios_simulator.tap`, a semantic action — is producing
       * verification evidence, and the preload stamps `source: "user"` on the
       * pane's calls precisely so this default stays safe.
       */
      source?: AppleInputSource;
      /** The call said `noRecord` (`--no-record`). */
      noRecord?: boolean | null;
    },
  ): void => {
    // Opted out for this call (`--no-record`) or for the lane (`auto-record
    // off`): the input is still overlaid on a recording that already runs,
    // it just never starts one.
    const autoStart = input.noRecord !== true && laneAutoRecord(runtime.key);
    void Promise.resolve(recordings.noteInput({
      autoStart,
      laneId: runtime.key,
      udid: input.udid,
      chatSessionId: runtime.activeSession?.chatSessionId ?? null,
      kind: input.kind,
      x: input.x,
      y: input.y,
      text: input.text,
      pointSize: runtime.streamStatus?.transport?.pointWidth && runtime.streamStatus.transport.pointHeight
        ? { width: runtime.streamStatus.transport.pointWidth, height: runtime.streamStatus.transport.pointHeight }
        : null,
      source: input.source ?? "agent",
    })).catch((error: unknown) => {
      args.logger.debug("apple.note_input_failed", {
        laneId: runtime.key || null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /** Spawns `log stream` on a device and turns its stdout into whole lines. */
  const spawnLogStreamProcess = (deviceUdid: string, predicate: string | null) => {
    const argv = ["simctl", "spawn", deviceUdid, "log", "stream", "--style", "compact", "--level", "info"];
    if (predicate) argv.push("--predicate", predicate);
    // Same reason as the encoder: `simctl spawn` runs the real `log` process as
    // a child, so only a group signal stops both.
    const child = spawnProcess("xcrun", argv, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let buffer = "";
    return {
      onLine: (handler: (line: string) => void) => {
        child.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          // A log line can arrive split across reads. Keep the tail until its
          // newline shows up, or every split record becomes two broken rows.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trimEnd();
            if (trimmed) handler(trimmed);
          }
        });
      },
      onError: (handler: (error: Error) => void) => {
        child.on("error", handler);
      },
      onExit: (handler: (code: number | null) => void) => {
        child.on("exit", (code) => handler(code ?? null));
      },
      kill: () => {
        // `xcrun simctl spawn` runs the real `log` process as a child of a
        // helper, so the leader alone is not the thing that holds the device.
        void signalChildProcessTree(child, "SIGTERM");
      },
    };
  };

  /**
   * Ask the desktop shell to reveal the iOS drawer.
   *
   * This lives in the service, not in an Electron-main wrapper: production
   * launches go to the brain daemon, which has no wrapper, so a wrapper-only
   * emitter made `--open-drawer` (and an agent's inspect/select reveal) inert
   * on the path agents actually use. Both hosts hand `onEvent` to the same
   * renderer subscriber — Electron main via `IPC.iosSimulatorEvent`, the daemon
   * via the `ios_simulator_event` runtime stream, merged in preload's
   * `subscribeIosSimulatorEvents` — so one emit here reaches
   * AgentChatPane's `drawer-open-requested` handler either way.
   *
   * Only actions whose whole point is showing the user something on screen call
   * this. Input, streaming, and preview rendering are routine agent work, and
   * stealing the screen for them made the drawer feel like a popup.
   */
  const requestDrawerOpen = (
    action: string,
    mode: IosSimulatorDrawerMode,
    scope: { chatSessionId?: string | null; laneId?: string | null },
  ): void => {
    emit({
      type: "drawer-open-requested",
      action,
      mode,
      chatSessionId: scope.chatSessionId?.trim() || null,
      laneId: scope.laneId?.trim() || null,
    });
  };

  const cachedCommandExists = (command: string, ttlMs = TOOL_STATUS_CACHE_MS): boolean => {
    const nowMs = Date.now();
    const cached = toolAvailabilityCache.get(command);
    if (cached && nowMs - cached.checkedAt < ttlMs) return cached.available;
    const available = process.platform === "darwin" ? commandExistsProbe(command) : false;
    toolAvailabilityCache.set(command, { available, checkedAt: nowMs });
    return available;
  };

  /**
   * What this machine can actually do to a simulator.
   *
   * One capability question now, not two: the vendored helper provides touch,
   * typing, drag AND the accessibility tree, so there is no longer a state
   * where an agent can tap but not read the screen. Inspect stays true without
   * the helper because the screenshot and the ADEInspector element file only
   * need `xcrun`.
   */
  const currentCapabilities = (): IosSimulatorCapabilities => {
    const canControl = process.platform === "darwin" && fs.existsSync(helperBinaryPath());
    return {
      canTap: canControl,
      canType: canControl,
      canDrag: canControl,
      canInspect: canControl || (cachedCommandExists("xcrun") && !simctlMissingAt),
    };
  };

  const assertDarwin = () => {
    if (process.platform !== "darwin") throw new Error(MACOS_ONLY_MESSAGE);
  };

  const runSimctlWithTimeout = async (simctlArgs: string[], timeoutMs: number, timeoutMessage: string) => {
    try {
      await run("xcrun", ["simctl", ...simctlArgs], { timeoutMs });
    } catch (error) {
      if (isTerminatedByTimeout(error)) throw new Error(timeoutMessage);
      throw error;
    }
  };

  const waitForSimulatorBootStatus = (device: Pick<IosSimulatorDevice, "udid" | "name">) =>
    runSimctlWithTimeout(
      ["bootstatus", device.udid, "-b"],
      SIMCTL_BOOTSTATUS_TIMEOUT_MS,
      `Simulator ${device.name} did not become ready within ${Math.round(SIMCTL_BOOTSTATUS_TIMEOUT_MS / 1000)}s. CoreSimulator may be stuck; shut down that simulator and launch again.`,
    );

  /**
   * Every boot and power-off goes through here, so the helper reset, the
   * recording stop and the device-list refresh cannot be left out of a path.
   * Lambdas, because the functions they call are declared further down.
   */
  const power = createSimulatorPower({
    run: (file, commandArgs, options) => run(file, commandArgs, options),
    waitForBootStatus: (device) => waitForSimulatorBootStatus(device),
    invalidateDeviceList: () => invalidateDeviceList(),
    resetHelperDevice: (udid, reason) => {
      // Every ADE boot passes here: a device ADE powered off earlier is on
      // again, so its "ADE powered this off" note is no longer true.
      if (reason === "boot") laneMaintenance().clearPowerOff(udid);
      return resetHelperDevice(udid, reason);
    },
    stopDeviceRecording: (udid, reason) => stopDeviceRecording(udid, reason),
  });

  /**
   * Boot a shut-down simulator and wait until CoreSimulator says it is ready.
   *
   * Only explicit starts come here: `deviceStart`, and `startStream` when its
   * caller passed `boot: true`. A viewer that only wants to watch gets
   * `APPLE_DEVICE_OFF` instead (see `startStream`).
   */
  const ensureDeviceBooted = async (device: IosSimulatorDevice): Promise<void> => {
    await power.bootDevice(device);
  };

  /**
   * Powered off, as `simctl list` says it. "Booting" is not off: a viewer
   * that arrives mid-boot waits for it rather than being told to press Start.
   */
  const isDeviceOff = (device: IosSimulatorDevice): boolean =>
    device.state === "Shutdown" || device.state === "Shutting Down";

  /** Drop the cached `simctl list` after ADE changed a device's power. */
  const invalidateDeviceList = (): void => {
    cachedDevices = { ...cachedDevices, computedAt: 0 };
  };

  const installAppOnSimulator = (device: IosSimulatorDevice, appBundle: string) =>
    runSimctlWithTimeout(
      ["install", device.udid, appBundle],
      SIMCTL_INSTALL_TIMEOUT_MS,
      `Timed out installing the app on ${device.name} after ${Math.round(SIMCTL_INSTALL_TIMEOUT_MS / 1000)}s. CoreSimulator did not respond; shut down that simulator and launch again.`,
    );

  const onXcodeMcpBridgeTerminated = (bridge: XcodeMcpBridge, reason: Error): void => {
    if (xcodeMcpBridge === bridge) xcodeMcpBridge = null;
    disposeXcodeMcpBridge(bridge, reason);
  };

  const getXcodeMcpBridge = (): XcodeMcpBridge => {
    if (xcodeMcpBridge && xcodeMcpBridge.child.exitCode == null && xcodeMcpBridge.child.signalCode == null) {
      return xcodeMcpBridge;
    }
    xcodeMcpBridge = createXcodeMcpBridge(onXcodeMcpBridgeTerminated);
    return xcodeMcpBridge;
  };

  const callXcodeMcpTool = async (toolName: string, toolArgs: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    const bridge = getXcodeMcpBridge();
    await ensureXcodeMcpInitialized(bridge);
    return sendXcodeMcpRequest(bridge, "tools/call", {
      name: toolName,
      arguments: toolArgs,
    }, timeoutMs, `Xcode MCP ${toolName}`);
  };

  /**
   * Which simulator an implicit device tool acts on.
   *
   * The precedence matches `computeStatus`: the app session is the most
   * specific claim, then the device session. Without the device session here, a
   * chat that opened a non-default simulator and never launched an app had
   * every `appearance`, `location` or `log` call fall through to "the first
   * booted iPhone", which is another device as soon as two are up.
   */
  const resolveControlDeviceUdid = async (deviceUdid: string | null | undefined, runtime: LaneRuntime): Promise<string> => {
    const udid = deviceUdid?.trim()
      || runtime.activeSession?.deviceUdid
      || runtime.hub?.getDeviceSession()?.deviceUdid
      || runtime.streamStatus.deviceUdid
      // The lane's own device, even when nothing has claimed it yet: a lane
      // that ran `device-create` and then `tap` means that device, and falling
      // through to "the first booted iPhone" would drive another lane's screen.
      || laneDevices.get(runtime.key)?.udid;
    if (udid) return udid;
    return (await resolveDevice(null, runtime)).udid;
  };

  /**
   * The device this lane has a claim on, widest claim first, or null.
   *
   * For the stop paths. Unlike `resolveControlDeviceUdid` it never falls back
   * to "whatever iPhone is booted": stopping a simulator this lane never
   * claimed is not a reasonable reading of "stop my device".
   */
  const claimedDeviceUdid = (runtime: LaneRuntime): string | null =>
    laneDevices.get(runtime.key)?.udid
    || runtime.activeSession?.deviceUdid
    || runtime.hub?.getDeviceSession()?.deviceUdid
    || runtime.streamStatus.deviceUdid
    || null;

  /**
   * How long one queued control may hold the input queue.
   *
   * The queue is serial on purpose — two overlapping taps on one digitizer is
   * not a gesture — but serial means one wedged command is every later tap's
   * problem. The helper's own request timeout is 30s, which is LONGER than the
   * desktop's 25s action timeout, so before this a single stuck `touch`
   * produced a caller that had already given up and a queue that kept every
   * subsequent tap waiting behind it: the storm of identical
   * `ade/actions/call` timeouts in the round-2 log. A control that has not
   * answered in eight seconds is not going to; the caller hears that, and the
   * queue moves on.
   */
  const CONTROL_TIMEOUT_MS = 8_000;

  /**
   * `timeoutMs` overrides the per-input budget for the few controls that are
   * multi-step by design (App Store shots fold twice). The race does not
   * cancel the work, so a budget that is too short would release the queue
   * while the device is still moving.
   */
  const enqueueControl = async <T>(action: string, runControl: () => Promise<T>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> => {
    const queuedAt = Date.now();
    const task = controlQueue.then(async () => {
      const startedAt = Date.now();
      const queuedMs = startedAt - queuedAt;
      let expiry: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          runControl(),
          new Promise<never>((_resolve, reject) => {
            expiry = setTimeout(() => {
              reject(new Error(
                `The simulator did not accept ${action} within ${Math.round(timeoutMs / 1000)}s.`,
              ));
            }, timeoutMs);
            (expiry as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
        args.logger.debug("ios_simulator.control_completed", {
          action,
          queuedMs,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        args.logger.debug("ios_simulator.control_failed", {
          action,
          queuedMs,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (expiry) clearTimeout(expiry);
      }
    });
    controlQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const emitLaunchProgress = (
    launchId: string,
    step: IosSimulatorLaunchStepId,
    status: IosSimulatorLaunchStepStatus,
    message: string,
    detail?: string | null,
    extra: Partial<Pick<IosSimulatorLaunchProgress, "deviceUdid" | "targetId" | "buildRoot">> = {},
  ): IosSimulatorLaunchProgress => {
    const owner = launchOwners.get(launchId) ?? null;
    const progress: IosSimulatorLaunchProgress = {
      launchId,
      step,
      status,
      message,
      detail: detail ?? null,
      chatSessionId: owner?.chatSessionId ?? null,
      laneId: owner?.laneId ?? null,
      deviceUdid: extra.deviceUdid ?? null,
      targetId: extra.targetId ?? null,
      buildRoot: extra.buildRoot ?? null,
      updatedAt: nowIso(),
    };
    emit({ type: "launch-progress", progress });
    return progress;
  };

  const resolveProjectRoot = (projectRoot?: string | null): string => {
    const raw = projectRoot?.trim();
    const resolved = raw
      ? path.resolve(raw)
      : path.resolve(args.projectRoot);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Project root ${resolved} does not exist.`);
    }
    return resolved;
  };

  /**
   * Resolves a lane to its worktree, or throws. Returns null only for "no lane
   * was named" — a named-but-unresolvable lane is an error, never a fallback:
   * quietly returning the primary checkout is how a lane agent builds and
   * screenshots code it never wrote and reports the result as verified.
   */
  const resolveLaneRoot = async (laneId?: string | null): Promise<string | null> => {
    const trimmed = laneId?.trim();
    if (!trimmed) return null;
    // A chat on another machine builds in its work copy here.
    if (isRemoteWorkLaneId(trimmed)) {
      const copy = findRemoteWorkCopyForLane(args.projectRoot, trimmed);
      if (!copy) throw new IosSimulatorLaneUnresolvedError(trimmed);
      return path.resolve(copy.path);
    }
    if (!args.resolveLaneWorktreePath) throw new IosSimulatorLaneUnresolvedError(trimmed);
    let worktreePath: string | undefined;
    try {
      worktreePath = (await args.resolveLaneWorktreePath(trimmed))?.trim();
    } catch (error) {
      args.logger.debug("ios_simulator.lane_worktree_resolve_failed", {
        laneId: trimmed,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new IosSimulatorLaneUnresolvedError(trimmed);
    }
    if (!worktreePath) throw new IosSimulatorLaneUnresolvedError(trimmed);
    const resolved = path.resolve(worktreePath);
    if (!fs.existsSync(resolved)) throw new IosSimulatorLaneUnresolvedError(trimmed);
    return resolved;
  };

  /**
   * Build root precedence: an explicit projectRoot wins, then the caller's lane
   * worktree, then the service's own root. Without the lane step an agent
   * working in a lane builds and screenshots the primary checkout, so "verify
   * my change" passes on code the agent never wrote.
   */
  const resolveScopedRoot = async (scope: RootScope = {}): Promise<string> => {
    const explicit = scope.projectRoot?.trim();
    if (explicit) return resolveProjectRoot(explicit);
    const laneRoot = await resolveLaneRoot(scope.laneId);
    return laneRoot ?? resolveProjectRoot(null);
  };

  /**
   * Same precedence, plus the active session as the *last* resort.
   *
   * The session fallback belongs after the caller's own scope, not merged into
   * it: `{ projectRoot: arg.projectRoot ?? session.projectRoot, laneId: ... }`
   * lets a session that carries a projectRoot beat a caller who explicitly
   * named a different lane, so `screenshot --lane B` captured lane A's build
   * root. Either caller field present means the caller has said which tree they
   * mean, and the session is ignored entirely.
   */
  const resolveScopedRootForSession = async (scope: RootScope = {}, runtime?: LaneRuntime): Promise<string> => {
    const callerScoped = Boolean(scope.projectRoot?.trim() || scope.laneId?.trim());
    if (callerScoped) return resolveScopedRoot(scope);
    const session = (runtime ?? resolveRuntime({})).activeSession;
    return resolveScopedRoot({
      projectRoot: session?.projectRoot,
      laneId: session?.laneId,
    });
  };

  const setStreamStopped = (runtime: LaneRuntime, error: string | null = null): IosSimulatorStreamStatus => {
    runtime.streamStatus = {
      ...runtime.streamStatus,
      running: false,
      backend: null,
      requestedBackend: null,
      fallbackReason: null,
      degradationReason: null,
      fps: null,
      targetFps: null,
      frameCount: null,
      lastError: error,
      error: error ? { code: "stream-stopped", exitCode: null, signal: null } : null,
      streamUrl: null,
      averageLatencyMs: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      helperPid: null,
      inputBackend: null,
    };
    return runtime.streamStatus;
  };

  const computeListDevices = async (): Promise<IosSimulatorDevice[]> => {
    const devices: IosSimulatorDevice[] = (await listInstalledSimulators())
      .map(({ udid, name, runtime, state }) => ({ udid, name, runtime, state, isAvailable: true }));
    return devices.sort((a, b) => {
      if (a.state === "Booted" && b.state !== "Booted") return -1;
      if (b.state === "Booted" && a.state !== "Booted") return 1;
      return a.name.localeCompare(b.name);
    });
  };

  const listDevices = async (): Promise<IosSimulatorDevice[]> => {
    const nowMs = Date.now();
    if (cachedDevices.inflight) return cachedDevices.inflight;
    if (nowMs - cachedDevices.computedAt < DEVICE_LIST_THROTTLE_MS && cachedDevices.computedAt !== 0) {
      return cachedDevices.value;
    }
    const inflight = computeListDevices()
      .then((value) => {
        cachedDevices = { value, computedAt: Date.now(), inflight: null };
        return value;
      })
      .catch((error) => {
        cachedDevices = { ...cachedDevices, inflight: null };
        throw error;
      });
    cachedDevices = { ...cachedDevices, inflight };
    return inflight;
  };

  const listProjectLaunchTargets = async (projectRoot: string): Promise<IosSimulatorLaunchTarget[]> => {
    const projectPaths = await discoverXcodeProjectPaths(projectRoot);

    const targets: IosSimulatorLaunchTarget[] = [];
    for (const projectPath of projectPaths) {
      const appTargets = parseApplicationTargetsFromPbxproj(projectPath);
      for (const appTarget of appTargets) {
        const relativeProject = relativeToRoot(projectRoot, projectPath);
        for (const scheme of schemesForApplicationTarget(projectPath, appTarget)) {
          const bundleId = scheme === ADE_IOS_SCHEME && relativeProject === ADE_IOS_PROJECT
            ? ADE_IOS_BUNDLE_ID
            : null;
          targets.push({
            // appTarget.id is the PBXNativeTarget id — including it in the
            // target id keeps two app targets that share a scheme (or a scheme
            // whose name differs from the produced `.app`) from collapsing
            // onto the same id and confusing findAppBundle().
            id: targetId(["project", relativeProject, scheme, appTarget.id]),
            kind: "project",
            name: appTarget.productName || appTarget.targetName || scheme,
            bundleId,
            detail: scheme === appTarget.targetName
              ? `${scheme} · ${relativeProject}`
              : `${scheme} · ${relativeProject} · target ${appTarget.targetName}`,
            projectPath: relativeProject,
            scheme,
            productName: appTarget.productName || appTarget.targetName || null,
            appTargetId: appTarget.id,
            appBundlePath: null,
            installed: false,
            canBuild: true,
            canLaunch: true,
            source: "xcode-project",
          });
        }
      }
    }
    return targets;
  };

  const listBuiltLaunchTargets = async (projectRoot: string): Promise<IosSimulatorLaunchTarget[]> => {
    const derivedDataPath = appleLaneDerivedDataPath(projectRoot);
    const productRoot = path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator");
    const appBundles = await findAppBundles(productRoot);
    const targets: IosSimulatorLaunchTarget[] = [];
    for (const appBundle of appBundles) {
      const infoPlist = path.join(appBundle, "Info.plist");
      const bundleId = await readPlistValue(infoPlist, "CFBundleIdentifier");
      if (!bundleId) continue;
      const displayName = await readPlistValue(infoPlist, "CFBundleDisplayName")
        ?? await readPlistValue(infoPlist, "CFBundleName")
        ?? path.basename(appBundle, ".app");
      targets.push({
        id: targetId(["built", appBundle, bundleId]),
        kind: "built",
        name: displayName,
        bundleId,
        detail: `${bundleId} · ${relativeToRoot(projectRoot, appBundle)}`,
        projectPath: null,
        scheme: null,
        productName: path.basename(appBundle, ".app") || null,
        appTargetId: null,
        appBundlePath: appBundle,
        installed: false,
        canBuild: false,
        canLaunch: true,
        source: "derived-data",
      });
    }
    return targets;
  };

  const listInstalledLaunchTargets = async (deviceUdid?: string | null): Promise<IosSimulatorLaunchTarget[]> => {
    if (!deviceUdid || !cachedCommandExists("xcrun")) return [];
    let stdout = "";
    try {
      ({ stdout } = await run("xcrun", ["simctl", "listapps", deviceUdid], { timeoutMs: 20_000 }));
    } catch {
      return [];
    }
    const targets: IosSimulatorLaunchTarget[] = [];
    const entries = stdout.matchAll(/"([^"]+)"\s*=\s*\{([\s\S]*?)\n\s*\};/g);
    for (const match of entries) {
      const bundleId = match[1];
      const body = match[2] ?? "";
      if (!bundleId || bundleId.startsWith("com.apple.")) continue;
      const name =
        /CFBundleDisplayName\s*=\s*"([^"]+)";/.exec(body)?.[1]
        ?? /CFBundleName\s*=\s*"([^"]+)";/.exec(body)?.[1]
        ?? bundleId;
      targets.push({
        id: targetId(["installed", deviceUdid, bundleId]),
        kind: "installed",
        name,
        bundleId,
        detail: `${bundleId} · installed on selected simulator`,
        projectPath: null,
        scheme: null,
        productName: null,
        appTargetId: null,
        appBundlePath: null,
        installed: true,
        canBuild: false,
        canLaunch: true,
        source: "simctl-listapps",
      });
    }
    return targets;
  };

  const listLaunchTargets = async (targetArgs: IosSimulatorListLaunchTargetsArgs = {}): Promise<IosSimulatorLaunchTarget[]> => {
    const projectRoot = await resolveScopedRoot(targetArgs);
    const [projectTargets, builtTargets, installedTargets] = await Promise.all([
      listProjectLaunchTargets(projectRoot),
      listBuiltLaunchTargets(projectRoot),
      listInstalledLaunchTargets(targetArgs.deviceUdid ?? resolveRuntime(targetArgs).activeSession?.deviceUdid),
    ]);
    const byKey = new Map<string, IosSimulatorLaunchTarget>();
    const priority = { project: 0, built: 1, installed: 2 } satisfies Record<IosSimulatorLaunchTarget["kind"], number>;
    for (const target of [...projectTargets, ...builtTargets, ...installedTargets]) {
      const key = target.bundleId ?? target.id;
      const existing = byKey.get(key);
      if (!existing || priority[target.kind] < priority[existing.kind]) byKey.set(key, target);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.kind === "project" && b.kind !== "project") return -1;
      if (b.kind === "project" && a.kind !== "project") return 1;
      return a.name.localeCompare(b.name);
    });
  };

  /**
   * Which simulator a call means.
   *
   * A lane that owns a device always means that device, and it is checked
   * before the "newest booted iPhone" ranking below: with two lanes running,
   * the ranking is a coin flip that silently drives the wrong screen.
   */
  const resolveDevice = async (deviceUdid?: string | null, runtime?: LaneRuntime): Promise<IosSimulatorDevice> => {
    const devices = await listDevices();
    if (deviceUdid) {
      const exact = devices.find((device) => device.udid === deviceUdid);
      if (exact) return exact;
      throw new Error(`Simulator device ${deviceUdid} is not available.`);
    }
    const laneDevice = runtime ? laneDevices.get(runtime.key) : null;
    if (laneDevice) {
      const owned = devices.find((device) => device.udid === laneDevice.udid);
      if (owned) return owned;
      throw new Error(`Lane ${runtime?.key ?? ""} owns simulator ${laneDevice.name} (${laneDevice.udid}), which is no longer available. Run device-delete and create one again.`);
    }
    const ranked = [...devices].sort((a, b) => {
      if (a.state === "Booted" && b.state !== "Booted") return -1;
      if (b.state === "Booted" && a.state !== "Booted") return 1;
      const aIphone = /iphone/i.test(a.name) ? 1 : 0;
      const bIphone = /iphone/i.test(b.name) ? 1 : 0;
      if (aIphone !== bIphone) return bIphone - aIphone;
      const versionDelta = appleRuntimeScore(b.runtime) - appleRuntimeScore(a.runtime);
      if (versionDelta !== 0) return versionDelta;
      return a.name.localeCompare(b.name);
    });
    const fallback = ranked[0];
    if (!fallback) throw new Error("No available iOS Simulator devices were found.");
    return fallback;
  };

  /**
   * Probes for a real Simulator.app instead of reporting "available" for every
   * macOS. Filesystem checks only, cached: the status path runs every ~500ms
   * while the drawer is open. Screen-recording permission is a separate,
   * desktop-layer concern.
   */
  const findSimulatorApp = (): string | null => {
    if (process.platform !== "darwin") return null;
    const cached = simulatorAppCache;
    if (cached && Date.now() - cached.checkedAt < TOOL_STATUS_CACHE_MS) return cached.path;
    const developerDir = process.env.DEVELOPER_DIR?.trim();
    const candidates = [
      developerDir ? path.join(developerDir, "Applications", "Simulator.app") : null,
      "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app",
      "/Applications/Simulator.app",
    ].filter((candidate): candidate is string => Boolean(candidate));
    const found = candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ?? null;
    simulatorAppCache = { path: found, checkedAt: Date.now() };
    return found;
  };

  const buildToolStatuses = (): IosSimulatorToolStatus[] => {
    const isDarwin = process.platform === "darwin";
    const xcrunAvailable = isDarwin && cachedCommandExists("xcrun");
    const xcodebuildAvailable = isDarwin && cachedCommandExists("xcodebuild");
    const helperInfo = helperToolInfo();
    const simulatorAppPath = findSimulatorApp();
    return [
      {
        name: "xcrun",
        available: xcrunAvailable,
        detail: xcrunAvailable
          ? "Available for simulator boot, install, launch, screenshots, and built-in snapshot preview."
          : isDarwin
            ? "Xcode command line tools are not on PATH."
            : "Only available on macOS.",
        installHint: isDarwin ? INSTALL_HINT_XCODE_CLI : "iOS Simulator control requires macOS.",
      },
      {
        name: "xcodebuild",
        available: xcodebuildAvailable,
        detail: xcodebuildAvailable
          ? "Available for building iOS apps."
          : isDarwin
            ? "Install Xcode to build iOS apps."
            : "Only available on macOS.",
        installHint: isDarwin ? INSTALL_HINT_XCODE : "iOS Simulator control requires macOS.",
      },
      {
        name: "simulator_window",
        available: Boolean(simulatorAppPath),
        detail: simulatorAppPath
          ? `Simulator.app found at ${simulatorAppPath}.`
          : isDarwin
            ? "Simulator.app was not found. Install Xcode, then run xcode-select --install."
            : "Simulator window mirroring is only available on macOS.",
        installHint: isDarwin ? INSTALL_HINT_XCODE : "iOS Simulator control requires macOS.",
      },
      {
        name: "helper",
        available: helperInfo.present && helperClient?.refusedProtocol() == null,
        detail: helperClient?.refusedProtocol() != null
          ? simHelperProtocolMessage(helperInfo.path, helperClient.refusedProtocol() as number)
          : helperInfo.present
          ? `Vendored simulator helper at ${helperInfo.path}${helperInfo.version == null ? "" : ` (protocol ${helperInfo.version})`}. Provides the live view, touch, typing, and the accessibility tree.`
          : isDarwin
            ? [`The simulator helper is not installed on this Mac (expected at ${helperInfo.path}).`, simHelperSearchSummary()].filter(Boolean).join(" ")
            : "The vendored simulator helper only runs on macOS.",
        installHint: isDarwin ? INSTALL_HINT_SIM_HELPER : "Apple device control requires macOS.",
      },
    ];
  };

  /** What `status.tools` and `status.helper` say about the vendored helper. */
  const helperToolInfo = (): AppleHelperToolInfo => {
    if (process.platform !== "darwin") {
      return { present: false, path: helperBinaryPath(), version: null };
    }
    // `helperClient` is read rather than created: `getStatus` runs every ~500ms
    // while the column is open, and a status poll must not be what starts a
    // subprocess.
    const client = helperClient;
    return {
      present: client ? client.exists() : fs.existsSync(helperBinaryPath()),
      path: helperBinaryPath(),
      version: client?.protocolVersion() ?? null,
    };
  };

  /**
   * The live view, as a status read reports it.
   *
   * Built from named fields rather than a spread of `streamStatus`: that object
   * carries the stream's address and token, and `getStatus` is on the action
   * allowlist, so a spread here would put a live token in every agent's poll.
   *
   * Read on the cached path too. It is in-memory and free, and a status whose
   * whole job is answering "what is going on right now" must not report a
   * stream that started a second ago as stopped.
   */
  const currentStatusStream = (runtime: LaneRuntime): IosSimulatorStatusStream => ({
    running: runtime.streamStatus.running,
    backend: runtime.streamStatus.backend,
    deviceUdid: runtime.streamStatus.deviceUdid,
    fps: runtime.streamStatus.fps,
    bitrateKbps: runtime.streamStatus.bitrateKbps ?? null,
    lastError: runtime.streamStatus.lastError,
  });

  /**
   * The lane's live recording, redacted to what a status reader needs.
   *
   * The path and the byte count are deliberately absent: status is polled into
   * transcripts and onto a phone, and the file is `record-list`'s to describe.
   */
  const currentStatusRecording = (runtime: LaneRuntime): IosSimulatorStatusRecording | null => {
    if (!runtime.key) return null;
    const record = recordings.active({ laneId: runtime.key });
    if (!record) return null;
    return {
      id: record.id,
      startedAt: record.startedAt,
      mode: record.mode,
      chatSessionId: record.chatSessionId,
    };
  };

  const computeStatus = async (runtime: LaneRuntime): Promise<IosSimulatorStatus> => {
    const isDarwin = process.platform === "darwin";
    const tools = buildToolStatuses();
    const devices = isDarwin ? await listDevices().catch(() => []) : [];
    // An open device session names the device as surely as an app session does,
    // and it comes second only because an app session is the more specific
    // claim. The lane's own device comes next: a lane that created one and has
    // not launched anything still has a device to render.
    const deviceSession = hub(runtime).getDeviceSession();
    const laneDevice = laneDevices.get(runtime.key);
    const activeDevice = runtime.activeSession
      ? devices.find((device) => device.udid === runtime.activeSession?.deviceUdid) ?? null
      : deviceSession
        ? devices.find((device) => device.udid === deviceSession.deviceUdid) ?? null
        : laneDevice
          ? devices.find((device) => device.udid === laneDevice.udid) ?? null
          : devices.find((device) => device.state === "Booted" && /iphone/i.test(device.name)) ?? null;
    const xcrunAvailable = tools.find((tool) => tool.name === "xcrun")?.available ?? false;
    const xcodebuildAvailable = tools.find((tool) => tool.name === "xcodebuild")?.available ?? false;
    // Why a lane device ADE powered off is off, from the list read above: a
    // pane that polls the status must not pay a second `simctl list` for it.
    // A notice that cannot be built must not fail the status read; it is
    // logged so the failing read is not invisible.
    const powerOffNotices = isDarwin
      ? await devicePowerOffNotices(runtime.key, devices).catch((error: unknown) => {
        args.logger.warn("apple.device_power_off_notices_failed", {
          laneId: runtime.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as string[];
      })
      : [];
    return {
      platform: process.platform,
      supported: isDarwin && xcrunAvailable && xcodebuildAvailable,
      tools,
      activeDevice,
      activeSession: runtime.activeSession,
      remoteHolder: remoteHolderOf(runtime.activeSession?.chatSessionId ?? null),
      deviceSession,
      laneDevice: laneDevice ?? null,
      laneId: runtime.laneId,
      helper: helperToolInfo(),
      ...(powerOffNotices.length ? { deviceNotices: powerOffNotices } : {}),
      // The same redaction rule as `getStreamStatus`: the shape, never the
      // address or the token.
      stream: currentStatusStream(runtime),
      recording: currentStatusRecording(runtime),
      // Round 5 §S4: an agent that has just landed in a lane learns what it may
      // do with the device from the call it already makes, instead of reading
      // source or guessing verb names. Same list the action allowlist spreads.
      capabilities: APPLE_AGENT_ACTIONS,
    };
  };

  const getStatus = async (statusArgs: IosSimulatorStatusArgs = {}): Promise<IosSimulatorStatus> => {
    const runtime = resolveRuntime(statusArgs);
    const nowMs = Date.now();
    if (runtime.cachedStatus.inflight) return runtime.cachedStatus.inflight;
    if (nowMs - runtime.cachedStatus.computedAt < STATUS_THROTTLE_MS && runtime.cachedStatus.computedAt !== 0) {
      return {
        ...runtime.cachedStatus.value,
        remoteHolder: remoteHolderOf(runtime.activeSession?.chatSessionId ?? null),
        activeSession: runtime.activeSession,
        // Both of these are in-memory reads, so the throttle exists to spare
        // the `simctl` device list, not these. Serving them from the cache
        // would report a session or a stream that changed since it was built.
        deviceSession: hub(runtime).getDeviceSession(),
        laneDevice: laneDevices.get(runtime.key),
        stream: currentStatusStream(runtime),
        recording: currentStatusRecording(runtime),
      };
    }
    const inflight = computeStatus(runtime)
      .then((value) => {
        runtime.cachedStatus = { value, computedAt: Date.now(), inflight: null };
        return value;
      })
      .catch((error) => {
        runtime.cachedStatus = { ...runtime.cachedStatus, inflight: null };
        throw error;
      });
    runtime.cachedStatus = { ...runtime.cachedStatus, inflight };
    return inflight;
  };

  /**
   * The chat holding the lane's device, from memory alone.
   *
   * The same two claims `getStatus` reports (an app session first, then a
   * bare device session), without its `simctl` device list. A remote tap
   * checks ownership on every gesture, and the status throttle is 500 ms, so
   * reading the owner through `getStatus` put a `simctl` round trip in front
   * of most taps from a phone.
   */
  const getControlOwner = (ownerArgs: { laneId?: string | null } = {}): string | null => {
    const runtime = resolveRuntime(ownerArgs);
    // Trimmed and fallen through like the status projection: a blank app
    // claim must not hide a device session's.
    return runtime.activeSession?.chatSessionId?.trim()
      || hub(runtime).getDeviceSession()?.chatSessionId?.trim()
      || null;
  };

  /**
   * The device this lane holds a claim on, or null; never the "first booted
   * iPhone" fallback. Remote input targets only this, so a tap sent for a
   * lane with no device of its own cannot land on another lane's screen.
   */
  const getClaimedDevice = (claimArgs: { laneId?: string | null } = {}): string | null =>
    claimedDeviceUdid(resolveRuntime(claimArgs));

  /** Invalidate a lane's cached status after a state change. */
  const invalidateStatus = (runtime: LaneRuntime): void => {
    runtime.cachedStatus = { ...runtime.cachedStatus, computedAt: 0 };
  };

  const isXcodeRunning = async (): Promise<boolean> => {
    if (process.platform !== "darwin") return false;
    try {
      const { stdout } = await run("pgrep", ["-x", "Xcode"], { timeoutMs: 3_000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  const findMcpbridge = async (): Promise<boolean> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return false;
    try {
      const { stdout } = await run("xcrun", ["--find", "mcpbridge"], { timeoutMs: 5_000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  const readXcodeVersion = async (): Promise<string | null> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcodebuild")) return null;
    try {
      const { stdout } = await run("xcodebuild", ["-version"], { timeoutMs: 5_000 });
      return stdout.trim().replace(/\n/g, " · ") || null;
    } catch {
      return null;
    }
  };

  const listXcodePreviewWindows = async (projectRoot: string): Promise<IosSimulatorPreviewWindow[]> => {
    const result = await callXcodeMcpTool("XcodeListWindows", {}, XCODE_MCP_APPROVAL_TIMEOUT_MS);
    const object = objectFromMcpResult(result);
    const message = typeof object.message === "string" ? object.message : textFromMcpResult(result);
    return parseXcodePreviewWindows(message, projectRoot).filter((window) => window.tabIdentifier);
  };

  const pickPreviewWindow = (windows: IosSimulatorPreviewWindow[], projectRoot: string): IosSimulatorPreviewWindow | null => {
    if (!windows.length) return null;
    const iosRoot = path.join(projectRoot, "apps", "ios");
    return [...windows]
      .map((window) => {
        const raw = `${window.workspacePath ?? ""}\n${window.raw}`.toLowerCase();
        let score = 0;
        if (raw.includes(projectRoot.toLowerCase())) score += 100;
        if (raw.includes(iosRoot.toLowerCase())) score += 80;
        if (raw.includes("ade.xcodeproj") || raw.includes("ade.xcworkspace")) score += 60;
        if (raw.includes("ade")) score += 20;
        return { window, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.window ?? windows[0] ?? null;
  };

  const previewWorkspaceOpenPath = (projectRoot: string): string => {
    const projectPath = path.join(projectRoot, ADE_IOS_PROJECT);
    return fs.existsSync(projectPath) ? projectPath : path.join(projectRoot, "apps", "ios");
  };

  const getPreviewCapability = async (previewArgs: IosSimulatorListPreviewsArgs = {}): Promise<IosSimulatorPreviewCapability> => {
    const projectRoot = await resolveScopedRoot(previewArgs);
    const [xcodeVersion, mcpbridgeAvailable, xcodeRunning] = await Promise.all([
      readXcodeVersion(),
      findMcpbridge(),
      isXcodeRunning(),
    ]);
    let windows: IosSimulatorPreviewWindow[] = [];
    let error: string | null = null;
    if (mcpbridgeAvailable && xcodeRunning) {
      try {
        windows = await listXcodePreviewWindows(projectRoot);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    const selectedWindow = pickPreviewWindow(windows, projectRoot);
    const setupSteps: string[] = [];
    if (process.platform !== "darwin") setupSteps.push("Use macOS for Xcode Preview rendering.");
    if (!xcodeVersion) setupSteps.push("Install Xcode 26.3 or newer.");
    if (!mcpbridgeAvailable) setupSteps.push("Install or select an Xcode that provides `xcrun mcpbridge`.");
    if (!xcodeRunning) setupSteps.push("Open apps/ios/ADE.xcodeproj in Xcode before rendering previews.");
    if (error) setupSteps.push("If Xcode shows an \"Allow\" prompt for ADE Preview Lab, click Allow and keep ADE open until the retry finishes.");
    if (error) setupSteps.push("If no prompt appears, open Xcode > Settings > Intelligence and enable \"Allow external agents to use Xcode tools\" under Model Context Protocol.");
    if (xcodeRunning && !error && !selectedWindow) setupSteps.push("Bring the Xcode window for apps/ios/ADE.xcodeproj forward, then retry.");
    return {
      platform: process.platform,
      supported: process.platform === "darwin" && Boolean(xcodeVersion) && mcpbridgeAvailable && xcodeRunning && Boolean(selectedWindow) && !error,
      docsUrl: XCODE_MCP_DOCS_URL,
      xcodeVersion,
      mcpbridgeAvailable,
      xcodeRunning,
      xcodeWindows: windows,
      selectedWindow,
      setupSteps,
      error,
      checkedAt: nowIso(),
    };
  };

  const listPreviewTargets = async (previewArgs: IosSimulatorListPreviewsArgs = {}): Promise<IosSimulatorPreviewTarget[]> => {
    const projectRoot = await resolveScopedRoot(previewArgs);
    const selectedFile = resolveSwiftSourceFile(projectRoot, previewArgs.sourceFile);
    const selectedSourceLine = previewArgs.sourceLine != null && Number.isFinite(previewArgs.sourceLine)
      ? Math.max(1, Math.round(previewArgs.sourceLine))
      : null;
    const contextTerms = previewContextTerms(previewArgs);
    const swiftFiles = collectSwiftFiles(projectRoot);
    const filesWithPreviews = swiftFiles
      .map((filePath) => {
        let text = "";
        try {
          text = fs.readFileSync(filePath, "utf8");
        } catch {
          return null;
        }
        const definitions = parseSwiftPreviewDefinitions(text);
        return definitions.length ? { filePath, definitions } : null;
      })
      .filter((entry): entry is { filePath: string; definitions: SwiftPreviewDefinition[] } => Boolean(entry));
    const scoreFile = (filePath: string): number => {
      if (!selectedFile) return 0;
      if (path.resolve(filePath) === path.resolve(selectedFile)) return 1000;
      const selectedDir = path.dirname(selectedFile);
      const selectedBase = path.basename(selectedFile, ".swift").replace(/View$/, "");
      let score = 0;
      if (path.dirname(filePath) === selectedDir) score += 200;
      if (path.basename(filePath).toLowerCase().includes("preview")) score += 80;
      if (path.basename(filePath).toLowerCase().includes(selectedBase.toLowerCase())) score += 120;
      const selectedParts = selectedDir.split(path.sep);
      const fileParts = path.dirname(filePath).split(path.sep);
      if (selectedParts.some((part) => part && fileParts.includes(part) && /Views|Work|Lanes|PRs|Files|Cto/i.test(part))) score += 40;
      return score;
    };
    const scoreDefinition = (filePath: string, definition: SwiftPreviewDefinition): number => {
      let score = scoreFile(filePath) * 1_000;
      if (selectedFile && selectedSourceLine && path.resolve(filePath) === path.resolve(selectedFile)) {
        score += Math.max(0, 600 - Math.min(600, Math.abs(definition.line - selectedSourceLine)));
      }
      const title = previewSearchText(definition.title);
      for (const term of contextTerms) {
        if (title.includes(term)) score += 250;
      }
      return score;
    };
    return filesWithPreviews
      .flatMap(({ filePath, definitions }) => {
        const proximity = previewProximity(projectRoot, filePath, selectedFile);
        return definitions.map((definition) => {
          const sourceFile = relativeToRoot(projectRoot, filePath);
          const sourceFilePath = sourceFilePathForXcode(projectRoot, filePath);
          return {
            score: scoreDefinition(filePath, definition),
            target: {
              id: targetId(["preview", sourceFilePath, String(definition.index)]),
              title: definition.title,
              sourceFile,
              sourceFilePath,
              absoluteSourceFile: filePath,
              sourceLine: definition.line,
              previewDefinitionIndexInFile: definition.index,
              kind: definition.kind,
              proximity,
            },
          };
        });
      })
      .sort((a, b) =>
        b.score - a.score
        || a.target.sourceFile.localeCompare(b.target.sourceFile)
        || a.target.sourceLine - b.target.sourceLine)
      .map((entry) => entry.target)
      .slice(0, 50);
  };

  const previewArgsWithLastSelection = (
    previewArgs: IosSimulatorListPreviewsArgs = {},
  ): IosSimulatorListPreviewsArgs => {
    const hasSource = typeof previewArgs.sourceFile === "string" && previewArgs.sourceFile.trim().length > 0;
    if (hasSource || !lastSelectedItem?.sourceFile) return previewArgs;
    const metadata = isRecord(lastSelectedItem.metadata) ? lastSelectedItem.metadata : {};
    const label = typeof metadata.label === "string" && metadata.label.trim()
      ? metadata.label
      : null;
    return {
      ...previewArgs,
      sourceFile: lastSelectedItem.sourceFile,
      sourceLine: previewArgs.sourceLine ?? lastSelectedItem.sourceLine,
      elementLabel: previewArgs.elementLabel ?? label,
      componentId: previewArgs.componentId ?? lastSelectedItem.componentId,
    };
  };

  const resolvePreviewMatch = async (rawPreviewArgs: IosSimulatorListPreviewsArgs = {}): Promise<IosSimulatorPreviewMatch> => {
    const previewArgs = previewArgsWithLastSelection(rawPreviewArgs);
    const projectRoot = await resolveScopedRoot(previewArgs);
    const rawSourceFile = previewArgs.sourceFile?.trim() ?? "";
    const selectedFile = resolveSwiftSourceFile(projectRoot, previewArgs.sourceFile);
    const selectedSourceFile = selectedFile ? relativeToRoot(projectRoot, selectedFile) : rawSourceFile || null;
    const selectedSourceLine = previewArgs.sourceLine != null && Number.isFinite(previewArgs.sourceLine)
      ? Math.max(1, Math.round(previewArgs.sourceLine))
      : null;
    const suggestion = previewSuggestionForSource(projectRoot, selectedFile, previewArgs);

    if (!rawSourceFile && !selectedFile) {
      return {
        status: "no-context",
        target: null,
        confidence: "none",
        reason: "Select a source-backed simulator element first (`ade --socket ios-sim select --x <x> --y <y> --text`) or pass `--source <swift-file> --line <n>` before opening the screen in Preview Lab.",
        selectedSourceFile: null,
        selectedSourceLine,
        ...suggestion,
      };
    }
    if (rawSourceFile && !selectedFile) {
      return {
        status: "missing-source",
        target: null,
        confidence: "none",
        reason: `ADE could not resolve the selected Swift source file: ${rawSourceFile}.`,
        selectedSourceFile,
        selectedSourceLine,
        ...suggestion,
      };
    }

    const targets = await listPreviewTargets(previewArgs);
    const target = targets[0] ?? null;
    if (!target) {
      return {
        status: "missing-preview",
        target: null,
        confidence: "none",
        reason: selectedSourceFile
          ? `No #Preview or PreviewProvider was found near ${selectedSourceFile}.`
          : "No renderable #Preview or PreviewProvider was found for the selected simulator context.",
        selectedSourceFile,
        selectedSourceLine,
        ...suggestion,
      };
    }

    const confidence = target.proximity === "selected-file"
      ? "exact"
      : target.proximity === "feature-file"
        ? "nearby"
        : "fallback";
    const reason = confidence === "exact"
      ? `Matched a preview in the selected source file ${target.sourceFile}.`
      : confidence === "nearby"
        ? `Matched the nearest feature preview ${target.sourceFile}.`
        : `Using a project preview fallback from ${target.sourceFile}; create a closer preview if this does not represent the selected screen.`;
    return {
      status: "matched",
      target,
      confidence,
      reason,
      selectedSourceFile,
      selectedSourceLine,
      ...suggestion,
    };
  };

  const renderCurrentPreview = async (
    previewArgs: IosSimulatorRenderCurrentPreviewArgs = {},
  ): Promise<IosSimulatorRenderCurrentPreviewResult> => {
    const match = await resolvePreviewMatch(previewArgs);
    const target = match.target;
    if (!target) {
      return {
        ok: false,
        match,
        target: null,
        render: null,
        error: match.reason,
      };
    }

    const render = await renderPreview({
      projectRoot: previewArgs.projectRoot,
      laneId: previewArgs.laneId,
      sourceFilePath: target.sourceFilePath,
      previewDefinitionIndexInFile: target.previewDefinitionIndexInFile,
      tabIdentifier: previewArgs.tabIdentifier,
      timeoutSec: previewArgs.timeoutSec,
    });
    return {
      ok: render.ok,
      match,
      target,
      render,
      error: render.error,
    };
  };

  const ensurePreviewWorkspace = async (
    ensureArgs: IosSimulatorEnsurePreviewWorkspaceArgs = {},
  ): Promise<IosSimulatorEnsurePreviewWorkspaceResult> => {
    const projectRoot = await resolveScopedRoot(ensureArgs);
    const openPath = previewWorkspaceOpenPath(projectRoot);
    const openIfNeeded = ensureArgs.openIfNeeded !== false;
    const rawTimeoutMs = Number(ensureArgs.timeoutMs ?? 12_000);
    const timeoutMs = Number.isFinite(rawTimeoutMs)
      ? Math.max(1_000, Math.min(30_000, Math.round(rawTimeoutMs)))
      : 12_000;
    let opened = false;
    let capability = await getPreviewCapability(ensureArgs);
    const canOpen = process.platform === "darwin" && Boolean(capability.xcodeVersion) && capability.mcpbridgeAvailable;

    if (!capability.supported && openIfNeeded && canOpen) {
      spawnProcess("open", ["-a", "Xcode", openPath], { detached: true, stdio: "ignore" }).unref();
      opened = true;
      await delay(750);
    }

    if (!openIfNeeded) {
      return {
        ok: capability.supported,
        opened,
        path: openPath,
        capability,
        error: capability.supported
          ? null
          : capability.error ?? capability.setupSteps[0] ?? "Xcode Preview rendering is not ready.",
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (!capability.supported && canOpen && Date.now() < deadline) {
      await delay(1_000);
      capability = await getPreviewCapability(ensureArgs);
      if (capability.supported) break;
    }

    return {
      ok: capability.supported,
      opened,
      path: openPath,
      capability,
      error: capability.supported
        ? null
        : capability.error ?? capability.setupSteps[0] ?? "Xcode Preview rendering is not ready.",
    };
  };

  const renderPreview = async (renderArgs: IosSimulatorRenderPreviewArgs): Promise<IosSimulatorRenderPreviewResult> => {
    const projectRoot = await resolveScopedRoot(renderArgs);
    const previewDefinitionIndexInFile = Math.max(0, Math.round(Number(renderArgs.previewDefinitionIndexInFile ?? 0)));
    const rawSourceFilePath = typeof renderArgs.sourceFilePath === "string" ? renderArgs.sourceFilePath.trim() : "";
    if (!rawSourceFilePath) {
      throw new Error("Xcode Preview rendering requires sourceFilePath. Run `ade ios-sim previews --source <swift-file> --text` to find a renderable preview, then pass that file to `ade ios-sim preview-render --source <swift-file>`.");
    }
    const resolvedSourceFile = resolveSwiftSourceFile(projectRoot, rawSourceFilePath);
    if (!resolvedSourceFile) {
      throw new Error(`Swift source file was not found: ${rawSourceFilePath}. Run \`ade --socket ios-sim snapshot --text\` to confirm the current simulator screen, then \`ade --socket ios-sim previews --source <swift-file> --text\` with a real Swift file before running \`ade --socket ios-sim preview-render --source <swift-file> --text\`.`);
    }
    const sourceFilePath = sourceFilePathForXcode(projectRoot, resolvedSourceFile);
    const capability = renderArgs.manageXcode === false
      ? await getPreviewCapability({ projectRoot })
      : (await ensurePreviewWorkspace({
          projectRoot,
          sourceFile: rawSourceFilePath,
          openIfNeeded: true,
          timeoutMs: 12_000,
        })).capability;
    const selectedWindow = renderArgs.tabIdentifier
      ? capability.xcodeWindows.find((window) => window.tabIdentifier === renderArgs.tabIdentifier) ?? null
      : capability.selectedWindow;
    const target = {
      sourceFilePath,
      previewDefinitionIndexInFile,
      tabIdentifier: selectedWindow?.tabIdentifier ?? renderArgs.tabIdentifier ?? null,
    };
    if (!capability.supported || !target.tabIdentifier) {
      return {
        ok: false,
        target,
        previewSnapshotPath: null,
        dataUrl: null,
        width: null,
        height: null,
        renderedAt: nowIso(),
        capability,
        error: capability.error ?? capability.setupSteps[0] ?? "Xcode Preview rendering is not ready.",
      };
    }

    try {
      const timeoutSec = Math.max(5, Math.min(240, Math.round(Number(renderArgs.timeoutSec ?? 120))));
      const result = await callXcodeMcpTool("RenderPreview", {
        tabIdentifier: target.tabIdentifier,
        sourceFilePath: target.sourceFilePath,
        previewDefinitionIndexInFile,
        timeout: timeoutSec,
      }, (timeoutSec + 5) * 1000);
      const object = objectFromMcpResult(result);
      const errorMessage = isRecord(object.error) && typeof object.error.message === "string"
        ? object.error.message
        : null;
      const previewSnapshotPath = typeof object.previewSnapshotPath === "string"
        ? object.previewSnapshotPath
        : /previewSnapshotPath["\s:=]+([^"\n,}]+)/.exec(textFromMcpResult(result))?.[1]?.trim() ?? null;
      if (errorMessage || !previewSnapshotPath) {
        return {
          ok: false,
          target,
          previewSnapshotPath: previewSnapshotPath ?? null,
          dataUrl: null,
          width: null,
          height: null,
          renderedAt: nowIso(),
          capability,
          error: errorMessage ?? "Xcode did not return a preview image.",
        };
      }
      const buffer = await fs.promises.readFile(previewSnapshotPath);
      const dimensions = pngDimensions(buffer) ?? { width: null, height: null };
      return {
        ok: true,
        target,
        previewSnapshotPath,
        dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        width: dimensions.width,
        height: dimensions.height,
        renderedAt: nowIso(),
        capability,
        error: null,
      };
    } catch (failure) {
      return {
        ok: false,
        target,
        previewSnapshotPath: null,
        dataUrl: null,
        width: null,
        height: null,
        renderedAt: nowIso(),
        capability,
        error: failure instanceof Error ? failure.message : String(failure),
      };
    }
  };

  const openPreviewWorkspace = async (openArgs: IosSimulatorOpenPreviewWorkspaceArgs = {}): Promise<{ ok: true; path: string }> => {
    const projectRoot = await resolveScopedRoot(openArgs);
    const openPath = previewWorkspaceOpenPath(projectRoot);
    if (process.platform !== "darwin") throw new Error("Xcode preview setup is only available on macOS.");
    spawnProcess("open", ["-a", "Xcode", openPath], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path: openPath };
  };

  const resolveLaunchTarget = async (launchArgs: IosSimulatorLaunchArgs, deviceUdid: string, projectRoot: string): Promise<ResolvedLaunchTarget> => {
    const targets = await listLaunchTargets({ deviceUdid, projectRoot });
    const explicitAppBundle = launchArgs.appBundlePath
      ? path.isAbsolute(launchArgs.appBundlePath)
        ? launchArgs.appBundlePath
        : path.join(projectRoot, launchArgs.appBundlePath)
      : null;
    let target: IosSimulatorLaunchTarget | null = null;

    if (launchArgs.targetId) {
      assertTargetIdWithinRoot(launchArgs.targetId, projectRoot);
      target = targets.find((candidate) => candidate.id === launchArgs.targetId) ?? null;
      target ??= recoverStaleLaunchTarget(launchArgs.targetId, targets, projectRoot);
      if (!target) {
        const decoded = decodeTargetId(launchArgs.targetId);
        if (decoded[0] === "project" && decoded[1]) {
          throw new IosSimulatorTargetRootMismatchError(`no Xcode project ${decoded[1]} exists under the build root ${projectRoot}.`);
        }
        throw new Error(`Launch target ${launchArgs.targetId} was not found. Refresh launchable iOS apps and try again.`);
      }
      if (!targetPathWithinRoot(projectRoot, target)) {
        throw new IosSimulatorTargetRootMismatchError(`launch target ${target.name} resolves outside the build root ${projectRoot}.`);
      }
    }
    if (!target && launchArgs.bundleId) {
      target = targets.find((candidate) => candidate.bundleId === launchArgs.bundleId) ?? null;
    }
    if (!target && explicitAppBundle) {
      const bundleId = await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleIdentifier");
      const displayName = await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleDisplayName")
        ?? await readPlistValue(path.join(explicitAppBundle, "Info.plist"), "CFBundleName")
        ?? path.basename(explicitAppBundle, ".app");
      target = {
        id: targetId(["built", explicitAppBundle, bundleId]),
        kind: "built",
        name: displayName,
        bundleId: bundleId ?? launchArgs.bundleId ?? null,
        detail: `${bundleId ?? "unknown bundle"} · ${relativeToRoot(projectRoot, explicitAppBundle)}`,
        projectPath: null,
        scheme: null,
        productName: path.basename(explicitAppBundle, ".app") || null,
        appTargetId: null,
        appBundlePath: explicitAppBundle,
        installed: false,
        canBuild: false,
        canLaunch: true,
        source: "derived-data",
      };
    }
    if (!target && (launchArgs.projectPath || launchArgs.scheme)) {
      const projectPath = normalizeProjectPath(projectRoot, launchArgs.projectPath ?? ADE_IOS_PROJECT);
      if (!projectPath) {
        throw new Error(`iOS project ${launchArgs.projectPath ?? ADE_IOS_PROJECT} was not found.`);
      }
      const relativeProject = relativeToRoot(projectRoot, projectPath);
      const scheme = launchArgs.scheme ?? ADE_IOS_SCHEME;
      target = {
        id: targetId(["project", relativeProject, scheme]),
        kind: "project",
        name: scheme,
        bundleId: relativeProject === ADE_IOS_PROJECT && scheme === ADE_IOS_SCHEME ? ADE_IOS_BUNDLE_ID : launchArgs.bundleId ?? null,
        detail: `${scheme} · ${relativeProject}`,
        projectPath: relativeProject,
        scheme,
        // Synthesized fallback target — caller didn't reference a discovered
        // PBX target, so we have no productName/appTargetId. findAppBundle
        // falls back to scheme/ADE.app, which is safe for the synthesized path.
        productName: null,
        appTargetId: null,
        appBundlePath: null,
        installed: false,
        canBuild: true,
        canLaunch: true,
        source: "xcode-project",
      };
    }
    // Only fall back to a target the caller did not name when it can actually
    // be built. Silently picking an already-installed app used to report
    // "App launched" for code that was never compiled.
    //
    // The fallback is gated on the caller having named nothing. A caller that
    // named a bundle id which matched no target used to fall through to this
    // default anyway: xcodebuild built an unrelated scheme, simctl launched it,
    // and the caller "verified" an app it never asked for.
    const namedATarget = Boolean(launchArgs.targetId || launchArgs.bundleId || launchArgs.appBundlePath);
    if (!namedATarget) {
      target ??= targets.find((candidate) => candidate.kind === "project" && candidate.projectPath === ADE_IOS_PROJECT && candidate.scheme === ADE_IOS_SCHEME)
        ?? targets.find((candidate) => candidate.kind === "project")
        ?? null;
    }
    if (!target && !namedATarget) {
      const buildable = targets.filter((candidate) => candidate.canBuild);
      const installedOnly = targets.filter((candidate) => !candidate.canBuild);
      throw new IosSimulatorNoBuildableTargetError([
        "no buildable iOS app was found under the build root",
        ` ${projectRoot}.`,
        buildable.length
          ? ` Buildable targets: ${buildable.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ")}.`
          : " Add an application target to a root-level .xcodeproj or apps/*/*.xcodeproj project.",
        installedOnly.length
          ? ` Only previously installed apps are available (${installedOnly.map((candidate) => candidate.name).join(", ")}); launching one would run code that predates your changes.`
          : "",
      ].join(""));
    }
    if (!target) {
      if (!namedATarget) {
        throw new Error("No launchable iOS apps were found. Add a buildable application target to a root-level .xcodeproj or apps/*/*.xcodeproj project, or provide --app-bundle/--bundle-id.");
      }
      const buildable = targets.filter((candidate) => candidate.canBuild);
      throw new Error([
        `No launchable iOS app matched the requested ${launchArgs.bundleId ? `bundle id ${launchArgs.bundleId}` : "target"} under ${projectRoot}.`,
        buildable.length
          ? ` Buildable targets: ${buildable.map((candidate) => `${candidate.name}${candidate.bundleId ? ` (${candidate.bundleId})` : ""}`).join(", ")}.`
          : " No buildable application target exists under this build root.",
        " Refresh launchable iOS apps and try again.",
      ].join(""));
    }

    const projectPath = normalizeProjectPath(projectRoot, target.projectPath);
    const appBundlePath = target.appBundlePath
      ? path.isAbsolute(target.appBundlePath)
        ? target.appBundlePath
        : path.join(projectRoot, target.appBundlePath)
      : explicitAppBundle;
    return {
      target,
      projectPath,
      scheme: target.scheme ?? launchArgs.scheme ?? null,
      bundleId: launchArgs.bundleId ?? target.bundleId,
      appBundlePath,
      shouldBuild: target.kind === "project" && launchArgs.build !== false,
      shouldInstall: target.kind !== "installed",
    };
  };

  const buildProjectApp = async (
    target: ResolvedLaunchTarget,
    device: IosSimulatorDevice,
    projectRoot: string,
    configuration: string,
    /** The caller asked for this configuration, rather than taking Debug. */
    configurationNamed: boolean,
  ): Promise<string | null> => {
    const derivedDataPath = appleLaneDerivedDataPath(projectRoot);
    if (!target.projectPath || !target.scheme) {
      return target.appBundlePath;
    }
    if (target.shouldBuild) {
      const relativeProjectPath = relativeToRoot(projectRoot, target.projectPath);
      await fs.promises.mkdir(derivedDataPath, { recursive: true });
      // A DerivedData copied from another folder (an older project move)
      // names the old paths; drop that package state so the build resolves.
      healMovedDerivedData(derivedDataPath, projectRoot, args.logger);
      args.logger.info("ios_simulator.build.start", {
        projectRoot,
        projectPath: relativeProjectPath,
        scheme: target.scheme,
        configuration,
        deviceUdid: device.udid,
        derivedDataPath,
      });
      try {
        const releaseBuildPath = claimBuildDataPath(derivedDataPath);
        try {
          await run("xcodebuild", [
            "-project",
            relativeProjectPath,
            "-scheme",
            target.scheme,
            "-configuration",
            configuration,
            "-sdk",
            "iphonesimulator",
            "-destination",
            `platform=iOS Simulator,id=${device.udid}`,
            "-derivedDataPath",
            derivedDataPath,
            "build",
          ], { cwd: projectRoot, timeoutMs: 10 * 60_000 });
        } finally {
          releaseBuildPath();
        }
      } catch (error) {
        const formatted = formatXcodeBuildFailure(error, {
          projectPath: relativeProjectPath,
          scheme: target.scheme,
          deviceName: device.name,
        });
        args.logger.warn("ios_simulator.build.failed", {
          projectPath: relativeProjectPath,
          scheme: target.scheme,
          deviceUdid: device.udid,
          error: formatted.message,
        });
        throw formatted;
      }
      args.logger.info("ios_simulator.build.complete", { projectPath: relativeProjectPath, scheme: target.scheme, derivedDataPath });
    }
    // A named configuration's products only: a lane that has built both
    // Debug and Release has two apps with one bundle id, and a configuration
    // that was never built must not quietly install the other one. With none
    // named, Debug's products first, else anything the lane built, as before.
    const productRoot = path.join(derivedDataPath, "Build", "Products", `${configuration}-iphonesimulator`);
    const built = fs.existsSync(productRoot);
    if (configurationNamed && !built) {
      throw new Error(`${configuration} has not been built for this lane. Launch without --no-build to build it, or drop --configuration.`);
    }
    const appBundle = await findAppBundle(built ? productRoot : derivedDataPath, {
      bundleId: target.bundleId,
      scheme: target.scheme,
      // productName lives on the underlying launch target (ResolvedLaunchTarget
      // wraps IosSimulatorLaunchTarget). Prefer it over scheme so a project
      // whose scheme builds multiple .app bundles, or whose scheme name
      // differs from the produced .app, still resolves to the right bundle.
      productName: target.target.productName,
      appBundlePath: target.appBundlePath,
      // Without a build just now, a named configuration's folder may hold
      // only another target's app; never install that under this name.
      matchOnly: configurationNamed && !target.shouldBuild,
    });
    if (!appBundle && configurationNamed && !target.shouldBuild) {
      throw new Error(`${configuration} has no build of ${target.scheme ?? "this target"} for this lane. Launch without --no-build to build it, or drop --configuration.`);
    }
    return appBundle;
  };

  const attachToChatSession = (
    chatSessionId: string | null,
    callerChatSessionId: string | null = chatSessionId,
    options: { takeOver?: boolean; laneId?: string | null } = {},
  ): IosSimulatorSession | null => {
    const runtime = resolveRuntime({
      laneId: options.laneId,
      chatSessionId: callerChatSessionId ?? chatSessionId,
    });
    if (!runtime.activeSession) return null;
    // The caller's own chat id arrives as callerChatSessionId: for attach calls
    // it is the same as the new chatSessionId, for detach calls (chatSessionId
    // === null) it identifies the chat requesting the detach. Detach is covered
    // by the same guard as attach, so an unrelated chat cannot free another
    // chat's simulator binding.
    //
    // Known hole, unchanged from before this lane and deliberately left alone
    // here: the guard requires a non-empty callerChatSessionId, so a caller that
    // passes null for it bypasses the check entirely and can attach or detach
    // any session. Only IPC/CLI callers that already supply their chat id are
    // actually constrained. Closing it belongs with the shutdown/launch
    // ownership rules, not in a comment.
    //
    // takeOver lets a chat adopt a running session in place, skipping the
    // shutdown/rebuild — but only FOR ITSELF. Without the identity check any
    // caller could hand the simulator to a third chat it does not own, which is
    // a full ownership transfer disguised as an attach. So the bypass needs
    // both ids present and equal; it never applies to detach (chatSessionId
    // null). A takeOver naming someone else reaches the owner guard below,
    // which refuses it whenever the caller identified itself.
    const takeOver = options.takeOver === true
      && Boolean(chatSessionId)
      && Boolean(callerChatSessionId)
      && chatSessionId === callerChatSessionId;
    if (
      !takeOver
      && runtime.activeSession.chatSessionId
      && callerChatSessionId
      && runtime.activeSession.chatSessionId !== callerChatSessionId
    ) {
      throw new IosSimulatorOwnedBySessionError(runtime.activeSession);
    }
    if (runtime.activeSession.chatSessionId === chatSessionId) return runtime.activeSession;
    runtime.activeSession = { ...runtime.activeSession, chatSessionId, claimedAt: nowIso() };
    emit({ type: "session-updated", session: runtime.activeSession });
    return runtime.activeSession;
  };

  const claim = async (claimArgs: IosSimulatorClaimArgs = {}): Promise<IosSimulatorStatus> => {
    const laneId = cleanClaimId(claimArgs.laneId);
    const chatSessionId = cleanClaimId(claimArgs.chatSessionId);
    // Resolved by CHAT first, deliberately: claim's whole job is to tag a
    // running session with a lane, and looking the runtime up by the lane the
    // caller is about to set would find an empty one every time.
    const byChat = resolveRuntime({ chatSessionId });
    const runtime = byChat.activeSession || !laneId ? byChat : resolveRuntime({ laneId });
    if (!runtime.activeSession) return getStatus({ laneId, chatSessionId });
    if (!laneId && !chatSessionId) return getStatus({ laneId: runtime.laneId, chatSessionId });
    // The same cooperative single-owner rule `launch` and `shutdown` enforce.
    // Claim overwrites `runtime.activeSession.chatSessionId` outright, so without this
    // it was the cheapest eviction of all: a foreign chat ran
    // `ade ios-sim claim --lane <anything>` (the CLI defaults the chat id to its
    // own $ADE_CHAT_SESSION_ID), became the owner, and a plain `shutdown` was
    // then accepted — no --force, no impersonation.
    //
    // Scoped to an actual ownership change: naming no chat id, or the owner's
    // own, only re-attributes the lane and leaves the owning chat in place, so
    // an agent tagging a running session with its lane is unaffected.
    if (
      runtime.activeSession.chatSessionId
      && chatSessionId
      && chatSessionId !== runtime.activeSession.chatSessionId
      && !claimArgs.force
      && !claimArgs.ignoreOwnership
    ) {
      throw new IosSimulatorOwnedBySessionError(runtime.activeSession);
    }
    const nextLaneId = laneId || runtime.activeSession.laneId;
    // A claim that names a lane MOVES the session into that lane's bucket, so
    // every later lane-scoped call finds it. Without this the session stayed in
    // the un-laned bucket and `status --lane X` reported nothing while the very
    // session it claimed was running.
    const rekeyed = laneId && laneKey(laneId) !== runtime.key ? retargetRuntime(runtime, laneId) : runtime;
    const nextChatSessionId = chatSessionId || runtime.activeSession.chatSessionId;
    const changed = nextLaneId !== runtime.activeSession.laneId
      || nextChatSessionId !== runtime.activeSession.chatSessionId;
    rekeyed.activeSession = {
      ...runtime.activeSession,
      laneId: nextLaneId,
      chatSessionId: nextChatSessionId,
      claimedAt: changed ? nowIso() : runtime.activeSession.claimedAt,
    };
    invalidateStatus(rekeyed);
    emit({ type: "session-updated", session: rekeyed.activeSession });
    return getStatus({ laneId: rekeyed.laneId, chatSessionId: nextChatSessionId });
  };

  const launch = async (launchArgs: IosSimulatorLaunchArgs = {}): Promise<IosSimulatorLaunchResult> => {
    assertDarwin();
    const runtime = resolveRuntime(launchArgs);
    if (!cachedCommandExists("xcrun") || !cachedCommandExists("xcodebuild")) {
      throw new Error("Xcode command line tools are required for iOS Simulator control. Install Xcode and run xcode-select --install.");
    }
    // Two overlapping launches share one DerivedData directory and the last one
    // to finish wins `runtime.activeSession`, so the caller is told about an app the
    // other launch installed. Reject the second launch instead.
    if (runtime.activeLaunchId) throw new IosSimulatorLaunchInProgressError(runtime.activeLaunchId);
    if (laneAppInstalls.has(runtime.key)) {
      throw new AdeExpectedError(
        `${APPLE_BUILD_BUSY_CODE}: an \`ade apple install\` is building in this lane's DerivedData. Wait for it, then launch again.`,
        "user",
      );
    }
    // The caller's own inputs, refused before a boot or a build costs anything.
    const buildConfiguration = normalizeBuildConfiguration(launchArgs.configuration);
    const launchArguments = normalizeLaunchArguments(launchArgs.arguments);
    const incomingChatSessionId = launchArgs.chatSessionId ?? null;
    // A launch that names no chat session may not evict one that does: an
    // agent's anonymous CLI launch would otherwise silently take the simulator
    // away from the chat the user is watching.
    if (
      runtime.activeSession
      && runtime.activeSession.chatSessionId
      && runtime.activeSession.chatSessionId !== incomingChatSessionId
      && !launchArgs.force
    ) {
      throw new IosSimulatorOwnedBySessionError(runtime.activeSession);
    }
    const needsForceTakeover = Boolean(
      runtime.activeSession
      && launchArgs.force
      && (!incomingChatSessionId || runtime.activeSession.chatSessionId !== incomingChatSessionId),
    );
    const launchId = randomUUID();
    runtime.activeLaunchId = launchId;
    // Stamped before the first step emits, so every event this launch produces
    // carries its owner and other drawers can drop it.
    launchOwners.set(launchId, {
      chatSessionId: incomingChatSessionId,
      laneId: launchArgs.laneId?.trim() || null,
    });
    let currentStep: IosSimulatorLaunchStepId = "resolve-device";
    try {
      const projectRoot = await resolveScopedRoot(launchArgs);
      // Validate before evicting: a force launch that cannot find its device or
      // target must not leave the user with no simulator session at all.
      let preflightDevice: IosSimulatorDevice | null = null;
      let preflightTarget: ResolvedLaunchTarget | null = null;
      if (needsForceTakeover) {
        preflightDevice = await resolveDevice(launchArgs.deviceUdid);
        try {
          preflightTarget = await resolveLaunchTarget(launchArgs, preflightDevice.udid, projectRoot);
        } catch (error) {
          // Installed targets come from `simctl listapps`, which needs a booted
          // device — so on a cold device the only preflight verdict available is
          // "nothing buildable", which is exactly the case that can flip once the
          // boot below finishes. Defer to the post-boot resolution rather than
          // refusing a launch that would have worked. Any other failure, and any
          // failure on an already-booted device, is real: rethrow it before the
          // takeover evicts the running session.
          const deferrable = error instanceof IosSimulatorNoBuildableTargetError
            && preflightDevice.state !== "Booted";
          if (!deferrable) throw error;
          args.logger.debug("ios_simulator.force_launch_preflight_target_deferred", {
            deviceUdid: preflightDevice.udid,
            deviceState: preflightDevice.state,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await shutdown({ force: true }).catch((error) => {
          args.logger.warn("ios_simulator.shutdown_during_force_launch_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        // That shutdown releases the launch lock (its whole point as an escape
        // hatch), but this launch is the one holding it and is still running —
        // so it takes the lock straight back. Without this the supersede guard
        // below sees a cleared id and rejects the very launch that asked for
        // the takeover. Reclaim only if the lock is still free: the shutdown
        // await is a window in which another launch can pass the entry guard
        // and claim it, and clobbering that id would let two launches race for
        // one DerivedData directory — exactly what the entry guard prevents.
        if (disposed) {
          throw new Error("iOS simulator service has been disposed.");
        }
        if (runtime.activeLaunchId !== null && runtime.activeLaunchId !== launchId) {
          throw new Error("This iOS simulator launch was superseded before it finished.");
        }
        runtime.activeLaunchId = launchId;
      }
      emitLaunchProgress(launchId, "resolve-device", "running", "Finding installed simulator device...");
      const device = preflightDevice ?? await resolveDevice(launchArgs.deviceUdid);
      /*
       * Ownership belongs to the DEVICE, not to a lane's bucket.
       *
       * The guard at the top of this function reads `runtime.activeSession`,
       * and a runtime is per lane. So a launch that merely NAMED a different
       * lane landed in an empty bucket, found no owner, and went on to drive
       * the very simulator another chat was holding — the app's pid changed
       * under it. A test agent found this by trying it; the refusal it got for
       * `shutdown` and `claim` never fired for `launch`.
       *
       * Checked here rather than at the top because this is the first point
       * where the target device is known, and still before anything boots,
       * builds or installs.
       */
      if (!launchArgs.force) {
        const deviceOwner = findActiveSessionForDevice(device.udid, runtime);
        if (deviceOwner && deviceOwner.chatSessionId && deviceOwner.chatSessionId !== incomingChatSessionId) {
          throw new IosSimulatorOwnedBySessionError(deviceOwner);
        }
      }
      emitLaunchProgress(launchId, "resolve-device", "complete", `${device.name} selected.`, device.runtime, { deviceUdid: device.udid });

      currentStep = "boot-simulator";
      if (device.state === "Booted") {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Checking simulator readiness...", device.name, { deviceUdid: device.udid });
      } else {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Booting simulator...", device.name, { deviceUdid: device.udid });
      }
      await power.bootDevice(device);
      emitLaunchProgress(launchId, "boot-simulator", "complete", "Simulator services are ready.", device.name, { deviceUdid: device.udid });

      currentStep = "open-simulator";
      const openSimulatorInForeground = shouldOpenSimulatorAppForLaunch(launchArgs.keepSimulatorInBackground);
      if (openSimulatorInForeground) {
        emitLaunchProgress(launchId, "open-simulator", "running", "Opening Simulator.app...", null, { deviceUdid: device.udid });
        spawnProcess("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" }).unref();
        emitLaunchProgress(launchId, "open-simulator", "complete", "Simulator.app is visible.", null, { deviceUdid: device.udid });
      } else {
        emitLaunchProgress(launchId, "open-simulator", "skipped", "Simulator.app was left in the background by request.", null, { deviceUdid: device.udid });
      }

      currentStep = "resolve-target";
      emitLaunchProgress(launchId, "resolve-target", "running", "Resolving launchable app...", null, { deviceUdid: device.udid });
      const target = preflightTarget ?? await resolveLaunchTarget(launchArgs, device.udid, projectRoot);
      emitLaunchProgress(launchId, "resolve-target", "complete", `${target.target.name} selected.`, target.target.detail, { deviceUdid: device.udid, targetId: target.target.id });

      currentStep = "build-app";
      // Nothing is compiled on this path, so the app that runs can be older
      // than the caller's edits. Say so instead of reporting a clean build.
      const usedInstalledBinary = !target.shouldBuild;
      const staleBinaryDetail = "previously installed build — current code changes are not included";
      // buildRoot rides every build-app step as data. The stepper UI used to
      // recover it by regexing "root <tail>" back out of this detail string,
      // which broke the moment the copy changed.
      const buildStepExtra = { deviceUdid: device.udid, targetId: target.target.id, buildRoot: projectRoot };
      if (target.shouldBuild) {
        emitLaunchProgress(launchId, "build-app", "running", `Building iOS app in ${abbreviatePathTail(projectRoot)}...`, target.target.detail, buildStepExtra);
      } else {
        emitLaunchProgress(launchId, "build-app", "skipped", "Build skipped.", staleBinaryDetail, buildStepExtra);
      }
      const appBundle = target.shouldBuild || target.shouldInstall
        ? await buildProjectApp(target, device, projectRoot, buildConfiguration, Boolean(launchArgs.configuration?.trim()))
        : target.appBundlePath;
      emitLaunchProgress(
        launchId,
        "build-app",
        target.shouldBuild ? "complete" : "skipped",
        target.shouldBuild ? `${buildConfiguration} build complete.` : "Using a previously built app.",
        target.shouldBuild
          ? [relativeToRoot(projectRoot, appBundle ?? projectRoot), `root ${abbreviatePathTail(projectRoot)}`].join(" · ")
          : staleBinaryDetail,
        buildStepExtra,
      );

      const bundleId = target.bundleId
        ?? (appBundle ? await readPlistValue(path.join(appBundle, "Info.plist"), "CFBundleIdentifier") : null);
      if (!bundleId) {
        throw new Error(`Could not determine the bundle identifier for ${target.target.name}. Select a built app bundle or pass --bundle-id.`);
      }
      currentStep = "install-app";
      if (target.shouldInstall) {
        emitLaunchProgress(launchId, "install-app", "running", "Installing app on simulator...", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
        if (!appBundle) {
          throw new Error(`Could not find ${target.target.name}.app after building. Try launching with build=true from the project root.`);
        }
        // On an attached device this app is ADE's to remove when the lane ends,
        // unless the user already had it.
        await installTracked(device.udid, bundleId, () => installAppOnSimulator(device, appBundle));
        emitLaunchProgress(launchId, "install-app", "complete", "App installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      } else {
        emitLaunchProgress(launchId, "install-app", "skipped", "App already installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      }

      const launchEnvironment = normalizeLaunchEnvironment(launchArgs.environment);
      const startedAt = nowIso();
      const session: IosSimulatorSession = {
        id: randomUUID(),
        deviceUdid: device.udid,
        deviceName: device.name,
        bundleId,
        appName: target.target.name,
        appBundlePath: appBundle,
        targetId: target.target.id,
        projectRoot,
        laneId: launchArgs.laneId ?? null,
        chatSessionId: launchArgs.chatSessionId ?? null,
        mode: normalizeLaunchMode(launchArgs.mode),
        keepSimulatorInBackground: launchArgs.keepSimulatorInBackground ?? false,
        bridgeUrl: null,
        startedAt,
        claimedAt: launchArgs.laneId || launchArgs.chatSessionId ? startedAt : null,
        // Carried on the session, not just the launch result, so a later
        // `getStatus()` or a `session-started` subscriber can still say which
        // tree is running and whether it was actually compiled. Only the direct
        // caller of `launch` ever saw those two facts before.
        buildRoot: projectRoot,
        usedInstalledBinary,
        buildConfiguration: target.shouldBuild ? buildConfiguration : null,
      };
      // A launch that was superseded (force takeover, dispose) must not publish
      // its session over the newer one.
      if (runtime.activeLaunchId !== launchId) {
        throw new Error("This iOS simulator launch was superseded before it finished.");
      }
      runtime.activeSession = session;
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(launchEnvironment).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]),
        ),
        ...(bundleId === ADE_IOS_BUNDLE_ID
          ? {
            SIMCTL_CHILD_ADE_INSPECTOR_SESSION_ID: session.id,
            SIMCTL_CHILD_ADE_INSPECTOR_MODE: session.mode,
          }
          : {}),
      };
      const simctlLaunchArgs = ["simctl", "launch", "--terminate-running-process", device.udid, bundleId];
      if (bundleId === ADE_IOS_BUNDLE_ID) {
        simctlLaunchArgs.push("--ade-inspector-mode", session.mode);
      }
      simctlLaunchArgs.push(...launchArguments);
      currentStep = "launch-app";
      emitLaunchProgress(launchId, "launch-app", "running", "Launching app...", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      await run("xcrun", simctlLaunchArgs, {
        env: childEnv,
        timeoutMs: 60_000,
      });
      emitLaunchProgress(launchId, "launch-app", "complete", "App launched.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      emitLaunchProgress(launchId, "ready", "complete", "iOS simulator drawer is ready.", device.name, { deviceUdid: device.udid, targetId: target.target.id });
      emit({ type: "session-started", session });
      // Opt-in only, and only after the session publishes: an agent launch must
      // not steal the user's screen, and a drawer opened before `session-started`
      // lands would render an empty pane.
      if (launchArgs.openDrawer === true) {
        requestDrawerOpen("launch", "interact", {
          chatSessionId: launchArgs.chatSessionId ?? session.chatSessionId,
          laneId: launchArgs.laneId ?? session.laneId,
        });
      }
      return {
        ...session,
        buildRoot: projectRoot,
        usedInstalledBinary,
        capabilities: currentCapabilities(),
      };
    } catch (error) {
      emitLaunchProgress(
        launchId,
        currentStep,
        "failed",
        error instanceof Error ? error.message : String(error),
        null,
      );
      if (runtime.activeSession && runtime.activeLaunchId === launchId) {
        runtime.activeSession = null;
        emit({ type: "session-updated", session: null });
      }
      throw error;
    } finally {
      if (runtime.activeLaunchId === launchId) runtime.activeLaunchId = null;
      // After the catch above has emitted this launch's last (failed) step.
      launchOwners.delete(launchId);
    }
  };

  const pruneScreenshotCache = async (directory: string): Promise<void> => {
    try {
      const entries = (await fs.promises.readdir(directory))
        .filter((name) => name.startsWith("shot-") && name.endsWith(".png"))
        .sort();
      const stale = entries.slice(0, Math.max(0, entries.length - SCREENSHOT_KEEP_COUNT));
      await Promise.all(stale.map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => {})));
    } catch {
      // Pruning is best effort; a full cache never blocks a capture.
    }
  };

  /**
   * The capture itself, against a scope its caller has already resolved.
   *
   * A snapshot-driven call (inspect, select) resolves the lane ladder once and
   * hands the result down, so one filesystem-backed resolution serves the whole
   * request instead of each layer re-deriving — and re-deciding — the same root.
   */
  // The scope fields are omitted so a fresh literal cannot smuggle a scope past
  // the resolved root. Omit is structural, so an existing args object still
  // type-checks here; the root always arrives out of band from the caller.
  const captureScreenshot = async (
    arg: Omit<IosSimulatorScreenshotArgs, "projectRoot" | "laneId">,
    root: string,
    runtime: LaneRuntime,
  ): Promise<IosSimulatorScreenshot> => {
    const device = await resolveDevice(arg.deviceUdid ?? runtime.activeSession?.deviceUdid, runtime);
    const requestedOutPath = arg.outPath?.trim();
    // Agents need a file they can read; the data URL alone forces them to
    // shuttle megabytes of base64 through the transcript.
    const cacheDirectory = path.join(root, ...SCREENSHOT_CACHE_SEGMENTS);
    const filePath = requestedOutPath
      ? path.resolve(root, requestedOutPath)
      : path.join(cacheDirectory, `shot-${nowIso().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`);
    // `outPath` reaches here from an agent's tool call and from `ade ios-sim
    // screenshot --out`, so an absolute path or a `../..` tail would otherwise
    // let a capture write anywhere the ADE process can — over a source file, a
    // dotfile, or another lane's worktree. Containment is checked after
    // resolution so both spellings are caught by one test.
    if (!isPathInside(filePath, root)) {
      throw new IosSimulatorOutPathOutsideRootError(filePath, root);
    }
    // The lexical check above cannot see a symlink: every segment can sit under
    // the root while the link resolves outside it and the PNG lands there. The
    // real-path check runs only when the root is on disk, because a root that
    // does not exist holds no link to escape through.
    if (fs.existsSync(root)) {
      try {
        resolvePathWithinRoot(root, filePath, { allowMissing: true });
      } catch (error) {
        // Only a containment failure is a containment failure. The resolver
        // also throws for a dangling symlink, a permission error and a link
        // loop, and reporting those as "outside the build root" tells the
        // caller to fix a path that was never the problem.
        if (isPathEscapeError(error)) throw new IosSimulatorOutPathOutsideRootError(filePath, root);
        throw error;
      }
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // `simctl io` hands the write to CoreSimulatorService, which cannot raise
    // macOS's external-drive prompt: on a project moved to another drive it
    // fails with "Operation not permitted". It captures into the internal
    // temp folder, and ADE (which holds the drive permission) writes the file.
    const capturePath = path.join(os.tmpdir(), `ade-sim-shot-${randomUUID().slice(0, 8)}.png`);
    let buffer: Buffer;
    try {
      const display = await duo.screenshotDisplayArgs(device.udid);
      await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", ...display, capturePath], { timeoutMs: SIMCTL_SCREENSHOT_TIMEOUT_MS })
        .catch((error: unknown) => { throw simctlScreenshotFailure(error, device.name, SIMCTL_SCREENSHOT_TIMEOUT_MS); });
      buffer = await fs.promises.readFile(capturePath);
    } finally {
      await fs.promises.rm(capturePath, { force: true }).catch(() => {});
    }
    // Never through a link swapped in during the capture: ADE holds the
    // external-drive permission, so a followed link could land anywhere. The
    // folder is checked again and the file itself is opened without
    // following a link.
    try {
      resolvePathWithinRoot(root, filePath, { allowMissing: true });
    } catch (error) {
      if (isPathEscapeError(error)) throw new IosSimulatorOutPathOutsideRootError(filePath, root);
      throw error;
    }
    const handle = await fs.promises.open(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    const dimensions = pngDimensions(buffer) ?? { width: null, height: null };
    if (!requestedOutPath) void pruneScreenshotCache(cacheDirectory);
    return {
      deviceUdid: device.udid,
      dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
      filePath,
      width: dimensions.width,
      height: dimensions.height,
      capturedAt: nowIso(),
    };
  };

  /** The lane device's name for a udid, for captions. Falls back to the udid. */
  const deviceLabelForUdid = (udid: string): string => {
    for (const runtime of runtimes.values()) {
      const device = laneDevices.get(runtime.key);
      if (device?.udid === udid) return device.name;
    }
    return udid.slice(0, 8);
  };

  /**
   * File a captured still in the proof drawer, and never fail the capture.
   *
   * Round 5 §S3: a recording has filed itself since round 3, but a screenshot
   * had to be promoted by a second command — `ade apple proof`, which wraps
   * `screenshot` in an `ingest_computer_use_artifacts` step. Agents took the
   * still and skipped the promotion, and the rail's Screenshot button never
   * promoted anything at all: it wrote a PNG into a cache directory under the
   * build root and told nobody. A screenshot nobody can see is not evidence.
   *
   * Returns the artifact id or null. Null is not an error the caller should
   * hear about: the PNG on disk is the result that was asked for, and a drawer
   * that refused the row must not turn a good capture into a thrown call.
   */
  /** The chat a capture is filed to: the caller's, else the chat that claimed the device. */
  const proofOwnerChatId = (arg: Pick<IosSimulatorScreenshotArgs, "chatSessionId">, runtime: LaneRuntime): string | null =>
    arg.chatSessionId?.trim() || runtime.activeSession?.chatSessionId || null;

  const fileScreenshotAsProof = (
    shot: Pick<IosSimulatorScreenshot, "deviceUdid" | "filePath" | "capturedAt" | "width" | "height">,
    arg: IosSimulatorScreenshotArgs,
    runtime: LaneRuntime,
    /** A 3D render of the device rather than a capture of its screen. */
    render?: { kind: "screenshot" | "video_recording"; mimeType: string },
  ): string | null => {
    const filer = args.recordingDeps?.artifactFiler;
    if (!filer) return null;
    const chatSessionId = proofOwnerChatId(arg, runtime);
    const caption = arg.caption?.trim()
      || `Simulator screenshot · ${deviceLabelForUdid(shot.deviceUdid)}`;
    /*
     * Own it by LANE as well as by chat, and by the lane alone when no chat
     * drove the capture.
     *
     * The broker links an artifact to its owners and derives the lane from
     * them. With a chat owner only, a capture taken by the CLI — where there is
     * no chat session — arrived with an EMPTY owner list, so it belonged to
     * nobody: `ade proof list` returned it under no scope, project-wide
     * included, while `screenshot` still handed back a real artifact id. It
     * looked filed and was unreachable. `ade proof attach` never had the bug
     * because it claims both owners.
     */
    const owners: Array<{ kind: "chat_session" | "lane"; id: string }> = [
      ...(chatSessionId ? [{ kind: "chat_session" as const, id: chatSessionId }] : []),
      ...(runtime.key ? [{ kind: "lane" as const, id: runtime.key }] : []),
    ];
    try {
      const result = filer.ingest({
        backend: { name: "apple-device", style: "local_fallback", toolName: render ? "apple_render" : "apple_screenshot" },
        ...(owners.length ? { owners } : {}),
        ...(args.projectRoot ? { callerRoot: args.projectRoot } : {}),
        provenance: { source: "ade-capture" },
        inputs: [
          {
            kind: render?.kind ?? "screenshot",
            title: caption,
            description: render
              ? `3D render of the lane's Apple device at ${shot.capturedAt}.`
              : `Screen of the lane's Apple device at ${shot.capturedAt}.`,
            path: shot.filePath,
            mimeType: render?.mimeType ?? "image/png",
            metadata: {
              laneId: runtime.key || null,
              udid: shot.deviceUdid,
              width: shot.width,
              height: shot.height,
              capturedAt: shot.capturedAt,
            },
          },
        ],
      });
      return readArtifactId(result);
    } catch (error) {
      args.logger.debug("apple.screenshot_proof_file_failed", {
        udid: shot.deviceUdid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const screenshot = async (arg: IosSimulatorScreenshotArgs = {}): Promise<IosSimulatorScreenshot> => {
    assertDarwin();
    const runtime = resolveRuntime(arg);
    const shot = await captureScreenshot(
      arg,
      await resolveScopedRootForSession({ projectRoot: arg.projectRoot, laneId: arg.laneId }, runtime),
      runtime,
    );
    // Default ON. `proof: false` is for the internal callers that already
    // produce their own artifact — the proof bundle's `screen.png` and the
    // inspector hit-test still — which would otherwise file a second, duplicate
    // row for the same pixels.
    if (arg.proof === false) return shot;
    return { ...shot, proofArtifactId: fileScreenshotAsProof(shot, arg, runtime) };
  };

  const getAppContainerPath = async (
    deviceUdid: string | null | undefined,
    runtime: LaneRuntime,
  ): Promise<{ device: IosSimulatorDevice; containerPath: string }> => {
    const session = runtime.activeSession;
    if (!session) {
      throw new Error("Launch an iOS app before reading inspector context.");
    }
    const device = await resolveDevice(deviceUdid ?? session.deviceUdid, runtime);
    const { stdout } = await run("xcrun", ["simctl", "get_app_container", device.udid, session.bundleId, "data"], { timeoutMs: 20_000 });
    const containerPath = stdout.trim();
    if (!containerPath) {
      throw new Error(`${session.appName ?? session.bundleId} data container was not found. Launch the app in the simulator first.`);
    }
    return { device, containerPath };
  };

  const readInspectorSnapshot = async (arg: { deviceUdid?: string | null; laneId?: string | null; chatSessionId?: string | null } = {}): Promise<IosInspectorSnapshot | null> => {
    // Exposed straight over IPC as `getInspectorSnapshot`, and it was the one
    // reachable method without this guard: off darwin it reported "Launch an
    // iOS app before reading inspector context" instead of the truth.
    assertDarwin();
    const { device, containerPath } = await getAppContainerPath(arg.deviceUdid, resolveRuntime(arg));
    const snapshotPath = path.join(containerPath, ADE_IOS_INSPECTOR_SNAPSHOT_PATH);
    let data: string;
    try {
      data = await fs.promises.readFile(snapshotPath, "utf8");
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return null;
      throw error;
    }
    const raw = JSON.parse(data) as RawIosInspectorSnapshot;
    const scale = Number(raw.screen?.scale);
    const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const elements: IosInspectableElement[] = [];
    for (const rawElement of raw.elements ?? []) {
      const frame = normalizeFrame(rawElement.frame);
      if (!rawElement.id || !rawElement.componentId || !frame) continue;
      const pixelFrame = normalizeFrame(rawElement.pixelFrame) ?? {
        x: frame.x * normalizedScale,
        y: frame.y * normalizedScale,
        width: frame.width * normalizedScale,
        height: frame.height * normalizedScale,
      };
      elements.push({
        id: rawElement.id,
        componentId: rawElement.componentId,
        sourceFile: rawElement.sourceFile ?? null,
        sourceLine: rawElement.sourceLine ?? null,
        frame,
        pixelFrame,
        metadata: rawElement.metadata ?? {},
        accessibilityIdentifier: rawElement.accessibilityIdentifier ?? rawElement.componentId,
      });
    }
    return {
      deviceUdid: device.udid,
      appContainerPath: containerPath,
      generatedAt: raw.generatedAt ?? nowIso(),
      screen: {
        width: Number(raw.screen?.width) || 0,
        height: Number(raw.screen?.height) || 0,
        scale: normalizedScale,
      },
      elements,
    };
  };

  /**
   * The device's accessibility tree, straight from the helper.
   *
   * The helper returns exactly the JSON `idb ui describe-all --nested` used to
   * return — a flat one-element array whose root carries `frame`, `type`,
   * `AXLabel`, `AXValue`, `AXUniqueId` and `children` — which is why
   * `collectAccessibilityElements` below is untouched and why `snapshot`,
   * `tap-element`, `fill-element`, `wait-for-element`, `assert-visible` and
   * `select` all keep working across the engine swap.
   *
   * The frames are in DEVICE POINTS, as they were from idb. Everything
   * downstream (`scaleAccessibilityElementsToScreenshot`) finds the scale, so
   * nothing here converts.
   */
  const readAccessibilityElements = async (deviceUdid: string): Promise<{
    elements: IosScreenElement[];
    /** The helper's walk stopped at a cap (`truncatedBy` names which), so elements may be missing. */
    truncatedBy: string[] | null;
    /** The helper's caps (`elements`, `depth`, `probe-points`), when it reports them. */
    limits: Record<string, number> | null;
    /** An iPadOS window could not be placed on the screen; its elements say `ADEUnplaced`. */
    unplaced: boolean;
  }> => {
    const payload = await helper().send({ type: "ax-describe", udid: deviceUdid });
    const tree = payload.tree;
    if (typeof tree !== "string" || !tree.trim()) {
      throw new Error("The simulator helper returned no accessibility tree. Is an app in the foreground?");
    }
    const truncatedBy = payload.truncated === true
      ? (Array.isArray(payload.truncatedBy) ? payload.truncatedBy.filter((entry): entry is string => typeof entry === "string") : [])
      : null;
    const limits = payload.limits && typeof payload.limits === "object" && !Array.isArray(payload.limits)
      ? Object.fromEntries(Object.entries(payload.limits).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
      : null;
    return { elements: collectAccessibilityElements(JSON.parse(tree) as unknown), truncatedBy, limits, unplaced: payload.unplaced === true };
  };

  /**
   * The element under one point and its children, in device points, with no
   * tree walk and no grid probe: how `fill-element` reads a field back after
   * typing. Null when nothing answers there, or when this helper predates the
   * point read (then the caller reports "unknown" rather than pay for a full
   * snapshot).
   */
  const readAccessibilityElementAt = async (deviceUdid: string, x: number, y: number): Promise<IosScreenElement[] | null> => {
    const payload = await helper().send({ type: "ax-hit", udid: deviceUdid, x, y }).catch((error: unknown) => {
      if (error instanceof SimHelperError && error.code === "unknown-command") return null;
      throw error;
    });
    if (!payload || payload.hit !== true || typeof payload.tree !== "string" || !payload.tree.trim()) return null;
    return collectAccessibilityElements(JSON.parse(payload.tree) as unknown);
  };

  /**
   * The element with keyboard focus in the front app: `null` when none has
   * it, `undefined` when that cannot be told (an older helper, a runtime whose
   * accessibility does not answer, a read that failed).
   */
  const readFocusedElement = async (deviceUdid: string): Promise<IosScreenElement | null | undefined> => {
    const payload = await helper().send({ type: "ax-focused", udid: deviceUdid }).catch(() => null);
    if (!payload || payload.supported !== true) return undefined;
    if (!isRecord(payload.element)) return null;
    return collectAccessibilityElements([payload.element])[0] ?? null;
  };

  /**
   * The snapshot itself, against a scope its caller has already resolved.
   *
   * `projectRoot` here is both where the capture is written and the tree the
   * synthetic-element and source matchers read, so it must be the same root the
   * caller resolved — resolving again per layer is how a lane-scoped inspect
   * ended up matching the primary checkout's sources.
   */
  // Scope fields omitted for the same reason as captureScreenshot: the caller
  // resolved the root and passes it in.
  const captureScreenSnapshot = async (
    snapshotArgs: Omit<IosScreenSnapshotArgs, "projectRoot" | "laneId">,
    projectRoot: string,
    runtime: LaneRuntime,
  ): Promise<IosScreenSnapshot> => {
    const hitX = snapshotArgs.x == null ? null : normalizeCoordinate(snapshotArgs.x, "x");
    const hitY = snapshotArgs.y == null ? null : normalizeCoordinate(snapshotArgs.y, "y");
    const shot = await captureScreenshot(
      { deviceUdid: snapshotArgs.deviceUdid ?? runtime.activeSession?.deviceUdid },
      projectRoot,
      runtime,
    );
    const providers: IosScreenSnapshot["providers"] = [
      {
        source: "screenshot",
        available: true,
        generatedAt: shot.capturedAt,
      },
    ];

    let inspectorSnapshot: IosInspectorSnapshot | null = null;
    let inspectorElements: IosScreenElement[] = [];
    try {
      inspectorSnapshot = await readInspectorSnapshot({ deviceUdid: shot.deviceUdid, laneId: runtime.laneId });
      inspectorElements = (inspectorSnapshot?.elements ?? []).map(inspectorElementToScreenElement);
      providers.push({
        source: "ade-inspector",
        available: Boolean(inspectorSnapshot),
        elementCount: inspectorElements.length,
        generatedAt: inspectorSnapshot?.generatedAt ?? null,
        error: inspectorSnapshot ? null : "No ADEInspector snapshot has been published by the active app.",
      });
    } catch (error) {
      providers.push({
        source: "ade-inspector",
        available: false,
        elementCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let accessibilityElements: IosScreenElement[] = [];
    let accessibilityScreen: IosInspectableScreen | null = null;
    try {
      const accessibilityRead = await readAccessibilityElements(shot.deviceUdid);
      const rawAccessibilityElements = accessibilityRead.elements;
      // The live stream knows the point size of the screen on show; with no
      // stream the device type's profile gives the scale.
      const transport = shot.deviceUdid ? runtimeStreamingUdid(shot.deviceUdid)?.streamStatus.transport ?? null : null;
      const pointSize = transport?.pointWidth && transport.pointHeight
        ? { width: transport.pointWidth, height: transport.pointHeight }
        : null;
      const scaledAccessibility = scaleAccessibilityElementsToScreenshot(
        rawAccessibilityElements,
        shot,
        pointSize,
        // Also with a stream running: held landscape, its point size can still
        // be the portrait one, which no landscape shot agrees with, and then
        // the device type's scale must win over the element-frame guess.
        shot.deviceUdid ? await deviceScreenScale(shot.deviceUdid) : null,
      );
      accessibilityElements = scaledAccessibility.elements;
      accessibilityScreen = scaledAccessibility.screen;
      providers.push({
        source: "accessibility",
        available: true,
        elementCount: accessibilityElements.length,
        ...(accessibilityRead.truncatedBy
          ? {
            truncated: true,
            truncatedBy: accessibilityRead.truncatedBy,
            ...(accessibilityRead.limits ? { limits: accessibilityRead.limits } : {}),
          }
          : {}),
        ...(accessibilityRead.unplaced ? { unplaced: true } : {}),
      });
    } catch (error) {
      providers.push({
        source: "accessibility",
        available: false,
        elementCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const elements = applySwiftUITabBarSource(projectRoot, mergeScreenElements(inspectorElements, accessibilityElements));
    // The app's inspector names the screen only when it described this one: a
    // snapshot it published before a turn or a fold (the iPhone Duo's inner
    // display held upright read 669x835 against a 669x951 picture) is stale.
    const inspectorScreen = inspectorSnapshot?.screen;
    const inspectorScreenIsCurrent = Boolean(
      inspectorScreen
      && inspectorElements.length
      && (!shot.width || !shot.height
        || (Math.abs(inspectorScreen.width * inspectorScreen.scale - shot.width) <= 2
          && Math.abs(inspectorScreen.height * inspectorScreen.scale - shot.height) <= 2)),
    );
    const screen = (inspectorScreenIsCurrent ? inspectorScreen : null) ?? {
      width: accessibilityScreen?.width ?? shot.width ?? 0,
      height: accessibilityScreen?.height ?? shot.height ?? 0,
      scale: accessibilityScreen?.scale ?? 1,
    };
    const hitElement = hitX == null || hitY == null
      ? null
      : findSmallestScreenElementAt(elements, hitX, hitY);
    return {
      deviceUdid: shot.deviceUdid,
      capturedAt: shot.capturedAt,
      screenshot: shot,
      screen,
      elements,
      hitElement,
      providers,
      inspectorSnapshot,
    };
  };

  /**
   * Resolves the scope once for the whole snapshot — capture, synthetic
   * elements, and source matching all read the same tree.
   *
   * Resolution failures are failures, never a quiet fallback: a named lane that
   * cannot be resolved and an explicit `projectRoot` that does not exist both
   * throw here. Degrading to the service's own root would hand an agent a
   * snapshot of the primary checkout while it believed it was looking at the
   * tree it named.
   */
  const getScreenSnapshot = async (snapshotArgs: IosScreenSnapshotArgs = {}): Promise<IosScreenSnapshot> => {
    assertDarwin();
    const runtime = resolveRuntime(snapshotArgs);
    const snapshot = await captureScreenSnapshot(
      snapshotArgs,
      await resolveScopedRootForSession({
        projectRoot: snapshotArgs.projectRoot,
        laneId: snapshotArgs.laneId,
      }, runtime),
      runtime,
    );
    // Each element carries the ref `tap-element --ref` matches, so a caller
    // never has to pass the tree-position `id`, which moves with the layout.
    return { ...snapshot, elements: snapshot.elements.map((element) => ({ ...element, ref: buildElementRef(element) })) };
  };

  /**
   * `resolvedProjectRoot` is the tree to match source against, already run
   * through the lane ladder by the caller. It is not a raw caller-supplied
   * projectRoot: the old `?? runtime.activeSession?.projectRoot ?? args.projectRoot`
   * tail never resolved lanes, so a lane-scoped inspect matched the primary
   * checkout's sources against the lane's running app.
   */
  const contextItemFromScreenElement = (
    element: IosScreenElement,
    snapshot: IosScreenSnapshot,
    runtime: LaneRuntime,
    screenshotDataUrl?: string | null,
    resolvedProjectRoot?: string | null,
  ): IosElementContextItem => {
    const projectRoot = resolvedProjectRoot ?? null;
    const inspectedSnippet = projectRoot
      ? readSourceSnippet(projectRoot, element.sourceFile, element.sourceLine)
      : null;
    const sourceMatches = element.sourceFile && element.sourceLine
      ? [{
          sourceFile: element.sourceFile,
          sourceLine: element.sourceLine,
          confidence: "exact" as const,
          reason: "ADEInspector source metadata",
          snippet: inspectedSnippet,
        }]
      : findSourceMatchesForElement(projectRoot, element);
    const bestExactMatch = sourceMatches.find(isTrustedSourceMatch) ?? null;
    const bestCandidateMatch = sourceMatches.find((match) => match.confidence === "candidate") ?? null;
    const sourceFile = element.sourceFile ?? bestExactMatch?.sourceFile ?? null;
    const sourceLine = element.sourceLine ?? bestExactMatch?.sourceLine ?? null;
    const sourceSnippet = projectRoot
      ? readSourceSnippet(projectRoot, sourceFile, sourceLine)
      : bestExactMatch?.snippet ?? null;
    let sourceConfidence: "exact" | "candidate" | "none";
    if (sourceFile) {
      sourceConfidence = "exact";
    } else if (bestCandidateMatch) {
      sourceConfidence = "candidate";
    } else {
      sourceConfidence = "none";
    }
    let sourceResolution: string;
    if (element.sourceFile) {
      sourceResolution = "ade-inspector";
    } else if (bestExactMatch) {
      sourceResolution = "swift-exact-search";
    } else if (bestCandidateMatch) {
      sourceResolution = "swift-candidate-search";
    } else {
      sourceResolution = "none";
    }
    return {
      kind: "ios_element",
      id: randomUUID(),
      componentId: element.componentId ?? element.label ?? element.role ?? "Simulator element",
      sourceFile,
      sourceLine,
      frame: element.pixelFrame,
      metadata: {
        ...element.metadata,
        iosInspectPacketVersion: 1,
        screenElementId: element.id,
        screenElementSource: element.source,
        sourceResolution,
        sourceConfidence,
        sourceMatches,
        sourceCandidates: sourceMatches,
        screenSnapshotCapturedAt: snapshot.capturedAt,
        screen: screenPacket(snapshot),
        selectedElement: compactScreenElement(element),
        nearbyElements: nearbyScreenElements(snapshot, element),
        deviceUdid: snapshot.deviceUdid,
        chatSessionId: runtime.activeSession?.chatSessionId ?? null,
        label: element.label,
        value: element.value,
        role: element.role,
        elementType: element.elementType,
        sourceSnippet,
        selectionExplanation: "The user selected this UI element from the ADE iOS Simulator inspector. The screenshot or crop attachment is visual evidence for this packet; frames are in screenshot pixels.",
      },
      accessibilityIdentifier: element.identifier,
      screenshotDataUrl: screenshotDataUrl ?? undefined,
      selectedAt: nowIso(),
    };
  };

  const coordinateFallbackItem = (
    point: { x: number; y: number },
    deviceUdid: string,
    runtime: LaneRuntime,
    screenshotDataUrl?: string | null,
  ): IosElementContextItem => ({
    kind: "ios_element",
    id: randomUUID(),
    componentId: "Simulator coordinate",
    sourceFile: null,
    sourceLine: null,
    frame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
    metadata: {
      iosInspectPacketVersion: 1,
      deviceUdid,
      chatSessionId: runtime.activeSession?.chatSessionId ?? null,
      sourceConfidence: "none",
      selectedElement: {
        source: "coordinate",
        screenshotFrame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
      },
      note: "No accessibility or ADEInspectorKit frame match was reported; this context preserves the selected simulator coordinate and screenshot.",
    },
    accessibilityIdentifier: null,
    screenshotDataUrl: screenshotDataUrl ?? undefined,
    selectedAt: nowIso(),
  });

  const inspectPoint = async (point: IosSimulatorInspectPointArgs): Promise<IosSimulatorInspectResult> => {
    assertDarwin();
    const runtime = resolveRuntime(point);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    // Resolve the lane ladder once and hand the resolved tree to both the
    // snapshot and the source matcher; passing the raw point.projectRoot let a
    // lane-scoped inspect match the primary checkout's sources.
    const sourceRoot = await resolveScopedRootForSession({
      projectRoot: point.projectRoot ?? null,
      laneId: point.laneId ?? null,
    });
    const screenSnapshot = await captureScreenSnapshot({ deviceUdid: point.deviceUdid, x, y }, sourceRoot, runtime);
    // Inspecting exists to show the user what was hit, so reveal the drawer
    // whichever host answered — including a miss, where the empty result is
    // itself the thing to show.
    requestDrawerOpen("inspectPoint", "inspect", {
      chatSessionId: runtime.activeSession?.chatSessionId,
      laneId: point.laneId ?? runtime.activeSession?.laneId,
    });
    const element = screenSnapshot.hitElement;
    if (!element) {
      return {
        item: null,
        source: "none",
        snapshot: screenSnapshot.inspectorSnapshot,
        screenSnapshot,
      };
    }
    return {
      item: contextItemFromScreenElement(element, screenSnapshot, runtime, point.includeScreenshot ? screenSnapshot.screenshot.dataUrl : null, sourceRoot),
      source: element.source,
      snapshot: screenSnapshot.inspectorSnapshot,
      screenSnapshot,
    };
  };

  /**
   * The live view, as a status read reports it.
   *
   * The address and the token are the stream's only authorisation, and
   * `getStreamStatus` is on the action allowlist with no ownership guard — so
   * `ade actions run ios_simulator.getStreamStatus --json` prints whatever this
   * returns into a durable agent transcript. The shape is useful there; the
   * secret is not. Only `startStream` — the call that mints it — hands it out.
   */
  const getStreamStatus = (streamArgs: { laneId?: string | null; chatSessionId?: string | null } = {}): IosSimulatorStreamStatus => {
    const runtime = resolveRuntime(streamArgs);
    const status = runtime.streamStatus;
    if (!status.transport) return { ...status, streamUrl: null, pointWidth: null, pointHeight: null };
    return {
      ...status,
      // `streamUrl` would carry the same address, so redacting only the
      // transport would leave it in the field right next to it. Both go.
      streamUrl: null,
      transport: { ...status.transport, url: null, token: null },
      // Where the skill tells an agent to read the screen size for a swipe.
      pointWidth: status.transport.pointWidth ?? null,
      pointHeight: status.transport.pointHeight ?? null,
    };
  };

  /** Ask the helper to stop capturing, tolerating a helper that is already gone. */
  const stopCapture = async (runtime: LaneRuntime): Promise<void> => {
    const udid = runtime.streamStatus.deviceUdid;
    if (!udid || !helperClient) return;
    await helperClient.send({ type: "capture-stop", udid }).catch((error: unknown) => {
      args.logger.debug("apple.capture_stop_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    });
  };

  const stopStream = async (
    streamArgs: { laneId?: string | null; chatSessionId?: string | null; localViewer?: boolean } = {},
  ): Promise<IosSimulatorStreamStatus> => {
    const runtime = resolveRuntime(streamArgs);
    /*
     * The last viewer on THIS machine left, and a phone or web tab is still
     * reading the same capture through the relay. Stopping it would cut them
     * off (the owner's 2026-09-23 report: the Mac's view went away while the
     * phone's kept going only because it reconnected). The capture stays up
     * and becomes the relay's to stop when its own last viewer leaves.
     */
    if (streamArgs.localViewer && runtime.laneId && runtime.streamStatus.running
      && remoteViewers?.watching(runtime.laneId)) {
      localViewerLanes.delete(runtime.laneId);
      remoteViewers.adopt(runtime.laneId);
      args.logger.info("apple.stream_kept_for_remote_viewer", { laneId: runtime.laneId });
      return runtime.streamStatus;
    }
    return stopRuntimeStream(runtime);
  };

  /** Stop one runtime's capture and publish it stopped. */
  const stopRuntimeStream = async (runtime: LaneRuntime): Promise<IosSimulatorStreamStatus> => {
    // A stopped stream has no local viewer. Cleared for every stop — the
    // renderer's own, the relay's, and the internal one that swaps devices —
    // so the flag cannot outlive the capture it described.
    if (runtime.laneId) localViewerLanes.delete(runtime.laneId);
    await stopCapture(runtime);
    const next = setStreamStopped(runtime, null);
    emit({ type: "stream-stopped", status: next });
    return next;
  };

  /**
   * The single-owner rule for ending a lane's session: another chat's session
   * is refused unless the caller passes `force` or `ignoreOwnership`.
   */
  const assertSessionOwner = (
    runtime: LaneRuntime,
    caller: { chatSessionId?: string | null; force?: boolean | null; ignoreOwnership?: boolean | null },
  ): void => {
    const owner = runtime.activeSession?.chatSessionId;
    if (owner && owner !== (caller.chatSessionId ?? null) && !caller.force && !caller.ignoreOwnership) {
      throw new IosSimulatorOwnedBySessionError(runtime.activeSession);
    }
  };

  const shutdown = async (shutdownArgs: IosSimulatorShutdownArgs = {}): Promise<IosSimulatorShutdownResult> => {
    const runtime = resolveRuntime(shutdownArgs);
    // Same single-owner rule as `launch` above, checked before any teardown so
    // a refused shutdown leaves the stream of the owning chat untouched.
    // Without it, `ade apple shutdown` — a step in every chat's own
    // instructions — silently evicted whichever other chat was mid-verify.
    //
    // Cooperative, not enforced: it separates callers that say who they are, so
    // one chat cannot end another's session by accident. `force` (which also
    // hard-resets the launch lock) and `ignoreOwnership` (which does not) both
    // step around it deliberately, and so does any caller that names the
    // owner's own id — `getStatus` hands that id to anyone who asks.
    assertSessionOwner(runtime, shutdownArgs);
    // "Free the device from THAT session": the check and the teardown happen
    // here, in one step, so a session that changed hands meanwhile is left
    // alone and the caller is told nothing was released.
    const expected = shutdownArgs.expectedChatSessionId?.trim();
    if (expected && runtime.activeSession?.chatSessionId !== expected) {
      // `previousSession` here is who holds it now (null: nobody), so the
      // caller can say which of the two happened.
      return { released: false, previousSession: runtime.activeSession };
    }
    const previousSession = runtime.activeSession;
    try {
      await stopStream({ laneId: runtime.laneId });
    } catch (error) {
      args.logger.debug("ios_simulator.stop_stream_during_shutdown_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (shutdownArgs.force) {
      // Force is the documented escape hatch for a wedged launch, so it has to
      // release the launch lock too. Without this an in-flight launch that
      // never returns left `activeLaunchId` set forever and every subsequent
      // launch failed IOS_SIMULATOR_LAUNCH_IN_PROGRESS — the one error the
      // user was told force would clear. The supersede guard inside `launch`
      // stops the abandoned launch from publishing its session afterwards.
      runtime.activeLaunchId = null;
    }
    const released = runtime.activeSession !== null;
    runtime.activeSession = null;
    invalidateStatus(runtime);
    if (released || previousSession) {
      emit({ type: "session-updated", session: null });
      emit({ type: "session-released", previousSession });
    }
    return { released, previousSession };
  };

  /**
   * Called when the owning chat ends or is deleted. Without it the simulator
   * stays locked to a chat that no longer exists and every later launch fails
   * the ownership check.
   *
   * Sweeps EVERY lane, not just the chat's own: one chat can hold an app
   * session on one lane and a device session on another, and a per-lane release
   * would leave the second one claimed forever.
   */
  const releaseIfOwnedBy = async (chatSessionId: string | null | undefined): Promise<IosSimulatorShutdownResult> => {
    const trimmed = chatSessionId?.trim() || null;
    if (!trimmed) return { released: false, previousSession: null };
    // A chat's turn ending also ends the recordings it started automatically.
    await recordings.onTurnEnded(trimmed).catch((error: unknown) => {
      args.logger.debug("apple.recording_turn_end_failed", {
        chatSessionId: trimmed,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // Its device leases (any holder name its agents gave) pass to the next in
    // line now, not when their TTL runs out.
    const leasesEnded = deviceLeases.endChat(trimmed);
    if (leasesEnded > 0) args.logger.info("apple.device_leases_ended_with_chat", { chatSessionId: trimmed, count: leasesEnded });
    let result: IosSimulatorShutdownResult = { released: false, previousSession: null };
    for (const runtime of [...runtimes.values()]) {
      // A chat can hold a device session without holding an app session, so the
      // device half is released on its own terms. Without this a closed chat
      // left its simulator claimed and no other chat could open one.
      if (runtime.hub) {
        await runtime.hub.releaseDeviceIfOwnedBy(trimmed).catch((error: unknown) => {
          args.logger.debug("ios_simulator.device_release_failed", {
            chatSessionId: trimmed,
            laneId: runtime.laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (runtime.activeSession?.chatSessionId !== trimmed) continue;
      args.logger.info("ios_simulator.released_with_chat_session", { chatSessionId: trimmed, laneId: runtime.laneId });
      // Identify as the owner: shutdown now refuses an anonymous non-force call.
      const released = await shutdown({ chatSessionId: trimmed, laneId: runtime.laneId, force: false });
      if (released.released) result = released;
    }
    return result;
  };

  /* ───────────────────────── live view ───────────────────────── */

  /**
   * Lanes a renderer on this machine is watching.
   *
   * The relay asks `hasLocalViewer` before it stops a capture for its last
   * remote viewer, so a web tab closing cannot black out the desktop column
   * that joined the same stream. Tracked here rather than in a main-process
   * registry because the runtime-action path — the one the desktop renderer
   * actually uses with a project open — never reaches the IPC handler that used
   * to populate one. Cleared on any stop: a stream that is gone has no viewer.
   */
  const localViewerLanes = new Set<string>();
  /**
   * The relay's viewers, when this service has a relay in front of it. Set by
   * `createAppleStreamRelayForService`; null in a process that has none.
   */
  let remoteViewers: AppleRemoteViewerProbe | null = null;
  const setRemoteViewerProbe = (probe: AppleRemoteViewerProbe | null): void => {
    remoteViewers = probe;
  };
  const markLocalViewer = (laneId: string | null | undefined): void => {
    const lane = typeof laneId === "string" ? laneId.trim() : "";
    if (lane) localViewerLanes.add(lane);
  };
  const hasLocalViewer = (laneId: string | null | undefined): boolean => {
    const lane = typeof laneId === "string" ? laneId.trim() : "";
    return lane ? localViewerLanes.has(lane) : false;
  };

  /**
   * Encodes the device screen on the machine that owns it and serves it over
   * loopback.
   *
   * There is one backend now. The old `simulator-window-capture` path had the
   * renderer mirror the real Simulator.app window, which forced a Screen
   * Recording grant, a visible window on this Mac, and a bezel in the picture —
   * and could not work at all when the simulator was on a remote Mac. The
   * helper reads the simulator's own framebuffer, so the canvas IS the device
   * screen and the desktop reads the URL below directly when the machine is
   * this one and through an SSH port forward when it is not.
   */
  const startStream = async (streamArgs: IosSimulatorStartStreamArgs = {}): Promise<IosSimulatorStreamStatus> => {
    // Ahead of resolveDevice: on Windows/Linux the device lookup fails first
    // and reported "No available iOS Simulator devices were found", which reads
    // as a fixable setup problem rather than the platform being unsupported.
    assertDarwin();
    const runtime = resolveRuntime(streamArgs);
    const device = await resolveDevice(streamArgs.deviceUdid ?? runtime.activeSession?.deviceUdid, runtime);
    const requestedFps = clampStreamFps(streamArgs.fps);
    const scale = clampStreamRatio(streamArgs.scaleFactor) ?? 1;
    const bitrateKbps = clampStreamBitrateKbps(streamArgs.bitrateKbps);
    const wantsBoot = streamArgs.boot === true;
    if (isDeviceOff(device)) {
      // A capture "running" on a device that is off is left over from before
      // the power went (an app restart, Xcode, a reboot). Publish it stopped
      // so neither branch below hands out its dead address.
      if (runtime.streamStatus.running && runtime.streamStatus.deviceUdid === device.udid) {
        markStreamGone(runtime);
      }
      // Watching never boots. The owner's 2026-09-23 report: reopening the
      // tools pane after a restart booted the simulator instead of showing
      // "{name} is off." Checked before any other lane stream is stopped, so
      // a refused viewer changes nothing.
      if (!wantsBoot) throw new AppleDeviceOffError(device);
    }
    if (
      runtime.streamStatus.running
      && runtime.streamStatus.deviceUdid === device.udid
      // Only a capture the LIVE helper owns. A status stamped by a helper that
      // has since died points at a dead port; the exit hook normally clears it
      // first, and this is the guard for any path that did not.
      && runtime.streamStatus.helperPid === (helperClient?.pid() ?? null)
    ) {
      // Already running for this device: join it. Never restart a shared
      // capture for a viewer's settings. A restart hands out a new address,
      // and every reader on the old one (the Mac's own view, another
      // machine's) freezes on its last frame while taps still land: the
      // owner's 2026-09-23 report of a phone that froze the MacBook's view.
      //
      // fps is not a reason either: the helper takes the framebuffer's own
      // rate, and the desktop asks for 30 where the relay asks for the default.
      //
      // A new cap goes to the live encoder instead. `capture-start` on a
      // running device keeps its server, its address and its readers; a helper
      // that knows caps rebuilds only the encoder, and an older one ignores
      // the cap. `null` asks for no cap, which must not lift a cap a remote
      // viewer set, so it never gets here; `liftStreamBitrateCap` does that.
      if (streamArgs.localViewer) markLocalViewer(runtime.laneId);
      if (bitrateKbps != null && (runtime.streamStatus.bitrateKbps ?? null) !== bitrateKbps) {
        return applyLiveBitrateCap(
          runtime,
          { udid: device.udid, fps: requestedFps, scale, bitrateKbps },
          nextCapGeneration(runtime),
        );
      }
      return runtime.streamStatus;
    }
    // A capture already running on this lane for another device has to go
    // first: the helper keys captures by udid and would leave the old one
    // streaming to a reader nobody is holding.
    if (runtime.streamStatus.running) await stopStream({ laneId: runtime.laneId });
    // The helper reads the framebuffer of a BOOTED device and refuses one that
    // is off. An explicit start boots it here; a viewer never gets this far
    // with a device that is off (see the check above). A device that is still
    // booting is waited for, not booted again.
    if (wantsBoot) await ensureDeviceBooted(device);
    else if (device.state === "Booting") await waitForSimulatorBootStatus(device);
    if (streamArgs.localViewer) markLocalViewer(runtime.laneId);
    const payload = await helper().send({
      type: "capture-start",
      udid: device.udid,
      fps: requestedFps,
      scale,
      // Only when a caller asked for one: omitting it keeps the helper's own
      // default, which is what a local viewer wants.
      ...(bitrateKbps != null ? { bitrateKbps } : {}),
    });
    const url = typeof payload.url === "string" ? payload.url : null;
    const token = typeof payload.token === "string" ? payload.token : null;
    if (!url || !token) {
      throw new Error("The simulator helper started a capture but reported no stream address.");
    }
    const port = Number(new URL(url).port) || 0;
    const pixelWidth = typeof payload.pixelWidth === "number" ? payload.pixelWidth : null;
    const pixelHeight = typeof payload.pixelHeight === "number" ? payload.pixelHeight : null;
    // The helper answers with both, and both matter: pixels size the decoded
    // frame, points are the unit every input call takes.
    const pointWidth = typeof payload.pointWidth === "number" ? payload.pointWidth : null;
    const pointHeight = typeof payload.pointHeight === "number" ? payload.pointHeight : null;
    runtime.streamRequestContext = {
      requestedBackend: IOS_SIMULATOR_STREAM_BACKEND,
      fallbackReason: null,
      degradationReason: null,
    };
    runtime.streamStatus = {
      deviceUdid: device.udid,
      running: true,
      backend: IOS_SIMULATOR_STREAM_BACKEND,
      requestedBackend: IOS_SIMULATOR_STREAM_BACKEND,
      fallbackReason: null,
      degradationReason: null,
      fps: null,
      targetFps: requestedFps,
      // The requested cap, remembered so a later `startStream` can tell whether
      // the running capture already honors it.
      bitrateKbps,
      frameCount: null,
      startedAt: nowIso(),
      lastFrameAt: null,
      lastError: null,
      error: null,
      streamUrl: url,
      averageLatencyMs: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      helperPid: helperClient?.pid() ?? null,
      inputBackend: "helper",
      transport: {
        url,
        port,
        token,
        // The helper announces the codec inside the stream's own config record
        // rather than on the control channel, so the reader learns it from the
        // first record — the same place it always did.
        codec: null,
        width: pixelWidth,
        height: pixelHeight,
        pointWidth,
        pointHeight,
      },
    };
    emit({ type: "stream-started", status: runtime.streamStatus });
    return runtime.streamStatus;
  };

  /** Counts caps sent to each lane's live encoder, so only the newest answer writes the status. */
  const capGenerations = new WeakMap<LaneRuntime, number>();

  /** Take the lane's next cap generation. The caller holds it and passes it to `applyLiveBitrateCap`. */
  const nextCapGeneration = (runtime: LaneRuntime): number => {
    const generation = (capGenerations.get(runtime) ?? 0) + 1;
    capGenerations.set(runtime, generation);
    return generation;
  };

  /**
   * Send a new cap to a running capture's encoder. `bitrateKbps: 0` removes
   * the cap and the helper goes back to its own default.
   *
   * `capture-start` on a running device keeps its server, its address and
   * its readers; the helper rebuilds only the encoder. `generation` comes from
   * `nextCapGeneration`.
   */
  const applyLiveBitrateCap = async (
    runtime: LaneRuntime,
    cap: { udid: string; fps: number; scale: number; bitrateKbps: number },
    generation: number,
  ): Promise<IosSimulatorStreamStatus> => {
    const payload = await helper().send({
      type: "capture-start",
      udid: cap.udid,
      fps: cap.fps,
      scale: cap.scale,
      bitrateKbps: cap.bitrateKbps,
    });
    // A newer cap went to the helper while this one was in flight. The helper
    // applies them in order, so the newer answer is the one to record.
    if (capGenerations.get(runtime) !== generation) return runtime.streamStatus;
    const bitrateKbps = cap.bitrateKbps > 0 ? cap.bitrateKbps : null;
    const url = typeof payload.url === "string" ? payload.url : null;
    const token = typeof payload.token === "string" ? payload.token : null;
    const transport = runtime.streamStatus.transport;
    if (url && token && transport && (url !== transport.url || token !== transport.token)) {
      // The helper must answer with the address it already had. If it did
      // not, the old readers are gone anyway: record the new address and
      // announce it as a new stream so viewers attach to it.
      args.logger.warn("apple.stream_cap_changed_address", { laneId: runtime.laneId, deviceUdid: cap.udid });
      runtime.streamStatus = {
        ...runtime.streamStatus,
        bitrateKbps,
        streamUrl: url,
        transport: { ...transport, url, token, port: Number(new URL(url).port) || 0 },
      };
      emit({ type: "stream-started", status: runtime.streamStatus });
      return runtime.streamStatus;
    }
    runtime.streamStatus = { ...runtime.streamStatus, bitrateKbps };
    return runtime.streamStatus;
  };

  /**
   * Re-cap a capture that is already running, and nothing else.
   *
   * The relay's pacing lowers and restores a lane's cap while remote viewers
   * watch. `startStream` would resolve the device again (a `simctl` read) and,
   * when the capture stopped meanwhile or the lane's session moved to another
   * device, start one: a capture nobody stops, or on the wrong device. This
   * touches only the encoder of the capture that is running now.
   */
  const capLiveStream = async (capArgs: {
    laneId: string;
    bitrateKbps: number;
  }): Promise<IosSimulatorStreamStatus | null> => {
    const lane = laneKey(capArgs.laneId);
    const runtime = lane ? runtimes.get(lane) : null;
    if (!runtime) return null;
    const status = runtime.streamStatus;
    if (!status.running || !status.deviceUdid) return status;
    if (status.helperPid !== (helperClient?.pid() ?? null)) return status;
    const bitrateKbps = clampStreamBitrateKbps(capArgs.bitrateKbps);
    if (bitrateKbps == null || (status.bitrateKbps ?? null) === bitrateKbps) return status;
    return applyLiveBitrateCap(runtime, {
      udid: status.deviceUdid,
      fps: clampStreamFps(status.targetFps),
      scale: 1,
      bitrateKbps,
    }, nextCapGeneration(runtime));
  };

  /**
   * The relay's last remote viewer left and the capture keeps running for a
   * viewer on this machine: take the remote cap off, so the local view is
   * back at full quality instead of the phone's bitrate until it restarts.
   *
   * Does nothing when no cap is set, when the capture belongs to a dead
   * helper, or when a remote viewer joined again in the meantime (it keeps
   * its cap). A helper too old to know `0` refuses it, and the cap stays.
   */
  const liftStreamBitrateCap = async (liftArgs: { laneId: string }): Promise<IosSimulatorStreamStatus | null> => {
    const lane = laneKey(liftArgs.laneId);
    const runtime = lane ? runtimes.get(lane) : null;
    if (!runtime) return null;
    const status = runtime.streamStatus;
    if (!status.running || !status.deviceUdid || (status.bitrateKbps ?? null) === null) return status;
    if (status.helperPid !== (helperClient?.pid() ?? null)) return status;
    if (remoteViewers?.watching(lane)) return status;
    // Cleared before the helper call: a remote viewer that rejoins meanwhile
    // then sees no cap and sends its own, which the helper applies after this.
    runtime.streamStatus = { ...status, bitrateKbps: null };
    const generation = nextCapGeneration(runtime);
    try {
      const lifted = await applyLiveBitrateCap(runtime, {
        udid: status.deviceUdid,
        fps: clampStreamFps(status.targetFps),
        scale: 1,
        bitrateKbps: 0,
      }, generation);
      args.logger.info("apple.stream_cap_lifted", { laneId: lane, deviceUdid: status.deviceUdid });
      return lifted;
    } catch (error) {
      // Refused (a helper too old to know 0): the cap stays, unless a newer
      // cap was sent meanwhile.
      if (capGenerations.get(runtime) === generation) {
        runtime.streamStatus = { ...runtime.streamStatus, bitrateKbps: status.bitrateKbps };
      }
      throw error;
    }
  };

  /**
   * One decoded frame from the running stream, written as a PNG.
   *
   * Cheaper than `screenshot`, which round-trips `simctl` and re-encodes the
   * whole framebuffer. It needs a running stream because that is what proves
   * the device is producing pixels at all; `screenshot` does not.
   */
  const frame = async (frameArgs: AppleFrameArgs = {}): Promise<AppleFrameResult> => {
    assertDarwin();
    const runtime = resolveRuntime(frameArgs);
    if (!runtime.streamStatus.running) {
      throw new Error(`${APPLE_STREAM_NOT_RUNNING_CODE}: no live view is running${runtime.laneId ? ` on lane ${runtime.laneId}` : ""}. Start one with stream-start, or use screenshot, which needs no stream.`);
    }
    const deviceUdid = runtime.streamStatus.deviceUdid
      ?? await resolveControlDeviceUdid(frameArgs.deviceUdid, runtime);
    const root = await resolveScopedRootForSession({ laneId: frameArgs.laneId }, runtime);
    const requestedOutPath = frameArgs.outPath?.trim();
    const cacheDirectory = path.join(root, ...FRAME_CACHE_SEGMENTS);
    const filePath = requestedOutPath
      ? path.resolve(root, requestedOutPath)
      : path.join(cacheDirectory, `frame-${nowIso().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`);
    // The same containment rule as `screenshot`: `outPath` reaches here from an
    // agent's tool call, so an absolute path or a `../..` tail would otherwise
    // let a frame grab write anywhere the ADE process can.
    if (!isPathInside(filePath, root)) {
      throw new IosSimulatorOutPathOutsideRootError(filePath, root);
    }
    if (fs.existsSync(root)) {
      try {
        resolvePathWithinRoot(root, filePath, { allowMissing: true });
      } catch (error) {
        if (isPathEscapeError(error)) throw new IosSimulatorOutPathOutsideRootError(filePath, root);
        throw error;
      }
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const payload = await helper().send({ type: "screenshot", udid: deviceUdid, path: filePath });
    return {
      filePath: typeof payload.path === "string" ? payload.path : filePath,
      width: typeof payload.width === "number" ? payload.width : 0,
      height: typeof payload.height === "number" ? payload.height : 0,
    };
  };

  /**
   * The hub, behind the same platform gate the rest of the surface uses.
   *
   * Every device-hub method shells out to `xcrun`. Without this a Windows or
   * Linux caller got `spawn xcrun ENOENT` from the action surface instead of
   * the one sentence that says why, which reads as a broken install rather
   * than an unsupported platform.
   */
  const darwinHub = (scope: { laneId?: string | null; chatSessionId?: string | null } = {}): IosDeviceHub => {
    assertDarwin();
    return hub(resolveRuntime(scope));
  };

  /* ───────────────────────── input ───────────────────────── */

  /**
   * Run a gesture's steps with nothing else written between them (see
   * `SimHelperClient.sendGesture`): a snapshot or a screenshot from another
   * caller can no longer hold the finger down between a tap's begin and end.
   */
  const helperGesture = <T>(gesture: (send: SimHelperTransport["send"]) => Promise<T>): Promise<T> =>
    helper().sendGesture(gesture);

  /**
   * A tap, as the helper wants it: a begin and an end at the same point.
   *
   * The helper's wire unit is DEVICE POINTS (`Protocol.swift`'s `DevicePoint`,
   * normalised to a 0..1 fraction in `DeviceMetrics` on the far side), which is
   * the same unit idb's `ui tap` took — so no call site had to change its
   * coordinates when the engine did.
   */
  const helperTap = async (deviceUdid: string, x: number, y: number, space: HelperPointSpace): Promise<void> => {
    await helperGesture(async (send) => {
      await send({ type: "touch", udid: deviceUdid, phase: "begin", x, y, space });
      await send({ type: "touch", udid: deviceUdid, phase: "end", x, y, space });
    });
  };

  const helperType = async (deviceUdid: string, text: string): Promise<void> => {
    await helper().send({ type: "type", udid: deviceUdid, text });
  };

  /**
   * A drag, as a begin / moves / end sequence.
   *
   * idb issued an instantaneous swipe without `--duration` and iOS read that as
   * a flick rather than a drag, so a scroll or a slider drag did nothing. The
   * helper has no duration argument at all — the gesture IS the move events —
   * so the duration is spent here, as evenly spaced steps. The default is the
   * same 180ms every caller used to get.
   */
  const helperSwipe = async (
    deviceUdid: string,
    input: { startX: number; startY: number; endX: number; endY: number; durationMs?: number | null },
    space: HelperPointSpace,
  ): Promise<void> => {
    const requestedMs = input.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
    if (!Number.isFinite(requestedMs)) throw new Error("durationMs must be a number.");
    // A gesture holds the helper for every simulator on this Mac, so it ends
    // well inside the control slot's timeout.
    const durationMs = Math.min(requestedMs, MAX_SWIPE_DURATION_MS);
    const steps = Math.max(2, Math.min(60, Math.round(Math.max(durationMs, 1) / DRAG_STEP_MS)));
    const stepDelayMs = Math.max(0, Math.round(durationMs / steps));
    await helperGesture(async (send) => {
      await send({ type: "touch", udid: deviceUdid, phase: "begin", x: input.startX, y: input.startY, space });
      for (let step = 1; step < steps; step += 1) {
        const progress = step / steps;
        await send({
          type: "touch",
          udid: deviceUdid,
          phase: "move",
          x: input.startX + ((input.endX - input.startX) * progress),
          y: input.startY + ((input.endY - input.startY) * progress),
          space,
        });
        if (stepDelayMs > 0) await delay(stepDelayMs);
      }
      await send({ type: "touch", udid: deviceUdid, phase: "end", x: input.endX, y: input.endY, space });
    });
  };

  /** A finger held down at one point for `durationMs`, then lifted, as one gesture. */
  const helperHold = async (deviceUdid: string, x: number, y: number, durationMs: number, space: HelperPointSpace): Promise<void> => {
    await helperGesture(async (send) => {
      await send({ type: "touch", udid: deviceUdid, phase: "begin", x, y, space });
      try {
        await delay(durationMs);
      } finally {
        // The finger always comes up, even if the wait was cut short.
        await send({ type: "touch", udid: deviceUdid, phase: "end", x, y, space });
      }
    });
  };

  /* ───────────────────────── iPad windows ───────────────────────── */

  const windowControl = createAppleWindowControl({
    readAccessibilityElements: (deviceUdid) => readAccessibilityElements(deviceUdid),
    readAccessibilityElementAt: (deviceUdid, x, y) => readAccessibilityElementAt(deviceUdid, x, y),
    enqueueControl: (action, runControl, timeoutMs) => enqueueControl(action, runControl, timeoutMs),
    helperGesture: (gesture) => helperGesture(gesture),
    helperTap: (deviceUdid, x, y, space) => helperTap(deviceUdid, x, y, space),
    helperSwipe: (deviceUdid, input, space) => helperSwipe(deviceUdid, input, space),
    helperHold: (deviceUdid, x, y, durationMs, space) => helperHold(deviceUdid, x, y, durationMs, space),
    getScreenSnapshot: (snapshotArgs) => getScreenSnapshot(snapshotArgs),
    touchDevice: (deviceUdid) => maintenance?.touch(deviceUdid),
    logger: args.logger,
  });

  /** Lay out the front app's window on an iPad (`ade apple window`); see `appleWindowControl.ts`. */
  const windowLayout = async (layoutArgs: AppleWindowLayoutArgs = {}): Promise<AppleWindowLayoutResult> => {
    assertDarwin();
    const runtime = resolveRuntime(layoutArgs);
    const deviceUdid = await resolveControlDeviceUdid(layoutArgs.deviceUdid, runtime);
    return windowControl.windowLayout(deviceUdid, runtime.key, layoutArgs);
  };

  const tap = async (point: {
    deviceUdid?: string | null;
    x: number;
    y: number;
    laneId?: string | null;
    chatSessionId?: string | null;
    source?: AppleInputSource;
    noRecord?: boolean | null;
  }): Promise<{ ok: true }> => {
    assertDarwin();
    const runtime = resolveRuntime(point);
    const deviceUdid = await resolveControlDeviceUdid(point.deviceUdid, runtime);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    return enqueueControl("tap", async () => {
      // Whoever taps now, a live finger still held on this lane comes up first.
      await liftLiveTouch(runtime.key, "tap", runtime.laneId);
      await helperTap(deviceUdid, x, y, inputPointSpace(point.source));
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "tap", x, y, source: point.source, noRecord: point.noRecord });
      return { ok: true };
    });
  };

  /**
   * A press held at one point: begin, hold, end, as one helper gesture so
   * nothing else lands while the finger is down (`sendGesture`). What opens a
   * context menu or starts a drag-to-reorder; `tap` holds for no time at all.
   * The hold is clamped to 100 ms–5 s, inside the control slot's timeout.
   */
  const longPress = async (input: IosSimulatorLongPressArgs): Promise<{ ok: true; action: "long-press"; durationMs: number }> => {
    assertDarwin();
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    const x = normalizeCoordinate(input.x, "x");
    const y = normalizeCoordinate(input.y, "y");
    const requested = input.durationMs ?? APPLE_LONG_PRESS_DEFAULT_MS;
    if (!Number.isFinite(requested) || requested <= 0) throw new Error("durationMs must be a positive number of milliseconds.");
    const durationMs = Math.round(Math.min(APPLE_LONG_PRESS_MAX_MS, Math.max(APPLE_LONG_PRESS_MIN_MS, requested)));
    const space = inputPointSpace(input.source);
    return enqueueControl("tap", async () => {
      await liftLiveTouch(runtime.key, "long-press", runtime.laneId);
      await helperHold(deviceUdid, x, y, durationMs, space);
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "tap", x, y, source: input.source, noRecord: input.noRecord });
      return { ok: true, action: "long-press", durationMs };
    });
  };

  /**
   * A hardware button press through the helper's `button` command.
   *
   * Same ownership ladder as `tap` (`resolveRuntime` → `resolveControlDeviceUdid`
   * → `enqueueControl`). Not overlay input, so this does not call `noteInput`.
   *
   * `shake` is in the public union so the column can name it, but it is not a
   * helper button and this Xcode's `simctl` has no shake verb — refused with
   * `APPLE_BUTTON_UNSUPPORTED`.
   */
  const pressButton = async (buttonArgs: ApplePressButtonArgs): Promise<ApplePressButtonResult> => {
    assertDarwin();
    const rawName = typeof buttonArgs.name === "string" ? buttonArgs.name.trim() : "";
    if (!isAppleHardwareButtonName(rawName)) {
      throw new Error(
        `${APPLE_BUTTON_UNSUPPORTED_CODE}: '${buttonArgs.name}' is not a hardware button ADE can press. Valid names: ${APPLE_HARDWARE_BUTTONS.join(", ")}.`,
      );
    }
    const runtime = resolveRuntime(buttonArgs);
    const deviceUdid = await resolveControlDeviceUdid(buttonArgs.deviceUdid, runtime);
    return enqueueControl("pressButton", async () => {
      switch (rawName) {
        case "home":
        case "lock":
        case "volume-up":
        case "volume-down":
        case "siri":
          try {
            await helper().send({ type: "button", udid: deviceUdid, name: rawName });
          } catch (error) {
            if (error instanceof SimHelperError && error.code === "unsupported-button") {
              throw new Error(`${APPLE_BUTTON_UNSUPPORTED_CODE}: ${error.message}`);
            }
            throw error;
          }
          runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
          return { ok: true };
        case "app-switcher":
          // The helper's `app_switcher` is Simulator's own App Switcher: two
          // home presses 150 ms apart. Two separate `home` calls would not do
          // it, because the helper's `home` relaunches SpringBoard instead of
          // pressing a button, and the gap between two calls is too long.
          await helper().send({ type: "button", udid: deviceUdid, name: "app_switcher" });
          runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
          return { ok: true };
        case "shake":
          throw new Error(
            `${APPLE_BUTTON_UNSUPPORTED_CODE}: shake is not a helper button, and this Xcode's simctl has no shake command.`,
          );
        default: {
          const unexpected: never = rawName;
          throw new Error(`${APPLE_BUTTON_UNSUPPORTED_CODE}: '${unexpected}' is not a hardware button ADE can press.`);
        }
      }
    });
  };

  /** The lane whose device this is, for an event about a device no stream is showing. */
  const laneIdHoldingUdid = (udid: string): string | null =>
    laneDevices.list().find((device) => device.udid === udid)?.laneId ?? null;

  /** The iPhone Duo's own surface: posture, panels, model, skill, renders. */
  const duo = createAppleDuoService<LaneRuntime>({
    assertDarwin,
    run: (command, commandArgs, options) => run(command, commandArgs, options),
    helperSend: (command) => helper().send(command),
    resolveRuntime,
    resolveControlDeviceUdid,
    resolveScopedRootForSession,
    enqueueControl,
    fileScreenshotAsProof,
    proofOwnerChatId,
    emit,
    logger: args.logger,
    captureAnalytics: (outcome) => args.captureAnalytics?.(outcome),
    readPngSize,
    nowIso,
    screenshotSegments: SCREENSHOT_CACHE_SEGMENTS,
    deviceSupportsDuo,
  });

  /**
   * Set the device orientation, and then go and look.
   *
   * The helper's `orientation` command answers `true` when its GSEvent reached
   * `PurpleWorkspacePort` with `KERN_SUCCESS` — a statement about a mach
   * message, not about iOS. Measured on 2026-09-21, on a machine with no
   * `Simulator.app` installed anywhere:
   *
   * - the send always succeeds and the DEVICE orientation really does change;
   * - whether the SCREEN turns is the foreground app's decision. SpringBoard
   *   and Settings on an iPhone are portrait-only, so four landscape rotates
   *   reported success and left the framebuffer at 1179x2556; Safari, launched
   *   afterwards onto the already-turned device, came up at 2556x1179;
   * - `portrait-upside-down` is refused the same way on an iPhone.
   *
   * So `applied` is decided by the framebuffer: read it, send, then wait for it
   * to land on the requested axis. A rotation nobody can see is reported as
   * `applied: false` with a reason, because the alternative is a viewer that
   * draws an upright screen on its side.
   */
  const rotate = async (rotateArgs: AppleRotateArgs): Promise<AppleRotateResult> => {
    assertDarwin();
    const rawOrientation = typeof rotateArgs.orientation === "string" ? rotateArgs.orientation.trim() : "";
    if (!isAppleDeviceOrientation(rawOrientation)) {
      throw new Error(
        `orientation must be ${APPLE_DEVICE_ORIENTATIONS.join(", ")}.`,
      );
    }
    const runtime = resolveRuntime(rotateArgs);
    const deviceUdid = await resolveControlDeviceUdid(rotateArgs.deviceUdid, runtime);
    const value = HELPER_ORIENTATION_VALUE[rawOrientation];
    const wantedAxis = appleOrientationFamily(rawOrientation);
    return enqueueControl("rotate", async () => {
      const postureBefore = await duo.foldablePosture(deviceUdid, "apple.rotate_posture_unreadable");
      if (postureBefore) return duo.rotate(deviceUdid, rawOrientation, value, postureBefore, APPLE_ROTATE_SETTLE_TIMEOUT_MS);
      const frameBefore = await readSimulatorFramebufferGeometry(deviceUdid);
      const payload = await helper().send({ type: "orientation", udid: deviceUdid, value });
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      if (payload.applied !== true) {
        return {
          applied: false,
          orientation: rawOrientation,
          verification: "send-failed",
          reason: APPLE_ROTATE_SEND_FAILED_CODE,
          detail: "The simulator helper could not deliver the orientation event to this device.",
          frameBefore,
          frameAfter: null,
        };
      }
      const axisBefore = frameBefore ? frameAxis(frameBefore) : null;
      if (!axisBefore) {
        // No reading means no claim. The event went out and may well have been
        // taken; saying `applied: true` on that basis is the bug this replaced.
        return {
          applied: false,
          orientation: rawOrientation,
          verification: "unmeasurable",
          reason: APPLE_ROTATE_UNMEASURABLE_CODE,
          detail: "The orientation event was sent, but this device's screen could not be read, so nothing is confirmed.",
          frameBefore,
          frameAfter: null,
        };
      }
      if (axisBefore === wantedAxis) {
        return {
          applied: true,
          orientation: rawOrientation,
          verification: "already-on-axis",
          reason: null,
          detail: `The screen is ${wantedAxis}. A turn within ${wantedAxis} leaves the same pixel size, so the exact side is not confirmed.`,
          frameBefore,
          frameAfter: frameBefore,
        };
      }
      const deadline = Date.now() + APPLE_ROTATE_SETTLE_TIMEOUT_MS;
      let frameAfter = frameBefore;
      for (;;) {
        const reading = await readSimulatorFramebufferGeometry(deviceUdid);
        if (reading) {
          frameAfter = reading;
          if (frameAxis(reading) === wantedAxis) {
            return {
              applied: true,
              orientation: rawOrientation,
              verification: "rotated",
              reason: null,
              detail: null,
              frameBefore,
              frameAfter,
            };
          }
        }
        if (Date.now() >= deadline) break;
        // A reading that failed outright costs nothing, so pace the loop
        // rather than spinning through the whole budget in one tick.
        await delay(150);
      }
      return {
        applied: false,
        orientation: rawOrientation,
        verification: "not-adopted",
        reason: APPLE_ROTATE_NOT_ADOPTED_CODE,
        detail: `The device turned to ${rawOrientation}, and the app on screen stayed ${axisBefore}. iOS only rotates the screen for an app that supports that orientation — the Home Screen and Settings are portrait-only on an iPhone, and no iPhone supports portrait upside down.`,
        frameBefore,
        frameAfter,
      };
    }, APPLE_ROTATE_CONTROL_TIMEOUT_MS);
  };

  /**
   * Scroll, through the helper's own gesture rather than a bounded drag.
   *
   * The helper turns the delta into a touch drag on the digitizer and
   * re-anchors the finger when it nears an edge, so a scroll longer than the
   * screen keeps going. `drag` cannot do that: one stroke, bounded by the
   * bezel. This is why `scroll` is its own verb and not sugar over `drag`.
   *
   * The direction is the VIEWPORT's, so `down` reveals what is below. The
   * helper speaks in content movement, where that is a negative delta — the
   * flip lives here so no caller carries both models.
   */
  const scroll = async (scrollArgs: AppleScrollArgs): Promise<AppleScrollResult> => {
    assertDarwin();
    const direction = typeof scrollArgs.direction === "string" ? scrollArgs.direction.trim() : "";
    if (!isAppleScrollDirection(direction)) {
      throw new Error(`direction must be ${APPLE_SCROLL_DIRECTIONS.join(", ")}.`);
    }
    const amount = scrollArgs.amount ?? APPLE_SCROLL_DEFAULT_AMOUNT;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number of device pixels.");
    const hasAnchorX = scrollArgs.anchorX != null;
    const hasAnchorY = scrollArgs.anchorY != null;
    // Half an anchor is a caller bug, not a request for the centre — the same
    // rule the helper's own parser enforces, stated here so the error names the
    // argument rather than arriving as a helper protocol failure.
    if (hasAnchorX !== hasAnchorY) throw new Error("anchorX and anchorY must be given together.");
    const anchor = hasAnchorX
      ? {
        anchorX: normalizeCoordinate(scrollArgs.anchorX, "anchorX"),
        anchorY: normalizeCoordinate(scrollArgs.anchorY, "anchorY"),
      }
      : null;
    const { deltaX, deltaY } = APPLE_SCROLL_DELTAS[direction](amount);
    const runtime = resolveRuntime(scrollArgs);
    const deviceUdid = await resolveControlDeviceUdid(scrollArgs.deviceUdid, runtime);
    return enqueueControl("scroll", async () => {
      await helper().send({ type: "scroll", udid: deviceUdid, deltaX, deltaY, ...(anchor ?? {}), space: inputPointSpace(scrollArgs.source) });
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      // A scroll IS injected input under the auto-record contract: it changes
      // what is on screen, and a video that skips it shows a jump cut. The
      // source is carried through so a person scrolling the pane does not look
      // like an agent and start a recording.
      noteInput(runtime, { udid: deviceUdid, kind: "drag", source: scrollArgs.source, noRecord: scrollArgs.noRecord });
      return { ok: true as const, action: "scroll" as const, direction, deltaX, deltaY };
    });
  };

  /**
   * Text through the helper's keyboard, to whatever has focus.
   *
   * For an agent (not a person typing in a viewer, where every key is a
   * call) it first asks which element has keyboard focus. Nothing focused is
   * said (`focus: "none"`, with a message), because the text then most
   * likely went nowhere and `ok` alone read as success. Where the runtime
   * cannot tell, nothing is claimed (`focus` is left out).
   */
  const typeText = async (
    input: { deviceUdid?: string | null; text: string; laneId?: string | null; chatSessionId?: string | null; source?: AppleInputSource; noRecord?: boolean | null },
    options: { checkFocus?: boolean } = {},
  ): Promise<{ ok: true; focus?: "field" | "none"; focused?: string | null; message?: string | null }> => {
    assertDarwin();
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    const checkFocus = options.checkFocus !== false && input.source !== "user";
    return enqueueControl("text", async () => {
      const focused = checkFocus ? await readFocusedElement(deviceUdid).catch(() => undefined) : undefined;
      await helperType(deviceUdid, input.text);
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "type", text: input.text, source: input.source, noRecord: input.noRecord });
      if (focused === undefined) return { ok: true };
      if (focused === null) {
        return {
          ok: true,
          focus: "none",
          focused: null,
          message: "No element had keyboard focus, so the text most likely went nowhere. Tap the field first, or use fill-element, which taps it and reads it back.",
        };
      }
      return { ok: true, focus: "field", focused: describeElement(focused) };
    });
  };

  /**
   * One real key press, with modifiers held around it: key-down and key-up
   * HID events through the helper, the way a hardware keyboard sends them.
   * `typeText` only spells characters, so it had no arrows, no escape and no
   * ⌘-shortcuts. Every modifier is released even when a press fails, or the
   * device would keep ⌘ held for the next command.
   */
  const pressKey = async (input: IosSimulatorPressKeyArgs): Promise<{ ok: true; key: string }> => {
    assertDarwin();
    const usage = appleKeyUsage(input.key ?? "");
    if (usage === null) {
      throw new AdeExpectedError(
        `Unknown key ${JSON.stringify(input.key)}. Keys: ${Object.keys(APPLE_NAMED_KEY_USAGES).join(", ")}, or one letter or digit.`,
        "user",
      );
    }
    const modifierNames = (input.modifiers ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
    const modifiers = modifierNames.map((name) => {
      const modifier = APPLE_KEY_MODIFIER_USAGES[name];
      if (modifier === undefined) {
        throw new AdeExpectedError(
          `Unknown modifier ${JSON.stringify(name)}. Modifiers: ${Object.keys(APPLE_KEY_MODIFIER_USAGES).join(", ")}.`,
          "user",
        );
      }
      return modifier;
    });
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    const label = [...modifierNames, input.key.trim().toLowerCase()].join("+");
    return enqueueControl("text", async () => {
      const send = (phase: "down" | "up", code: number) => helper().send({ type: "key", udid: deviceUdid, phase, usage: code });
      const held: number[] = [];
      try {
        for (const modifier of modifiers) {
          await send("down", modifier);
          held.push(modifier);
        }
        await send("down", usage);
        await send("up", usage);
      } finally {
        for (const modifier of held.reverse()) {
          await send("up", modifier).catch(() => undefined);
        }
      }
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "type", text: `[${label}]`, source: input.source, noRecord: input.noRecord });
      return { ok: true, key: label };
    });
  };

  const drag = async (input: IosSimulatorDragArgs, action: "drag" | "swipe" = "drag"): Promise<{ ok: true; action: "drag" | "swipe" }> => {
    assertDarwin();
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    const startX = normalizeCoordinate(input.startX, "startX");
    const startY = normalizeCoordinate(input.startY, "startY");
    const endX = normalizeCoordinate(input.endX, "endX");
    const endY = normalizeCoordinate(input.endY, "endY");
    const durationMs = input.durationMs;
    const deltaValue = input.delta;
    return enqueueControl("drag", async () => {
      await liftLiveTouch(runtime.key, "drag", runtime.laneId);
      if (durationMs != null && !Number.isFinite(durationMs)) throw new Error("durationMs must be a number.");
      // `delta` was idb's step size and the helper owns its own stepping now.
      // Still validated rather than ignored: a caller passing a nonsense delta
      // has a bug, and silently accepting it hides it.
      if (deltaValue != null && (!Number.isFinite(deltaValue) || deltaValue <= 0)) throw new Error("delta must be a positive number.");
      await helperSwipe(deviceUdid, { startX, startY, endX, endY, durationMs }, inputPointSpace(input.source));
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "drag", x: endX, y: endY, source: input.source, noRecord: input.noRecord });
      // Named, so the answer does not read as a tap.
      return { ok: true, action };
    });
  };

  /**
   * A finger held on a device by a live viewer, per lane: where it started,
   * where it is, and the timer that lifts it if the viewer goes quiet.
   */
  type LiveTouch = {
    udid: string;
    startX: number;
    startY: number;
    x: number;
    y: number;
    release: ReturnType<typeof setTimeout>;
  };
  const liveTouches = new Map<string, LiveTouch>();

  /**
   * A held finger the viewer stops updating is lifted after this. The viewer
   * repeats a still finger's point well inside it, so only a viewer that is
   * gone (a phone off the network mid-gesture) gets here, and one slow round
   * trip does not.
   */
  const LIVE_TOUCH_IDLE_RELEASE_MS = 4_000;

  const sendTouch = (udid: string, phase: "begin" | "move" | "end", x: number, y: number): Promise<unknown> =>
    // A viewer's finger, already on the framebuffer it draws.
    helper().send({ type: "touch", udid, phase, x, y, space: "frame" satisfies HelperPointSpace });

  /** Lift a lane's held finger, if any. Best-effort: the device may be gone. */
  const liftLiveTouch = async (laneKey: string, reason: string, laneId: string | null): Promise<void> => {
    const held = liveTouches.get(laneKey);
    if (!held) return;
    clearTimeout(held.release);
    liveTouches.delete(laneKey);
    await sendTouch(held.udid, "end", held.x, held.y).catch((error: unknown) => {
      args.logger.warn("apple.live_touch_lift_failed", {
        laneId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const armLiveTouchRelease = (laneKey: string, runtime: LaneRuntime): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      if (disposed) return;
      void enqueueControl("touch-release", async () => {
        if (liveTouches.get(laneKey)?.release !== timer) return;
        args.logger.warn("apple.live_touch_released", { laneId: runtime.laneId, reason: "idle" });
        await liftLiveTouch(laneKey, "idle", runtime.laneId);
      }).catch(() => null);
    }, LIVE_TOUCH_IDLE_RELEASE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  };

  /**
   * One phase of a live finger (`begin`, `move`, `end`), sent as a person's
   * finger does it, so the device moves under the finger instead of replaying
   * the gesture once it lifts.
   *
   * At most one finger per lane. A `begin` while one is held lifts the old one
   * first; a `move` or `end` with none held (it was already lifted for being
   * idle) does nothing. A `move` to the point already held only keeps the
   * finger alive. The held state changes before the helper is called, so a
   * send that fails or outlives its timeout cannot leave a finger without its
   * release timer or bring back one that was lifted. Input is noted once, when
   * the finger lifts.
   */
  const touch = async (input: {
    laneId?: string | null;
    chatSessionId?: string | null;
    deviceUdid?: string | null;
    phase: "begin" | "move" | "end";
    x: number;
    y: number;
    source?: AppleInputSource;
    noRecord?: boolean | null;
  }): Promise<{ ok: true }> => {
    assertDarwin();
    const phase: unknown = input.phase;
    if (phase !== "begin" && phase !== "move" && phase !== "end") {
      throw new Error("touch phase must be begin, move or end.");
    }
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    const x = normalizeCoordinate(input.x, "x");
    const y = normalizeCoordinate(input.y, "y");
    const laneKey = runtime.key;
    return enqueueControl("touch", async () => {
      if (phase === "begin") {
        await liftLiveTouch(laneKey, "replaced", runtime.laneId);
        liveTouches.set(laneKey, {
          udid: deviceUdid,
          startX: x,
          startY: y,
          x,
          y,
          release: armLiveTouchRelease(laneKey, runtime),
        });
        runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
        await sendTouch(deviceUdid, "begin", x, y);
        return { ok: true };
      }
      const held = liveTouches.get(laneKey);
      if (!held) return { ok: true };
      clearTimeout(held.release);
      if (phase === "move") {
        const still = held.x === x && held.y === y;
        liveTouches.set(laneKey, { ...held, x, y, release: armLiveTouchRelease(laneKey, runtime) });
        if (!still) await sendTouch(held.udid, "move", x, y);
        return { ok: true };
      }
      liveTouches.delete(laneKey);
      await sendTouch(held.udid, "end", x, y);
      const moved = Math.hypot(x - held.startX, y - held.startY) > 10;
      noteInput(runtime, { udid: held.udid, kind: moved ? "drag" : "tap", x, y, source: input.source, noRecord: input.noRecord });
      return { ok: true };
    });
  };

  const selectPoint = async (point: IosSimulatorPoint): Promise<IosSimulatorSelectResult> => {
    assertDarwin();
    const runtime = resolveRuntime(point);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    // Same lane ladder as inspectPoint: resolve once, then match source
    // against the resolved tree rather than the caller's raw projectRoot.
    const sourceRoot = await resolveScopedRootForSession({
      projectRoot: point.projectRoot ?? null,
      laneId: point.laneId ?? null,
    }, runtime);
    const screenSnapshot = await captureScreenSnapshot(
      { deviceUdid: point.deviceUdid ?? runtime.activeSession?.deviceUdid, x, y },
      sourceRoot,
      runtime,
    );
    const element = screenSnapshot.hitElement;
    const item = element
      ? contextItemFromScreenElement(element, screenSnapshot, runtime, screenSnapshot.screenshot.dataUrl, sourceRoot)
      : coordinateFallbackItem({ x, y }, screenSnapshot.deviceUdid, runtime, screenSnapshot.screenshot.dataUrl);
    lastSelectedItem = item;
    noteInput(runtime, { udid: screenSnapshot.deviceUdid, kind: "select", x, y, noRecord: point.noRecord });
    // Selecting exists to show the user what they picked, so reveal the drawer
    // whichever host answered.
    requestDrawerOpen("selectPoint", "inspect", {
      chatSessionId: runtime.activeSession?.chatSessionId,
      laneId: point.laneId ?? runtime.activeSession?.laneId,
    });
    emit({ type: "selection", item });
    return { item, source: element?.source ?? "coordinate-fallback" };
  };

  /* ───────────────────────── per-lane devices ───────────────────────── */

  /**
   * The lane whose device a `device-*` call is about.
   *
   * Unlike every other verb this one REFUSES to fall back to the un-laned
   * bucket when a chat names no lane and owns no session: a device created
   * against `""` belongs to no lane, so nothing would ever delete it on
   * archive. Saying so is better than leaking a simulator per chat.
   */
  const requireLaneScope = (
    scope: { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null },
  ): LaneRuntime => {
    const runtime = resolveRuntime(scope);
    if (!runtime.key) {
      throw new Error("Apple devices belong to a lane. Pass --lane, or run this from a chat that is on one.");
    }
    return runtime;
  };

  const deviceCreate = async (deviceArgs: AppleDeviceCreateArgs = {}): Promise<AppleLaneDevice> => {
    assertDarwin();
    const runtime = requireLaneScope(deviceArgs);
    const create = () => laneDevices.deviceCreate({
      laneId: runtime.key,
      from: deviceArgs.from,
      runtime: deviceArgs.runtime,
      deviceType: deviceArgs.deviceType,
      name: deviceArgs.name,
      extra: deviceArgs.extra === true,
    });
    // Extras queue per lane: two at once would both pass the limit check
    // before either row is written.
    const device = deviceArgs.extra === true ? await serializeDeviceLifecycle(runtime, create) : await create();
    invalidateDeviceList();
    invalidateStatus(runtime);
    // An extra device has no pane or `start` of its own: it comes up booted,
    // so the next `--device` command finds it ready.
    if (device.extra) {
      args.captureAnalytics?.("extra_device_created");
      await bootExtraDevice(device);
    }
    return device;
  };

  /**
   * Boot one of a lane's extra devices if it is off, and note that it was used.
   *
   * Answers whether this call booted it, and the sentence to show when ADE
   * had powered it off for being idle: the agent that finds its device was
   * off has to learn why, or it blames its own last command. A boot is only
   * reported once `simctl` lists the device as Booted, after `bootstatus`.
   */
  const bootExtraDevice = async (device: AppleLaneDevice): Promise<{ bootedNow: boolean; notice: string | null }> => {
    const listed = (await listDevices().catch(() => [])).find((entry) => entry.udid === device.udid);
    let bootedNow = false;
    let notice: string | null = null;
    if (listed?.state !== "Booted") {
      const poweredOff = laneMaintenance().readPowerOff(device.udid);
      bootedNow = await power.bootDevice({ udid: device.udid, name: device.name, state: listed?.state ?? "Shutdown" });
      invalidateDeviceList();
      const after = (await listDevices().catch(() => [])).find((entry) => entry.udid === device.udid);
      if (after && after.state !== "Booted") {
        throw new AdeExpectedError(
          `${device.name} did not boot: simctl lists it as ${after.state}. Try again in a few seconds, or delete it with device-delete --device ${device.udid}.`,
          "user",
        );
      }
      if (poweredOff) {
        laneMaintenance().clearPowerOff(device.udid);
        notice = describeDevicePowerOff(poweredOff, device.name, "this command booted it again.");
      }
    }
    laneMaintenance().touch(device.udid);
    return { bootedNow, notice };
  };

  /**
   * Why each of the lane's devices is off, when ADE powered it off: one
   * sentence per device for `status` and `device-list`. A device that is
   * Booted again (by anything) has nothing to explain.
   *
   * `installed` is the device list the caller already read, so a status read
   * that polls (the pane asks every two seconds while a group is open) does not
   * add a `simctl` list of its own; see `computeStatus`.
   */
  const devicePowerOffNotices = async (
    laneId: string,
    installed?: readonly IosSimulatorDevice[],
  ): Promise<string[]> => {
    if (!laneId) return [];
    const devices = laneDevices.list().filter((device) => device.laneId === laneId);
    if (!devices.length) return [];
    const records = devices
      .map((device) => ({ device, record: laneMaintenance().readPowerOff(device.udid) }))
      .filter((entry): entry is { device: AppleLaneDevice; record: AppleDevicePowerOffRecord } => entry.record !== null);
    if (!records.length) return [];
    const listed = installed ?? await listDevices().catch(() => [] as IosSimulatorDevice[]);
    return records
      .filter(({ device }) => listed.find((entry) => entry.udid === device.udid)?.state !== "Booted")
      .map(({ device, record }) => describeDevicePowerOff(
        record,
        device.name,
        device.extra
          ? "the next --device command boots it again."
          : "ade apple start boots it again.",
      ));
  };

  const deviceAttach = async (deviceArgs: AppleDeviceAttachArgs): Promise<AppleLaneDevice> => {
    assertDarwin();
    const runtime = requireLaneScope(deviceArgs);
    const device = await laneDevices.deviceAttach({
      laneId: runtime.key,
      simulator: deviceArgs.simulator,
      agentCaller: deviceArgs.agentCaller === true,
    });
    invalidateStatus(runtime);
    return device;
  };

  /**
   * The picker's one click: attach or create if the lane owns nothing, boot,
   * wait for `bootstatus`, open the live view.
   *
   * `deviceAttach` and `deviceCreate` keep their no-boot semantics for the CLI
   * — an agent provisioning a device is not asking for video — so the boot
   * lives here and in `startStream`, not in the registry. Progress goes out as
   * `apple.device.state` events so the loading card can advance its two
   * segments; the `failed` phase carries the message and the error is still
   * thrown, because the caller's promise is the contract and the event is only
   * the narration.
   */
  /**
   * Run one device-lifecycle step for a lane, with nothing else running.
   *
   * Rejections do not poison the queue: the chain is advanced with a settled
   * promise and the caller gets the original rejection, so a failed boot never
   * wedges every later stop behind it.
   */
  const serializeDeviceLifecycle = <T>(runtime: LaneRuntime, step: () => Promise<T>): Promise<T> => {
    const next = runtime.deviceLifecycleQueue.then(step, step);
    runtime.deviceLifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const deviceStart = async (deviceArgs: AppleDeviceStartArgs = {}): Promise<IosSimulatorStreamStatus> => {
    // Both guards ahead of the queue, in the order they were in before it:
    // "this is not a Mac" and "this call names no lane" are answers this
    // service can give without waiting behind another lane's boot.
    assertDarwin();
    const runtime = requireLaneScope(deviceArgs);
    return serializeDeviceLifecycle(runtime, () => deviceStartStep(deviceArgs));
  };

  const deviceStartStep = async (deviceArgs: AppleDeviceStartArgs = {}): Promise<IosSimulatorStreamStatus> => {
    const runtime = requireLaneScope(deviceArgs);
    const laneId = runtime.key;
    const requestedUdid = deviceArgs.udid?.trim() || null;
    const create = deviceArgs.create ?? null;
    const sourceUdid = create?.sourceUdid?.trim() || null;
    const wantsCreate = Boolean(sourceUdid || create?.runtime?.trim() || create?.deviceType?.trim());
    const agentCaller = deviceArgs.agentCaller === true;
    let laneDevice = laneDevices.get(laneId);
    if (!laneDevice) {
      if (wantsCreate) {
        laneDevice = await laneDevices.deviceCreate({
          laneId,
          from: sourceUdid,
          runtime: create?.runtime ?? null,
          deviceType: create?.deviceType ?? null,
        });
      } else if (requestedUdid) {
        laneDevice = await laneDevices.deviceAttach({ laneId, simulator: requestedUdid, agentCaller });
      } else if (agentCaller) {
        // A device the user released is not replaced behind their back: the
        // agent hears where it went and how to take it back.
        const released = await releasedLaneDeviceStillInstalled(laneId);
        if (released) throw new AppleLaneDeviceReleasedError(released, Date.now());
        // An agent gets its lane's own device rather than an error it has to
        // translate into a second command: a new, empty one, the same one
        // `device-create` makes, so nobody else's device is booted or used.
        laneDevice = await laneDevices.deviceCreate({ laneId });
      } else {
        throw new AdeExpectedError(
          "This lane has no Apple device yet. Run `ade apple device-create` to give it its own, "
            + "or `ade apple start --udid <udid>` to attach an installed simulator.",
          "user",
        );
      }
      // A new device is a simulator the cached device list has never seen.
      invalidateDeviceList();
      invalidateStatus(runtime);
    } else if (requestedUdid && requestedUdid !== laneDevice.udid) {
      const extra = laneDevices.findExtra(laneId, requestedUdid);
      if (extra) throw extraIsNotLaneDeviceError(extra);
      throw new AppleDeviceExistsError(laneDevice);
    }
    const udid = laneDevice.udid;
    const phase = (next: AppleDeviceStatePhase, detail?: string) => {
      emit({ type: "apple.device.state", laneId, udid, phase: next, ...(detail ? { detail } : {}) });
    };
    try {
      phase("starting");
      const device = await resolveDevice(udid, runtime);
      await ensureDeviceBooted(device);
      invalidateStatus(runtime);
      phase("booted");
      // `boot: true`: this IS the explicit start, and a device list cached
      // from before the boot must not read as "off" here.
      const status = await startStream({ laneId, chatSessionId: deviceArgs.chatSessionId ?? null, deviceUdid: udid, boot: true });
      phase("streaming");
      return status;
    } catch (error) {
      phase("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  /**
   * The lane's simulator, powered OFF — `deviceStart`'s actual opposite.
   *
   * Round 4 wired "Close and shut down" to `shutdown`, which is the verb for
   * ending a chat's SESSION: it drops the ownership claim and stops the
   * stream, and the simulator keeps running. The tools card kept reading
   * "ADE Repro · Running", reopening the tab found the device still booted,
   * and the dialog the user had just answered had done nothing they could see.
   * There was no power-off verb anywhere in the service to wire it to — the
   * only `simctl shutdown` in ADE lives in the device hub's
   * `releaseTrackedDevice`, which is reachable only through `closeDevice` and
   * only when a hub device session exists, and the pane's `deviceStart` path
   * never opens one. This is that verb.
   *
   * Three things, in this order, and all three matter:
   *
   * 1. `shutdown` first, which stops the stream and releases the claim — and
   *    carries the cooperative single-owner guard, so `deviceStop` refuses to
   *    power off a device another chat is driving unless told to.
   * 2. The hub's device session, forgotten WITHOUT its own shutdown. It has
   *    its own `simctl shutdown` behind `bootedByAde`, and two shutdowns
   *    racing on one udid is how `simctl` starts reporting states nobody asked
   *    about. The power-off below is unconditional instead, because the user
   *    asked for it by name — "did ADE boot this?" is the right question for
   *    cleanup and the wrong one for an explicit request.
   * 3. `simctl shutdown`, tolerating a device that was already off.
   *
   * The lane device stays REGISTERED. Powering a device off says nothing about
   * which device the lane uses, so the pane's next visit reads
   * "{name} is off. [Start]" rather than dropping back to the picker.
   * `deviceDelete` is the verb that un-registers.
   *
   * Queued against `deviceStart` (see `serializeDeviceLifecycle`) so a start
   * already in flight cannot boot the device back up behind the stop.
   */
  const deviceStop = async (stopArgs: AppleDeviceStopArgs = {}): Promise<AppleDeviceStopResult> => {
    assertDarwin();
    const runtime = resolveRuntime(stopArgs);
    return serializeDeviceLifecycle(runtime, () => deviceStopStep(stopArgs, runtime));
  };

  const deviceStopStep = async (
    stopArgs: AppleDeviceStopArgs,
    runtime: LaneRuntime,
  ): Promise<AppleDeviceStopResult> => {
    const laneDevice = laneDevices.get(runtime.key);
    const udid = stopArgs.udid?.trim() || claimedDeviceUdid(runtime);
    if (!udid) {
      return { udid: null, poweredOff: false, previousState: null, released: false, stillRegistered: false };
    }
    // The lane's session ends only when it is on the device being powered off:
    // a stop that names another udid (the idle pass checked one device, then
    // the lane moved to another) must not tear down the lane's current one.
    const sessionOnDevice = laneDevice?.udid === udid || claimedDeviceUdid(runtime) === udid;
    const released = sessionOnDevice
      ? await shutdown({
        laneId: runtime.laneId,
        chatSessionId: stopArgs.chatSessionId ?? null,
        force: stopArgs.force ?? null,
        ignoreOwnership: stopArgs.ignoreOwnership ?? null,
      })
      : { released: false };
    if (runtime.hub?.getDeviceSession()?.deviceUdid === udid) {
      await runtime.hub.closeDevice({
        deviceUdid: udid,
        chatSessionId: stopArgs.chatSessionId ?? null,
        ignoreOwnership: true,
        // The power-off below is this function's job, not the hub's.
        shutdownDevice: false,
      }).catch((error: unknown) => {
        args.logger.debug("apple.device_stop_close_device_failed", {
          udid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const previousState = await resolveDevice(udid, runtime)
      .then((device) => device.state)
      .catch(() => null);
    // Already off answers false. Any other failure throws: a stop that
    // silently did nothing is exactly the bug this verb exists to fix.
    const poweredOff = await power.powerOffDevice(udid, "power-off");
    invalidateStatus(runtime);
    if (runtime.key) {
      emit({ type: "apple.device.state", laneId: runtime.key, udid, phase: "stopped" });
    }
    args.logger.info("apple.device_stopped", {
      laneId: runtime.key || null,
      udid,
      poweredOff,
      previousState,
    });
    return {
      udid,
      poweredOff,
      previousState,
      released: released.released,
      stillRegistered: Boolean(laneDevice),
    };
  };

  const deviceList = async (deviceArgs: AppleDeviceListArgs = {}): Promise<AppleDeviceListResult> => {
    // No `assertDarwin`: a Windows caller asking what is installed should get
    // an empty list and the lane's (absent) device, not an exception.
    const runtime = resolveRuntime(deviceArgs);
    const notices = process.platform === "darwin" ? await devicePowerOffNotices(runtime.key) : [];
    const result = await laneDevices.deviceList({
      installed: deviceArgs.installed,
      laneId: runtime.key || null,
      // Opt-in: the picker paints its list from the cheap call and asks for the
      // numbers afterwards, so a `du` over a 20 GB device store never sits in
      // front of the first frame of the page.
      disk: deviceArgs.disk,
      runtimes: deviceArgs.runtimes,
    });
    return notices.length ? { ...result, deviceNotices: notices } : result;
  };

  /**
   * The device this lane released, when it is still installed and no lane
   * holds it. An ADE device the cleanup pass deleted, or one another lane
   * took, is gone from the lane's point of view, so this answers null.
   */
  const releasedLaneDeviceStillInstalled = async (laneId: string): Promise<AppleLaneDeviceRelease | null> => {
    const release = laneDevices.lastReleased(laneId);
    if (!release) return null;
    if (laneDevices.list().some((device) => device.udid === release.udid)) return null;
    const installed = await listDevices().catch(() => null);
    // No device list: say nothing rather than block the call on a guess.
    if (!installed?.some((device) => device.udid === release.udid)) return null;
    return release;
  };

  /**
   * The lane's device, created on first ask.
   *
   * `launch` and `open-device` call this: a lane gets no device until it is
   * asked for, and the ask is what creates it. An un-laned caller keeps the old
   * behaviour of driving whatever simulator `resolveDevice` picks, because
   * there is no lane to own a device.
   */
  const ensureLaneDevice = async (runtime: LaneRuntime): Promise<AppleLaneDevice | null> => {
    if (!runtime.key) return null;
    const existing = laneDevices.get(runtime.key);
    if (existing) return existing;
    const created = await laneDevices.ensure({ laneId: runtime.key });
    invalidateDeviceList();
    invalidateStatus(runtime);
    return created;
  };

  /**
   * The cleanup pass, now: the storage view's "Clean up" and `ade apple
   * device-cleanup`. The same pass the background timer runs, plus (with
   * `powerOffIdle`) powering off every ADE device nothing is using.
   *
   * An agent's `powerOffIdle` reaches its own lane's device only. Another
   * lane's device may be between its agent's commands, and powering it off
   * is that lane's call, or the user's.
   */
  const deviceCleanup = async (cleanupArgs: AppleDeviceCleanupArgs = {}): Promise<AppleDeviceCleanupResult> => {
    assertDarwin();
    let onlyUdids: Set<string> | null = null;
    if (cleanupArgs.agentCaller === true) {
      const key = resolveRuntime(cleanupArgs).key;
      const own = laneDevices.get(key);
      // The lane's extra devices are its own too.
      onlyUdids = new Set([...(own ? [own.udid] : []), ...(key ? laneDevices.extras(key).map((device) => device.udid) : [])]);
    }
    const result = await laneMaintenance().runCleanup({ powerOffIdle: cleanupArgs.powerOffIdle === true, onlyUdids });
    invalidateDeviceList();
    for (const runtime of runtimes.values()) invalidateStatus(runtime);
    return result;
  };

  /**
   * A lane is being archived or deleted: let go of its device in this process
   * (recording, stream, chat claim, hub session). The device itself is deleted
   * or released on disk by `releaseLaneAppleDevice`, which runs in hosts that
   * have no simulator service too.
   */
  const stopForLane = async (laneId: string): Promise<void> => {
    const key = laneKey(laneId);
    if (!key) return;
    const device = laneDevices.get(key);
    if (!device) return;
    await lifecycle.releaseLaneHold(device).catch((error: unknown) => {
      args.logger.debug("apple.stop_for_lane_failed", {
        laneId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /* ───────────────────────── tests ───────────────────────── */

  /** Lanes with an `installApp` build in their DerivedData right now. */
  const laneAppInstalls = new Set<string>();

  /**
   * Put the lane's app on one of its devices (usually an extra) and, with
   * `launch`, start it. Nothing of the lane device's session, stream, claim or
   * launch state is touched: this is the build-once, install-on-N path that
   * `launch` (which owns the lane device's session) cannot be.
   *
   * The build goes into the lane's DerivedData, as `launch` does, so a build
   * the lane already has is reused incrementally; `build: false` installs the
   * product the lane last built without running xcodebuild. One build at a
   * time per DerivedData: a launch, a test run or another install on the lane
   * is refused rather than run over.
   */
  const installApp = async (installArgs: AppleInstallAppArgs = {}): Promise<AppleInstallAppResult> => {
    assertDarwin();
    const runtime = requireLaneScope(installArgs);
    const laneDevice = laneDevices.get(runtime.key);
    const wanted = installArgs.deviceUdid?.trim() || null;
    const extra = wanted && wanted !== laneDevice?.udid && wanted !== laneDevice?.name
      ? laneDevices.findExtra(runtime.key, wanted)
      : null;
    if (wanted && !extra && wanted !== laneDevice?.udid && wanted !== laneDevice?.name) {
      throw new AdeExpectedError(
        `${APPLE_DEVICE_NOT_LANE_OWNED_CODE}: ${wanted} is neither this lane's device nor one of its extra devices. `
          + "Run ade apple device-list to see them; device-create --extra adds one.",
        "user",
      );
    }
    const targetUdid = extra?.udid ?? laneDevice?.udid ?? null;
    if (!targetUdid) throw new AdeExpectedError(AGENT_NO_LANE_DEVICE_MESSAGE, "user");
    const projectRoot = await resolveScopedRoot(installArgs);
    const derivedDataPath = appleLaneDerivedDataPath(projectRoot);
    const busy = laneAppInstalls.has(runtime.key)
      ? "another install"
      : runtime.activeLaunchId
        ? "a launch"
        : testRunInFlight?.laneKey === runtime.key
          ? "a test run"
          : activeBuildDataPaths.has(path.resolve(derivedDataPath))
            ? "a build or test run"
            : null;
    if (busy) {
      throw new AdeExpectedError(
        `${APPLE_BUILD_BUSY_CODE}: ${busy} is building in this lane's DerivedData. Two xcodebuilds in one DerivedData break each other; wait for it, then run install again.`,
        "user",
      );
    }
    const configuration = normalizeBuildConfiguration(installArgs.configuration);
    const launchArguments = normalizeLaunchArguments(installArgs.arguments);
    laneAppInstalls.add(runtime.key);
    try {
      if (extra) await bootExtraDevice(extra);
      const device = await resolveDevice(targetUdid, runtime);
      if (!extra) await ensureDeviceBooted(device);
      invalidateDeviceList();
      const target = await resolveLaunchTarget({
        projectRoot,
        laneId: runtime.key,
        targetId: installArgs.targetId ?? null,
        bundleId: installArgs.bundleId ?? null,
        appBundlePath: installArgs.appBundlePath ?? null,
        ...(installArgs.build === false ? { build: false } : {}),
      }, device.udid, projectRoot);
      if (target.target.kind === "installed") {
        throw new AdeExpectedError(
          `${target.target.name} is an installed app, not one this lane builds, so there is nothing to install. Name the lane's app with --target (ade apple apps lists them).`,
          "user",
        );
      }
      const configurationNamed = Boolean(installArgs.configuration?.trim());
      const appBundle = await buildProjectApp(target, device, projectRoot, configuration, configurationNamed || installArgs.build === false);
      if (!appBundle) {
        throw new AdeExpectedError(
          installArgs.build === false
            ? `This lane has no ${configuration} build of ${target.target.name}. Run install without --no-build to build it.`
            : `Could not find ${target.target.name}.app after building.`,
          "user",
        );
      }
      const bundleId = target.bundleId ?? await readPlistValue(path.join(appBundle, "Info.plist"), "CFBundleIdentifier");
      if (!bundleId) throw new Error(`Could not read the bundle identifier of ${appBundle}.`);
      await installTracked(device.udid, bundleId, () => installAppOnSimulator(device, appBundle));
      maintenance?.touch(device.udid);
      let pid: number | null = null;
      if (installArgs.launch) {
        const state = await hub(runtime).relaunchApp({
          deviceUdid: device.udid,
          bundleId,
          arguments: launchArguments,
          laneId: runtime.key,
        });
        pid = state.pid;
      }
      args.logger.info("apple.app_installed_on_device", {
        laneId: runtime.key,
        udid: device.udid,
        extra: Boolean(extra),
        bundleId,
        built: target.shouldBuild,
        launched: Boolean(installArgs.launch),
      });
      return {
        deviceUdid: device.udid,
        deviceName: device.name,
        extra: Boolean(extra),
        bundleId,
        appBundlePath: appBundle,
        configuration,
        built: target.shouldBuild,
        installed: true,
        launched: Boolean(installArgs.launch),
        ...(installArgs.launch ? { pid } : {}),
      };
    } finally {
      laneAppInstalls.delete(runtime.key);
    }
  };

  /** The one test run this service allows at a time: its lane, and the lane and scheme for the busy message. */
  let testRunInFlight: { laneKey: string; label: string } | null = null;

  /**
   * `xcodebuild test` on the lane's own device (`appleTestRun.ts` runs it).
   *
   * One run at a time in this ADE runtime (`APPLE_TEST_RUN_BUSY`): agents'
   * `ade apple` calls all reach the brain, so that is one queue per Mac in
   * practice.
   */
  const runTests = async (testArgs: AppleRunTestsArgs = {}): Promise<AppleRunTestsResult> => {
    assertDarwin();
    const runtime = requireLaneScope(testArgs);
    if (testRunInFlight) {
      throw new Error(
        `${APPLE_TEST_RUN_BUSY_CODE}: a test run is already going in this ADE runtime (${testRunInFlight.label}). `
          + "xcodebuild test runs one at a time; wait for it to finish, then run again.",
      );
    }
    // Claimed before the first await. A device boot takes tens of seconds, and
    // a second run that slipped in behind it ran a second xcodebuild into the
    // same DerivedData, which broke package resolution for both.
    if (laneAppInstalls.has(runtime.key)) {
      throw new AdeExpectedError(
        `${APPLE_BUILD_BUSY_CODE}: an \`ade apple install\` is building in this lane's DerivedData. Wait for it, then run the tests again.`,
        "user",
      );
    }
    testRunInFlight = { laneKey: runtime.key, label: `lane ${runtime.key}` };
    try {
      return await runTestsClaimed(testArgs, runtime);
    } finally {
      testRunInFlight = null;
    }
  };

  /** Which project and scheme to test: a launch target, a named project, or the first target that has a scheme. */
  const resolveTestTarget = async (
    testArgs: AppleRunTestsArgs,
    projectRoot: string,
  ): Promise<{ projectPath: string; scheme: string; bundleId: string | null }> => {
    const targets = await listProjectLaunchTargets(projectRoot);
    let projectPath: string | null = null;
    let scheme: string | null = testArgs.scheme?.trim() || null;
    let bundleId: string | null = null;
    if (testArgs.targetId?.trim()) {
      assertTargetIdWithinRoot(testArgs.targetId, projectRoot);
      const target = targets.find((candidate) => candidate.id === testArgs.targetId)
        ?? recoverStaleLaunchTarget(testArgs.targetId, targets, projectRoot);
      if (!target?.projectPath || !target.scheme) {
        throw new Error(`Launch target ${testArgs.targetId} was not found under ${projectRoot}. Run \`ade apple apps\` and pass one of its ids.`);
      }
      ({ projectPath, scheme, bundleId } = target);
    } else if (testArgs.projectPath?.trim()) {
      const raw = testArgs.projectPath.trim();
      const resolved = path.resolve(projectRoot, raw);
      if (!isPathInside(resolved, projectRoot)) {
        throw new Error(`${IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE}: ${raw} is outside the build root ${projectRoot}.`);
      }
      // `-project` or `-workspace`: both are directories xcodebuild opens.
      if (!/\.(xcodeproj|xcworkspace)$/u.test(resolved) || !fs.existsSync(resolved)) {
        throw new Error(`No .xcodeproj or .xcworkspace at ${raw} under ${projectRoot}.`);
      }
      projectPath = relativeToRoot(projectRoot, resolved);
      bundleId = targets.find((candidate) => candidate.projectPath === projectPath && candidate.scheme === scheme)?.bundleId ?? null;
    } else {
      const first = targets.find((candidate) => candidate.projectPath && candidate.scheme && (!scheme || candidate.scheme === scheme));
      projectPath = first?.projectPath ?? null;
      scheme ??= first?.scheme ?? null;
      bundleId = first?.bundleId ?? null;
    }
    if (!projectPath || !scheme) {
      throw new Error(`${IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE}: no Xcode project and scheme to test under ${projectRoot}. Pass --scheme and --project.`);
    }
    return { projectPath, scheme, bundleId };
  };

  const runTestsClaimed = async (testArgs: AppleRunTestsArgs, runtime: LaneRuntime): Promise<AppleRunTestsResult> => {
    const projectRoot = await resolveScopedRootForSession(testArgs, runtime);
    const { projectPath, scheme, bundleId } = await resolveTestTarget(testArgs, projectRoot);
    const derivedDataPath = appleLaneDerivedDataPath(projectRoot);
    testRunInFlight = { laneKey: runtime.key, label: `lane ${runtime.key}, scheme ${scheme}` };
    // The DerivedData is the run's from here, before the device boot, which
    // takes tens of seconds: an install or a cleaner during the boot sees it.
    const releaseBuildPath = claimBuildDataPath(derivedDataPath);
    let device: IosSimulatorDevice | null = null;
    let result: AppleRunTestsResult;
    try {
      const laneDevice = await ensureLaneDevice(runtime);
      if (!laneDevice) throw new AdeExpectedError(AGENT_NO_LANE_DEVICE_MESSAGE, "user");
      const target = await resolveDevice(laneDevice.udid, runtime);
      device = target;
      await ensureDeviceBooted(target);
      activeTestUdids.add(target.udid);
      args.logger.info("apple.tests.start", { laneId: runtime.key, udid: target.udid, projectPath, scheme, derivedDataPath });
      // Same guard as a launch build: package state that names another folder goes first.
      healMovedDerivedData(derivedDataPath, projectRoot, args.logger);
      // xcodebuild installs the app under test; on an attached device it is
      // ADE's to remove later only when it was not there before.
      result = await installTracked(target.udid, bundleId, () => (
        runXcodebuildTests({ projectRoot, projectPath, scheme, device: target, derivedDataPath, testArgs, spawnProcess })
      ));
    } finally {
      releaseBuildPath();
      if (device) {
        activeTestUdids.delete(device.udid);
        maintenance?.touch(device.udid);
      }
    }
    args.logger.info("apple.tests.complete", {
      laneId: runtime.key,
      udid: result.deviceUdid,
      passed: result.passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      testsExecuted: result.testsExecuted,
      testsFailed: result.testsFailed,
      durationMs: result.durationMs,
    });
    return result;
  };

  /* ───────────────────────── recording ───────────────────────── */

  /**
   * Stop the recording on a device before the device goes away.
   *
   * The helper keeps one recording slot per device, and nothing on the device
   * side ends it: a recording outlives a power-off, and afterwards every
   * `record-start` on that device is refused. Never allowed to fail the caller —
   * the power-off, delete or takeover the user asked for still happens.
   */
  const stopDeviceRecording = async (udid: string, reason: "device-off" | "released"): Promise<void> => {
    await recordings.stopDevice({ udid, reason }).catch((error: unknown) => {
      args.logger.warn("apple.recording_device_stop_failed", {
        udid,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const recordStart = async (recordArgs: AppleRecordStartArgs = {}): Promise<SimRecording> => {
    assertDarwin();
    const runtime = requireLaneScope(recordArgs);
    const udid = await resolveControlDeviceUdid(null, runtime);
    return recordings.start({
      laneId: runtime.key,
      udid,
      chatSessionId: recordArgs.chatSessionId ?? runtime.activeSession?.chatSessionId ?? null,
      overlays: recordArgs.overlays ?? undefined,
      label: recordArgs.label ?? undefined,
      keepIdle: recordArgs.keepIdle ?? undefined,
      plain: recordArgs.plain ?? undefined,
      zoom: recordArgs.zoom ?? undefined,
      maxSeconds: recordArgs.maxSeconds ?? undefined,
    });
  };

  const recordStop = async (recordArgs: AppleRecordStopArgs = {}): Promise<SimRecording | null> => {
    const runtime = requireLaneScope(recordArgs);
    return recordings.stop({
      laneId: runtime.key,
      keep: recordArgs.keep ?? undefined,
      discard: recordArgs.discard ?? undefined,
      chatSessionId: recordArgs.chatSessionId ?? runtime.activeSession?.chatSessionId ?? null,
      // Resolved without a boot or a fallback to another lane's device: the
      // helper is asked about THIS lane's device only.
      udid: claimedDeviceUdid(runtime),
    });
  };

  const recordList = async (recordArgs: AppleRecordListArgs = {}): Promise<SimRecording[]> => {
    const runtime = requireLaneScope(recordArgs);
    return recordings.list({ laneId: runtime.key });
  };

  /**
   * Bytes of recordings on disk, for the Diagnostics warning row.
   *
   * Lane-optional on purpose: the Settings row is project-wide, and it asked
   * this question by walking `.ade/artifacts/apple-recordings/` through the
   * files API — a recursive tree listing to add up numbers the recorder already
   * has in its sidecars. Warn-only either way; this is just the cheap answer.
   *
   * No `requireLaneScope`: a lane-less caller wants the project total, and a
   * Settings pane that had to name a lane to read a project number would be
   * asking the wrong question.
   */
  const recordingsTotalBytes = async (
    recordArgs: { laneId?: string | null } = {},
  ): Promise<number> => {
    const laneId = typeof recordArgs.laneId === "string" ? recordArgs.laneId.trim() : "";
    return recordings.totalBytes(laneId ? { laneId } : undefined);
  };

  const recordDelete = async (recordArgs: AppleRecordDeleteArgs): Promise<void> => {
    const runtime = requireLaneScope(recordArgs);
    return recordings.remove({
      laneId: runtime.key,
      id: recordArgs.id,
      chatSessionId: recordArgs.chatSessionId ?? runtime.activeSession?.chatSessionId ?? null,
      force: recordArgs.force ?? undefined,
      allowProof: recordArgs.allowProof ?? undefined,
    });
  };

  /* ───────────────────────── maintenance ───────────────────────── */

  const isBusyHere = (udid: string): boolean => {
    if (activeTestUdids.has(udid)) return true;
    for (const runtime of runtimes.values()) {
      if (runtime.streamStatus.running && runtime.streamStatus.deviceUdid === udid) return true;
      const laneUdid = runtime.key ? laneDevices.get(runtime.key)?.udid ?? null : null;
      if (laneUdid !== udid) continue;
      if (runtime.activeLaunchId) return true;
      if (recordings.active({ laneId: runtime.key })) return true;
    }
    return false;
  };

  const laneMaintenance = () => {
    maintenance ??= createLaneDeviceMaintenance({
      laneDevices,
      run: (command, commandArgs, options) => run(command, commandArgs, options),
      // `deviceStop` for the lane, as the owner's Stop would: the stream and the
      // chat claim go first, then the power. The device stays the lane's.
      // The udid the pass checked, not whatever the lane holds by now.
      powerOffDevice: async (device) => {
        // An extra device has no stream or claim of its own to stop first.
        if (device.extra) {
          await power.powerOffDevice(device.udid, "power-off");
          return;
        }
        await deviceStop({ laneId: device.laneId, udid: device.udid, ignoreOwnership: true });
      },
      isBusyHere,
      logger: args.logger,
    });
    return maintenance;
  };
  if (args.backgroundMaintenance && process.platform === "darwin" && args.laneDeviceStore) {
    laneMaintenance().start();
  }

  /* ───────────────────────── simulator runtimes ───────────────────────── */

  let runtimeManagerInstance: AppleRuntimeManager | null = null;
  const runtimeManager = (): AppleRuntimeManager => {
    runtimeManagerInstance ??= createAppleRuntimeManager({
      run: (command, commandArgs, options) => run(command, commandArgs, options),
      spawn: (command, commandArgs) => spawnProcess(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] }),
      emit,
      logger: args.logger,
      freeBytes: async () => {
        const stats = await fs.promises.statfs(os.homedir());
        return Number(stats.bavail) * Number(stats.bsize);
      },
      laneHeldUdids: () => new Set(laneDevices.list().map((device) => device.udid)),
      isAdeSimulator: (udid) => readAppleDeviceMarker(appleDeviceDataRoot(), udid) !== null,
      powerOff: async (udid) => {
        await lifecycle.releaseUnlanedHolds(udid);
        await power.powerOffDevice(udid, "delete");
      },
      invalidate: () => {
        invalidateDeviceList();
        for (const runtime of runtimes.values()) invalidateStatus(runtime);
      },
      releasesFeed: async () => {
        const response = await fetch(APPLE_RELEASES_FEED_URL, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
      store: args.laneDeviceStore ?? null,
      captureAnalytics: (outcome) => args.captureAnalytics?.(outcome),
    });
    return runtimeManagerInstance;
  };
  /** Every runtime action is macOS-only, and runs against the machine's one manager. */
  const darwinRuntimeManager = (): AppleRuntimeManager => {
    assertDarwin();
    return runtimeManager();
  };

  /**
   * The one place an agent's device is decided, for every action below.
   *
   * With `agentCaller` (set by the RPC server, never by the agent), an action
   * that drives or reads a device acts on the lane's own device and nothing
   * else. An explicit `deviceUdid`/`udid` naming any other simulator is
   * refused, and a lane with no device is refused rather than falling back to
   * "the first booted iPhone" — which is how an agent once drove a simulator
   * another session's test run was using. `launch`, `openDevice` and
   * `runTests` make the lane's device instead, as they always did on first ask. The lane's device
   * udid is then passed in as `deviceUdid`, so no inner fallback can pick a
   * different one. User callers pass straight through.
   */
  const guardAgentDeviceActions = <T extends Record<string, unknown>>(service: T): T => {
    const guarded: Record<string, unknown> = { ...service };
    const refuseForeign = async (udid: string): Promise<never> => {
      const known = (await listDevices().catch(() => [])).find((device) => device.udid === udid);
      throw new AppleDeviceNotLaneOwnedError(
        { udid, name: known?.name ?? "that simulator" },
        known?.state === "Booted" ? { kind: "running" } : { kind: "not-created" },
      );
    };
    const wrap = (action: string, mode: "drive" | "check") => {
      const original = service[action];
      if (typeof original !== "function") return;
      guarded[action] = async (actionArgs: Record<string, unknown> | undefined, ...rest: unknown[]) => {
        if (!actionArgs || actionArgs.agentCaller !== true) {
          return (original as (...params: unknown[]) => unknown)(actionArgs, ...rest);
        }
        const { agentCaller: _agent, ...callArgs } = actionArgs;
        const runtime = resolveRuntime(callArgs as { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null });
        if (!runtime.key) {
          throw new Error(`ios_simulator.${action} needs a lane: run ade from a lane worktree, or pass --lane <lane-id>.`);
        }
        const explicit = [callArgs.deviceUdid, callArgs.udid]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .find(Boolean) ?? null;
        let laneDevice = laneDevices.get(runtime.key);
        // One of the lane's extra devices (`device-create --extra`), named by
        // udid or name: the call runs on it, booted first.
        const extra = explicit && explicit !== laneDevice?.udid ? laneDevices.findExtra(runtime.key, explicit) : null;
        if (extra) {
          if (AGENT_EXTRA_DEVICE_REFUSED_ACTIONS.has(action)) {
            throw new AdeExpectedError(
              `${APPLE_DEVICE_IS_EXTRA_CODE}: ios_simulator.${action} runs on the lane's own device (its live view, claim, `
              + `recordings and builds), not on the extra device ${extra.name}. On an extra, use screenshot, snapshot, tap, `
              + "rotate, relaunch and the other per-device commands with --device; delete it with device-delete --device <udid>. "
              + (action === "launch"
                ? `To build and install the lane's app on ${extra.name} (and start it), run: ade apple install --device ${extra.udid} --launch. `
                : "")
              + `To make ${extra.name} the lane's device, run: ade apple device-promote --device ${extra.udid}`,
              "user",
            );
          }
          if (mode === "check") {
            // A read names the extra too: it is in use, so the idle timer
            // must not power it off under the agent.
            laneMaintenance().touch(extra.udid);
          }
          const booted = mode === "drive" ? await bootExtraDevice(extra) : { bootedNow: false, notice: null };
          if (action === "openDevice") {
            // `boot --device <extra>`: the boot is the whole job. It is not a
            // device session (that is the lane device's live view), so the
            // hub is never pointed at the extra, and the answer is what
            // `simctl` lists after `bootstatus`, not what was asked for.
            return {
              deviceUdid: extra.udid,
              deviceName: extra.name,
              chatSessionId: null,
              laneId: runtime.key,
              openedAt: nowIso(),
              bootedByAde: booted.bootedNow,
              state: "Booted",
              extra: true,
              ...(booted.notice ? { deviceNotice: booted.notice } : {}),
            };
          }
          const onExtra = { ...callArgs, deviceUdid: extra.udid, ...(callArgs.udid !== undefined ? { udid: extra.udid } : {}) };
          const result = await (original as (...params: unknown[]) => unknown)(onExtra, ...rest);
          return booted.notice && isPlainResultObject(result) ? { ...result, deviceNotice: booted.notice } : result;
        }
        if (explicit && explicit !== laneDevice?.udid) await refuseForeign(explicit);
        if (!laneDevice && mode === "drive") {
          const released = await releasedLaneDeviceStillInstalled(runtime.key);
          if (released) throw new AppleLaneDeviceReleasedError(released, Date.now());
          if (AGENT_DEVICE_CREATING_ACTIONS.has(action)) {
            laneDevice = await ensureLaneDevice(runtime);
          } else {
            throw new AdeExpectedError(AGENT_NO_LANE_DEVICE_MESSAGE, "user");
          }
        }
        const pinned = mode === "drive" && laneDevice ? { ...callArgs, deviceUdid: laneDevice.udid } : callArgs;
        return (original as (...params: unknown[]) => unknown)(pinned, ...rest);
      };
    };
    for (const action of AGENT_DEVICE_DRIVING_ACTIONS) wrap(action, "drive");
    for (const action of AGENT_DEVICE_CHECKED_ACTIONS) wrap(action, "check");
    return guarded as T;
  };

  return guardAgentDeviceActions({
    getStatus,
    getControlOwner,
    getClaimedDevice,
    claim,
    listDevices,
    listLaunchTargets,
    launch,
    attachToChatSession,
    releaseIfOwnedBy,
    shutdown,
    screenshot,
    getScreenSnapshot,
    getInspectorSnapshot: readInspectorSnapshot,
    inspectPoint,
    getPreviewCapability,
    listPreviewTargets,
    resolvePreviewMatch,
    ensurePreviewWorkspace,
    renderCurrentPreview,
    renderPreview,
    openPreviewWorkspace,
    startStream,
    stopStream,
    getStreamStatus,
    /** Is a renderer on this machine still watching this lane's stream? */
    hasLocalViewer,
    setRemoteViewerProbe,
    /** The relay's last remote viewer left; a local one still watches. */
    liftStreamBitrateCap,
    capLiveStream,
    frame,
    tap,
    /** A press held at one point: context menus (`ade apple long-press`). */
    longPress,
    /** A live finger's begin/move/end, for a person driving from a viewer. */
    touch,
    pressButton,
    rotate,
    /* Foldables (the iPhone Duo): fold to a pose or angle, read the pose. */
    setPosture: duo.setPosture,
    getPosture: duo.getPosture,
    getDuoModel: duo.getDuoModel,
    duoAppStoreScreenshots: duo.duoAppStoreScreenshots,
    addDuoSkill: duo.addDuoSkill,
    attachRenderProof: duo.attachRenderProof,
    requestRender: duo.requestRender,
    renderAck: duo.renderAck,
    renderComplete: duo.renderComplete,
    typeText,
    pressKey,
    drag,
    swipe: (input: IosSimulatorDragArgs) => drag(input, "swipe"),
    /** The helper's re-anchoring scroll gesture, by viewport direction. */
    scroll,
    selectPoint,

    /* Per-lane devices: one simulator per lane, created on first ask. */
    deviceCreate,
    deviceAttach,
    /** Attach-or-create, boot, `bootstatus`, then `startStream`. The picker's one click. */
    deviceStart,
    /** Power the lane's simulator off and leave it registered. Not `shutdown`. */
    deviceStop,
    deviceList,
    deviceDelete: lifecycle.deviceDelete,
    /** Unbind the lane's device and keep the simulator. The off card's "Choose another device". */
    deviceDetach: lifecycle.deviceDetach,
    /** One of the lane's extra devices becomes its own; the old one is kept. */
    devicePromote: lifecycle.devicePromote,
    deviceDeleteInstalled: lifecycle.deviceDeleteInstalled,
    /** The cleanup pass now, plus an optional power-off of idle ADE devices. */
    deviceCleanup,

    /* Simulator runtimes: list, install the one this Xcode expects, remove old ones. */
    runtimeList: async () => darwinRuntimeManager().runtimeList(),
    runtimeInstall: async (installArgs: AppleRuntimeInstallArgs = {}) => darwinRuntimeManager().runtimeInstall(installArgs),
    runtimeInstallCancel: async () => darwinRuntimeManager().runtimeInstallCancel(),
    runtimeDelete: async (deleteArgs: AppleRuntimeDeleteArgs) => darwinRuntimeManager().runtimeDelete(deleteArgs),
    runtimePrune: async (pruneArgs: AppleRuntimePruneArgs) => darwinRuntimeManager().runtimePrune(pruneArgs),
    xcodeRunFirstLaunch: async (setupArgs: { confirmedByUser?: boolean } = {}) =>
      darwinRuntimeManager().xcodeRunFirstLaunch(setupArgs),
    /** The lane is being archived or deleted: let go of its device in this process. */
    stopForLane,

    /* Tests on the lane's own device, DerivedData in the lane's cache. */
    runTests,

    /* Recording (unit 2C owns the implementation). */
    recordStart,
    recordStop,
    recordList,
    recordDelete,
    recordingsTotalBytes,

    /* Device hub: a booted simulator with no app of its own. */
    openDevice: async (deviceArgs: IosSimulatorOpenDeviceArgs = {}) => {
      const runtime = resolveRuntime(deviceArgs);
      // First ask creates the lane's device. Without this an `open-device` on a
      // fresh lane opened whatever simulator was booted — usually another
      // lane's — which is the exact collision per-lane devices exist to stop.
      const laneDevice = deviceArgs.deviceUdid ? null : await ensureLaneDevice(runtime);
      return darwinHub(deviceArgs).openDevice({
        ...deviceArgs,
        deviceUdid: deviceArgs.deviceUdid ?? laneDevice?.udid ?? null,
      });
    },
    closeDevice: async (deviceArgs: IosSimulatorCloseDeviceArgs = {}) => darwinHub(deviceArgs).closeDevice(deviceArgs),
    getDeviceSession: async (scope: { laneId?: string | null; chatSessionId?: string | null } = {}) => darwinHub(scope).getDeviceSession(),

    /* Device hub: typed device state, in place of a human clicking Settings. */
    getDeviceSettings: async (toolArgs: IosSimulatorDeviceArgs = {}) => darwinHub(toolArgs).getDeviceSettings(toolArgs),
    setAppearance: async (toolArgs: IosSimulatorSetAppearanceArgs) => darwinHub(toolArgs).setAppearance(toolArgs),
    setContentSize: async (toolArgs: IosSimulatorSetContentSizeArgs) => darwinHub(toolArgs).setContentSize(toolArgs),
    setAccessibilityOption: async (toolArgs: IosSimulatorSetAccessibilityArgs) => darwinHub(toolArgs).setAccessibilityOption(toolArgs),
    setLocation: async (toolArgs: IosSimulatorSetLocationArgs) => darwinHub(toolArgs).setLocation(toolArgs),
    clearLocation: async (toolArgs: IosSimulatorDeviceArgs = {}) => darwinHub(toolArgs).clearLocation(toolArgs),
    setPermission: async (toolArgs: IosSimulatorSetPermissionArgs) => darwinHub(toolArgs).setPermission(toolArgs),
    sendPushNotification: async (toolArgs: IosSimulatorPushArgs) => darwinHub(toolArgs).sendPushNotification(toolArgs),
    openUrl: async (toolArgs: IosSimulatorOpenUrlArgs) => {
      const runtime = resolveRuntime(toolArgs);
      const result = await darwinHub(toolArgs).openUrl(toolArgs);
      // `open-url` is an injected input under the auto-record contract: it is
      // how an agent drives a deeplink, and the video has to show it.
      const udid = await resolveControlDeviceUdid(toolArgs.deviceUdid, runtime).catch(() => null);
      if (udid) noteInput(runtime, { udid, kind: "open-url", text: toolArgs.url, source: toolArgs.source, noRecord: toolArgs.noRecord });
      return result;
    },
    relaunchApp: async (toolArgs: IosSimulatorRelaunchArgs) => darwinHub(toolArgs).relaunchApp(toolArgs),
    terminateApp: async (toolArgs: IosSimulatorAppLifecycleArgs) => darwinHub(toolArgs).terminateApp(toolArgs),
    uninstallApp: async (toolArgs: IosSimulatorUninstallAppArgs) => darwinHub(toolArgs).uninstallApp(toolArgs),
    setStatusBar: async (toolArgs: IosSimulatorStatusBarArgs) => darwinHub(toolArgs).setStatusBar(toolArgs),
    clearStatusBar: async (toolArgs: IosSimulatorDeviceArgs = {}) => darwinHub(toolArgs).clearStatusBar(toolArgs),
    getAppState: async (toolArgs: IosSimulatorAppLifecycleArgs) => darwinHub(toolArgs).getAppState(toolArgs),
    /**
     * The app in front of the simulator, from the helper's accessibility
     * bridge rather than from what ADE last launched. SpringBoard alone, or a
     * device that has not finished booting, reads as `null`, not as an error:
     * the drawer asks every couple of seconds and an empty home screen is a
     * normal answer.
     *
     * `waitMs` keeps asking (up to 30 s) until an app is in front: an app
     * launched a moment ago is not yet the accessibility tree's frontmost.
     */
    getForegroundApp: async (
      arg: { deviceUdid?: string | null; laneId?: string | null; chatSessionId?: string | null; waitMs?: number | null } = {},
    ): Promise<IosSimulatorForegroundApp> => {
      assertDarwin();
      const udid = await resolveControlDeviceUdid(arg.deviceUdid, resolveRuntime(arg));
      const readFrontmost = async (): Promise<IosSimulatorForegroundApp> => {
        let payload: Record<string, unknown>;
        try {
          payload = await helper().send({ type: "ax-frontmost", udid });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/frontmost application|not booted/i.test(message)) return null;
          throw error;
        }
        const app = payload.app;
        if (!app || typeof app !== "object") return null;
        const bundleId = (app as { bundleId?: unknown }).bundleId;
        if (typeof bundleId !== "string" || !bundleId || bundleId === "com.apple.springboard") return null;
        const pid = (app as { pid?: unknown }).pid;
        return { bundleId, pid: typeof pid === "number" && pid > 0 ? pid : null, checkedAt: nowIso() };
      };
      const waitMs = Math.min(Math.max(Number(arg.waitMs) || 0, 0), 30_000);
      const deadline = Date.now() + waitMs;
      for (;;) {
        const app = await readFrontmost();
        if (app || Date.now() >= deadline) return app;
        await delay(Math.min(500, Math.max(0, deadline - Date.now())));
      }
    },

    /*
     * Turns on one of the lane's devices for the agents that share it
     * (advisory: see `appleDeviceLease.ts`). One lease per device: the lane's
     * own device, and each extra (`deviceUdid`) on its own, so a build on the
     * iPhone never waits on a screenshot of the iPad beside it.
     */
    deviceLease: async (leaseArgs: {
      laneId?: string | null;
      chatSessionId?: string | null;
      holder?: string | null;
      ttlMs?: number | null;
      waitMs?: number | null;
      deviceUdid?: string | null;
      token?: string | null;
      distinct?: boolean | null;
      /** Set by the RPC server: aborted when the caller's connection closes. */
      connectionSignal?: AbortSignal | null;
    } = {}) => {
      const runtime = resolveRuntime(leaseArgs);
      const target = leaseTarget(runtime, leaseArgs.deviceUdid);
      const holder = leaseArgs.holder?.trim() || leaseArgs.chatSessionId?.trim() || "agent";
      const signal = leaseArgs.connectionSignal instanceof AbortSignal ? leaseArgs.connectionSignal : null;
      const result = await deviceLeases.acquire({
        key: target.key,
        holder,
        chat: leaseArgs.chatSessionId,
        ttlMs: leaseArgs.ttlMs,
        waitMs: leaseArgs.waitMs,
        token: leaseArgs.token,
        distinct: leaseArgs.distinct === true,
        signal,
      });
      if (signal?.aborted && result.acquired && !result.renewed && result.token) {
        // Granted as the caller went away: nobody will ever see this token,
        // so the next in line gets the device now instead of after the TTL.
        deviceLeases.release({ key: target.key, token: result.token });
        return { acquired: false as const, current: null, queued: 0, device: target.device };
      }
      // A new turn, not a renewal or a busy answer: agents taking turns.
      if (result.acquired && !result.renewed) args.captureAnalytics?.("device_leased");
      return { ...result, device: target.device };
    },
    /*
     * The token is the turn: it is released on whichever of this lane's
     * devices holds it, even one that has since left the lane, so a stale
     * `--device` (or none, from an older CLI) never strands a lease.
     */
    deviceLeaseRelease: async (leaseArgs: { laneId?: string | null; chatSessionId?: string | null; token?: string | null; deviceUdid?: string | null } = {}) => {
      const token = leaseArgs.token?.trim();
      if (!token) throw new AdeExpectedError("A lease release needs the token `apple lease` printed: ade apple lease release --token <t>.", "user");
      const runtime = resolveRuntime(leaseArgs);
      const ownKey = appleDeviceLeaseKey(runtime.key, null);
      const key = deviceLeases.keyOfToken(token, (candidate) => candidate === ownKey || candidate.startsWith(`${ownKey}\u0000`));
      if (!key) {
        return {
          released: false,
          device: null,
          reason: "This token holds no lease on this lane's devices. It was released already, it lapsed (a lease lasts its --ttl unless renewed), "
            + "or it is from another lane. Run ade apple lease status to see who has the device.",
        };
      }
      deviceLeases.release({ key, token });
      if (key === ownKey) {
        const own = runtime.key ? laneDevices.get(runtime.key) : null;
        return { released: true, device: { udid: own?.udid ?? null, name: own?.name ?? null, extra: false } };
      }
      const udid = key.slice(ownKey.length + 1);
      const extra = laneDevices.findExtra(runtime.key, udid);
      return { released: true, device: { udid, name: extra?.name ?? null, extra: true } };
    },
    deviceLeaseStatus: async (leaseArgs: { laneId?: string | null; chatSessionId?: string | null; deviceUdid?: string | null } = {}) => {
      const runtime = resolveRuntime(leaseArgs);
      const target = leaseTarget(runtime, leaseArgs.deviceUdid);
      return { ...deviceLeases.status(target.key), device: target.device };
    },

    /*
     * Whether agent input on this lane starts an automatic recording. On by
     * default; `ade apple auto-record off` turns it off for the lane, in the
     * project's KV, so it outlasts a restart. The machine-wide switch is the
     * "Record agent input" setting (Settings ▸ Apple Development).
     */
    installApp,
    windowLayout,
    getAutoRecord: async (recordArgs: { laneId?: string | null; chatSessionId?: string | null } = {}) => {
      const runtime = resolveRuntime(recordArgs);
      return autoRecordState(runtime.key);
    },
    setAutoRecord: async (recordArgs: { laneId?: string | null; chatSessionId?: string | null; enabled?: boolean | null } = {}) => {
      const runtime = resolveRuntime(recordArgs);
      if (!runtime.key) throw new AdeExpectedError("auto-record is a lane setting: run it from a lane worktree, or pass --lane <lane-id>.", "user");
      if (typeof recordArgs.enabled !== "boolean") throw new AdeExpectedError("auto-record needs on or off.", "user");
      if (!args.laneDeviceStore) throw new AdeExpectedError("This runtime has no project database, so it cannot keep a lane setting.", "environment");
      args.laneDeviceStore.setJson(appleAutoRecordKey(runtime.key), { enabled: recordArgs.enabled, at: nowIso() });
      args.logger.info("apple.auto_record_set", { laneId: runtime.key, enabled: recordArgs.enabled });
      return autoRecordState(runtime.key);
    },

    /* Device hub: the app's own log, interleaved with what ADE did. */
    startEventLog: async (logArgs: IosSimulatorStartEventLogArgs) => darwinHub(logArgs).startEventLog(logArgs),
    stopEventLog: async (logArgs: IosSimulatorStopEventLogArgs = {}) => darwinHub(logArgs).stopEventLog(logArgs),
    getEventLog: async (logArgs: IosSimulatorEventLogArgs = {}) => darwinHub(logArgs).getEventLog(logArgs),

    /* Device hub: name an element instead of guessing a pixel. */
    findElement: async (elementArgs: IosSimulatorFindElementArgs) => darwinHub(elementArgs).findElement(elementArgs),
    tapElement: async (elementArgs: IosSimulatorTapElementArgs) => darwinHub(elementArgs).tapElement(elementArgs),
    fillElement: async (elementArgs: IosSimulatorFillElementArgs) => darwinHub(elementArgs).fillElement(elementArgs),
    waitForElement: async (elementArgs: IosSimulatorWaitForElementArgs) => darwinHub(elementArgs).waitForElement(elementArgs),
    assertVisible: async (elementArgs: IosSimulatorAssertVisibleArgs) => darwinHub(elementArgs).assertVisible(elementArgs),

    /* Device hub: a screenshot a reviewer can believe. */
    captureProofBundle: async (proofArgs: IosSimulatorProofBundleArgs = {}) => {
      const runtime = resolveRuntime(proofArgs);
      const bundle = await darwinHub(proofArgs).captureProofBundle(proofArgs);
      // Per the auto-record contract: proof-bundle pins the active recording,
      // or this chat's most recent one, and pinning is what makes it
      // undeletable by any agent.
      if (runtime.key) {
        await recordings.pinActiveOrLatest({
          laneId: runtime.key,
          chatSessionId: proofArgs.chatSessionId ?? runtime.activeSession?.chatSessionId ?? null,
        }).catch((error: unknown) => {
          args.logger.debug("apple.proof_pin_failed", {
            laneId: runtime.key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      /*
       * File the bundle's own screen as the artifact.
       *
       * `ade apple proof-bundle` is documented as a proof verb — the skill
       * lists it beside `screenshot` under "proof is automatic" — and it filed
       * NOTHING. It wrote a directory and returned. An agent that ran it and
       * reported proof was wrong, and the only reason that was ever noticed is
       * that one went on to `proof attach` the screenshot by hand.
       *
       * The inner screenshot still runs with `proof: false`, so this is the
       * one row for the capture rather than a second one. The bundle's other
       * halves — elements, log, metadata — travel as metadata on it, because
       * the drawer shows a picture and a reviewer opening it wants the path to
       * the rest.
       */
      const proofArtifactId = fileScreenshotAsProof(
        {
          deviceUdid: bundle.deviceUdid,
          filePath: bundle.screenshotPath,
          capturedAt: bundle.capturedAt,
          width: bundle.width,
          height: bundle.height,
        },
        {
          ...proofArgs,
          ...(bundle.caption ? { caption: bundle.caption } : {}),
        },
        runtime,
      );
      return { ...bundle, proofArtifactId };
    },

    getLastSelectedItem: () => lastSelectedItem,
    isBuildPathActive: (candidatePath: string) => activeBuildDataPaths.has(path.resolve(candidatePath)),
    dispose: () => {
      disposed = true;
      deviceLeases.dispose();
      maintenance?.stop();
      runtimeManagerInstance?.dispose();
      for (const held of liveTouches.values()) clearTimeout(held.release);
      liveTouches.clear();
      for (const runtime of runtimes.values()) {
        runtime.hub?.dispose();
        runtime.hub = null;
        setStreamStopped(runtime, null);
        runtime.activeSession = null;
        runtime.activeLaunchId = null;
      }
      runtimes.clear();
      recordings.dispose();
      helperEventListeners.clear();
      helperClient?.dispose();
      helperClient = null;
      launchOwners.clear();
      activeBuildDataPaths.clear();
      toolAvailabilityCache.clear();
      if (xcodeMcpBridge) {
        const bridge = xcodeMcpBridge;
        xcodeMcpBridge = null;
        disposeXcodeMcpBridge(bridge, new Error("iOS simulator service disposed."));
      }
    },
  });
}
