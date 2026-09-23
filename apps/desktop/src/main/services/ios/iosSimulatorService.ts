import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppleDeviceAttachArgs,
  AppleDeviceStartArgs,
  AppleDeviceStatePhase,
  AppleDeviceStopArgs,
  AppleDeviceStopResult,
  AppleDeviceCreateArgs,
  AppleDeviceDeleteArgs,
  AppleDeviceDeleteInstalledArgs,
  AppleDeviceListArgs,
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
  APPLE_DEVICE_OFF_CODE,
  APPLE_DEVICE_ORIENTATIONS,
  APPLE_ROTATE_NOT_ADOPTED_CODE,
  APPLE_ROTATE_SEND_FAILED_CODE,
  APPLE_ROTATE_UNMEASURABLE_CODE,
  APPLE_SCROLL_DIRECTIONS,
  APPLE_HARDWARE_BUTTONS,
  APPLE_STREAM_NOT_RUNNING_CODE,
  IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE,
  IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE,
  IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE,
  IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE,
  IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
  IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE,
} from "../../../shared/types/iosSimulator";
import { abbreviatePathTail } from "../../../shared/pathDisplay";
import { commandExists } from "../ai/utils";
import type { Logger } from "../logging/logger";
import { pngDimensions } from "../shared/imageDimensions";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, isRecord, resolvePathWithinRoot, signalChildProcessTree } from "../shared/utils";
import { createIosDeviceHub, type IosDeviceHub } from "./iosDeviceHub";
import { AppleDeviceExistsError, appleDeviceFamily, createLaneDeviceRegistry, type LaneDeviceStore } from "./laneDeviceRegistry";
import {
  createSimHelperClient,
  resolveSimHelperExecutablePath,
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

const execFile = promisify(execFileCallback);

const ADE_IOS_BUNDLE_ID = "com.ade.ios";
const ADE_IOS_PROJECT = path.join("apps", "ios", "ADE.xcodeproj");
const ADE_IOS_SCHEME = "ADE";
const ADE_IOS_INSPECTOR_SNAPSHOT_PATH = path.join("Documents", "ade-inspector-elements.json");
const IOS_APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";
const XCODE_MCP_DOCS_URL = "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode";
const TOOL_STATUS_CACHE_MS = 10_000;
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
const INSTALL_HINT_SIM_HELPER = "Rebuild the vendored simulator helper: run `npm run build:sim-helper` in apps/desktop.";
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

function isAppleDeviceOrientation(value: string): value is AppleDeviceOrientation {
  return (APPLE_DEVICE_ORIENTATIONS as readonly string[]).includes(value);
}

/**
 * Portrait and upside-down are one axis; the two landscapes are the other.
 *
 * The axis is all the framebuffer can tell you, because a 180-degree turn
 * inside one axis produces exactly the same pixel geometry. Naming that limit
 * here keeps `rotate` from pretending otherwise.
 */
function appleOrientationAxis(orientation: AppleDeviceOrientation): "portrait" | "landscape" {
  return orientation === "landscape-left" || orientation === "landscape-right" ? "landscape" : "portrait";
}

function frameAxis(frame: AppleRotateFrame): "portrait" | "landscape" | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  if (frame.width === frame.height) return null;
  return frame.width > frame.height ? "landscape" : "portrait";
}

/** How long to let iOS finish a rotation before calling it refused. */
const APPLE_ROTATE_SETTLE_TIMEOUT_MS = 3_000;

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
 * Viewport direction to the helper's content-movement delta.
 *
 * Inverted on purpose: the finger moves opposite to the content, so revealing
 * what is BELOW (`down`) moves the content UP, which is a negative deltaY.
 */
const APPLE_SCROLL_DELTAS: Record<AppleScrollDirection, (amount: number) => { deltaX: number; deltaY: number }> = {
  down: (amount) => ({ deltaX: 0, deltaY: -amount }),
  up: (amount) => ({ deltaX: 0, deltaY: amount }),
  right: (amount) => ({ deltaX: -amount, deltaY: 0 }),
  left: (amount) => ({ deltaX: amount, deltaY: 0 }),
};

type RunCommand = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
type SpawnProcess = typeof spawn;
type CommandExistsProbe = typeof commandExists;

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
/** What the service may ask the relay before a local viewer's stop. */
export type AppleRemoteViewerProbe = {
  /** A remote viewer is reading this lane's capture right now. */
  watching(laneId: string): boolean;
  /** The relay now owns stopping this lane's capture. */
  adopt(laneId: string): void;
};

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
    super(`${IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE}: ${outPath} is outside the build root ${root}.`);
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
  /** Human name for a lane, used to name its cloned simulator. */
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
};

type RootScope = {
  projectRoot?: string | null;
  laneId?: string | null;
};

type SimctlListDevicesJson = {
  devices?: Record<string, Array<{
    name?: string;
    udid?: string;
    state?: string;
    isAvailable?: boolean;
    availabilityError?: string;
    deviceTypeIdentifier?: string;
  }>>;
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

function normalizeRuntimeName(runtime: string): string {
  const tail = runtime.split(".").pop() ?? runtime;
  return tail.replace(/^iOS-/, "iOS ").replace(/-/g, ".");
}

function runtimeVersionScore(runtime: string): number {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(runtime);
  if (!match) return 0;
  return (Number(match[1]) * 1_000_000)
    + (Number(match[2] ?? 0) * 1_000)
    + Number(match[3] ?? 0);
}

function isTerminatedByTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === "SIGTERM";
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
let commandExistsProbe: CommandExistsProbe = commandExists;

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

function inferSwiftUITabItems(projectRoot: string | null | undefined): InferredSwiftUITabItem[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const items: InferredSwiftUITabItem[] = [];
  const seen = new Set<string>();
  for (const filePath of collectSwiftFiles(root)) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.includes(".tabItem")) continue;
      const searchEnd = Math.min(lines.length, index + 10);
      for (let cursor = index; cursor < searchEnd; cursor += 1) {
        const line = lines[cursor] ?? "";
        const match = /\b(?:Label|Text)\s*\(\s*"((?:\\.|[^"\\])+)"/.exec(line);
        if (!match?.[1]) continue;
        const label = match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
        if (!label || seen.has(label.toLowerCase())) continue;
        const sourceFile = relativeToRoot(root, filePath);
        const sourceLine = cursor + 1;
        seen.add(label.toLowerCase());
        items.push({
          label,
          sourceFile,
          sourceLine,
          snippet: readSourceSnippet(root, sourceFile, sourceLine),
        });
        break;
      }
    }
  }
  return items.slice(0, 12);
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

function normalizeLaunchArguments(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("iOS Simulator launch arguments must be an array.");
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("iOS Simulator launch arguments must be an array of strings.");
    }
  }
  return value as string[];
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
        value: readString(value, ["value", "placeholderValue", "placeholder", "text", "AXValue"]),
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

function scaleAccessibilityElementsToScreenshot(
  elements: IosScreenElement[],
  shot: IosSimulatorScreenshot,
): { elements: IosScreenElement[]; screen: IosInspectableScreen | null } {
  const width = shot.width ?? 0;
  const height = shot.height ?? 0;
  if (!elements.length || width <= 0 || height <= 0) {
    return { elements, screen: null };
  }
  const scale = inferAccessibilityScale(elements, shot);
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

function synthesizeSwiftUITabBarElements(projectRoot: string | null | undefined, elements: IosScreenElement[]): IosScreenElement[] {
  const inferredTabs = inferSwiftUITabItems(projectRoot);
  if (!inferredTabs.length) return [];
  const tabBars = elements.filter((element) => {
    const label = element.label?.toLowerCase() ?? "";
    const role = element.role?.toLowerCase() ?? "";
    const type = element.elementType?.toLowerCase() ?? "";
    return label === "tab bar" || (label.includes("tab") && (role.includes("group") || type.includes("group")));
  });
  const synthesized: IosScreenElement[] = [];
  for (const tabBar of tabBars) {
    if (tabBar.frame.width <= 0 || tabBar.pixelFrame.width <= 0) continue;
    const frameWidth = tabBar.frame.width / inferredTabs.length;
    const pixelWidth = tabBar.pixelFrame.width / inferredTabs.length;
    inferredTabs.forEach((tab, index) => {
      synthesized.push({
        id: `accessibility:synthetic-tab:${tab.label}:${index}`,
        source: "accessibility",
        layer: "accessibility",
        label: tab.label,
        value: null,
        role: "AXButton",
        elementType: "TabItem",
        identifier: `SwiftUI.TabItem.${tab.label}`,
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
          generatedFrom: "SwiftUI .tabItem source labels and the accessibility Tab Bar frame",
          tabBarElementId: tabBar.id,
          sourceSnippet: tab.snippet,
        },
      });
    });
  }
  return synthesized;
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
  return appBundles[0] ?? null;
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
  const activeBuildDataPaths = new Map<string, number>();
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
   * Which lane a call belongs to.
   *
   * An explicit lane always wins. Failing that the CALLING CHAT decides: a chat
   * that launched on lane B and then ran a bare `tap` means lane B, and the old
   * project-wide state made that accidentally true. Only when neither says
   * anything does the un-laned bucket answer — which is also what a fresh
   * process with no sessions at all returns.
   */
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

  const resolveRuntime = (
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
        typeText: (textArgs) => typeText({ ...textArgs, laneId: runtime.laneId }),
        resetHelperDevice: (deviceUdid) => resetHelperDevice(deviceUdid, "hub-power"),
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

  const helperBinaryPath = resolveSimHelperExecutablePath();
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
        binaryPath: helperBinaryPath,
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
      return helperBinaryPath;
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

  const listInstalledSimulators = async (): Promise<AppleInstalledSimulator[]> => {
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return [];
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"], { timeoutMs: 30_000 });
    const parsed = JSON.parse(stdout) as SimctlListDevicesJson;
    const devices: AppleInstalledSimulator[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
      for (const device of runtimeDevices ?? []) {
        if (!device.udid || !device.name) continue;
        if (device.isAvailable === false || device.availabilityError) continue;
        const deviceTypeIdentifier = typeof device.deviceTypeIdentifier === "string" ? device.deviceTypeIdentifier : null;
        devices.push({
          udid: device.udid,
          name: device.name,
          runtime: normalizeRuntimeName(runtime),
          state: device.state ?? "Unknown",
          isAvailable: true,
          family: appleDeviceFamily({ deviceTypeIdentifier, name: device.name }),
          deviceTypeIdentifier,
        });
      }
    }
    return devices;
  };

  const laneDevices = createLaneDeviceRegistry({
    run: (command, commandArgs, options) => run(command, commandArgs, options),
    listInstalledSimulators,
    resolveLaneName: args.resolveLaneName ?? null,
    store: args.laneDeviceStore ?? null,
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
      // The old lane's recording ends with its hold on the device. Left
      // running, it would record the new lane's work under the old lane, and
      // the new lane's `record-start` would be refused.
      await stopDeviceRecording(device.udid, "released");
      const runtime = runtimes.get(laneKey(device.laneId));
      if (!runtime) return;
      await shutdown({ laneId: runtime.laneId, ignoreOwnership: true }).catch((error: unknown) => {
        args.logger.debug("apple.takeover_shutdown_failed", {
          laneId: device.laneId,
          udid: device.udid,
          error: error instanceof Error ? error.message : String(error),
        });
        return { released: false, previousSession: null };
      });
      if (runtime.hub?.getDeviceSession()?.deviceUdid === device.udid) {
        await runtime.hub.closeDevice({
          deviceUdid: device.udid,
          chatSessionId: null,
          ignoreOwnership: true,
          // The new owner is about to drive this device. Powering it off here
          // would be a takeover that hands over a dead simulator.
          shutdownDevice: false,
        }).catch((error: unknown) => {
          args.logger.debug("apple.takeover_close_device_failed", {
            laneId: device.laneId,
            udid: device.udid,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      invalidateStatus(runtime);
      // `released`, not `stopped`: the device is still running, it is just not
      // this lane's any more, and this lane has to re-list to find that out.
      emit({ type: "apple.device.state", laneId: device.laneId, udid: device.udid, phase: "released" });
      args.logger.info("apple.lane_device_released_for_takeover", {
        laneId: device.laneId,
        udid: device.udid,
      });
    },
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
    },
  ): void => {
    void Promise.resolve(recordings.noteInput({
      laneId: runtime.key,
      udid: input.udid,
      chatSessionId: runtime.activeSession?.chatSessionId ?? null,
      kind: input.kind,
      x: input.x,
      y: input.y,
      text: input.text,
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
    const canControl = process.platform === "darwin" && fs.existsSync(helperBinaryPath);
    return {
      canTap: canControl,
      canType: canControl,
      canDrag: canControl,
      canInspect: canControl || cachedCommandExists("xcrun"),
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

  const waitForSimulatorBootStatus = (device: IosSimulatorDevice) =>
    runSimctlWithTimeout(
      ["bootstatus", device.udid, "-b"],
      SIMCTL_BOOTSTATUS_TIMEOUT_MS,
      `Simulator ${device.name} did not become ready within ${Math.round(SIMCTL_BOOTSTATUS_TIMEOUT_MS / 1000)}s. CoreSimulator may be stuck; shut down that simulator and launch again.`,
    );

  /**
   * Boot a shut-down simulator and wait until CoreSimulator says it is ready.
   *
   * Idempotent: a device that is already booted skips `simctl boot` (and the
   * "current state: Booted" refusal `simctl` answers with when two callers
   * race) and only waits on `bootstatus`, which returns at once for a booted
   * device. Only explicit starts come here: `deviceStart`, and `startStream`
   * when its caller passed `boot: true`. A viewer that only wants to watch
   * gets `APPLE_DEVICE_OFF` instead (see `startStream`).
   */
  const ensureDeviceBooted = async (device: IosSimulatorDevice): Promise<void> => {
    let booted = false;
    if (device.state !== "Booted") {
      booted = await bootSimulator(device);
    }
    await waitForSimulatorBootStatus(device);
    // The cached `simctl list` still says Shutdown. The next read must not.
    if (booted) invalidateDeviceList();
    // Only after a boot THIS call did: a device that was already up keeps the
    // helper session it has, and dropping it would cost a stream for nothing.
    if (booted) await resetHelperDevice(device.udid, "boot");
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

  /**
   * `simctl boot`, tolerating the "already booted" refusal two racing callers
   * get. True only when this call actually booted the device.
   */
  const bootSimulator = async (device: IosSimulatorDevice): Promise<boolean> => {
    try {
      await run("xcrun", ["simctl", "boot", device.udid]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Unable to boot device in current state|current state: Booted|already booted/i.test(message)) throw error;
      return false;
    }
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

  const enqueueControl = async <T>(action: string, runControl: () => Promise<T>): Promise<T> => {
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
                `The simulator did not accept ${action} within ${Math.round(CONTROL_TIMEOUT_MS / 1000)}s.`,
              ));
            }, CONTROL_TIMEOUT_MS);
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
    if (process.platform !== "darwin" || !cachedCommandExists("xcrun")) return [];
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
    const parsed = JSON.parse(stdout) as SimctlListDevicesJson;
    const devices: IosSimulatorDevice[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
      for (const device of runtimeDevices ?? []) {
        if (!device.udid || !device.name) continue;
        if (device.isAvailable === false || device.availabilityError) continue;
        devices.push({
          udid: device.udid,
          name: device.name,
          runtime: normalizeRuntimeName(runtime),
          state: device.state ?? "Unknown",
          isAvailable: true,
        });
      }
    }
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
    const derivedDataPath = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
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
      const versionDelta = runtimeVersionScore(b.runtime) - runtimeVersionScore(a.runtime);
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
        available: helperInfo.present,
        detail: helperInfo.present
          ? `Vendored simulator helper at ${helperInfo.path}${helperInfo.version == null ? "" : ` (protocol ${helperInfo.version})`}. Provides the live view, touch, typing, and the accessibility tree.`
          : isDarwin
            ? `The vendored simulator helper is missing at ${helperInfo.path}.`
            : "The vendored simulator helper only runs on macOS.",
        installHint: isDarwin ? INSTALL_HINT_SIM_HELPER : "Apple device control requires macOS.",
      },
    ];
  };

  /** What `status.tools` and `status.helper` say about the vendored helper. */
  const helperToolInfo = (): AppleHelperToolInfo => {
    if (process.platform !== "darwin") {
      return { present: false, path: helperBinaryPath, version: null };
    }
    // `helperClient` is read rather than created: `getStatus` runs every ~500ms
    // while the column is open, and a status poll must not be what starts a
    // subprocess.
    const client = helperClient;
    return {
      present: client ? client.exists() : fs.existsSync(helperBinaryPath),
      path: helperBinaryPath,
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
    return {
      platform: process.platform,
      supported: isDarwin && xcrunAvailable && xcodebuildAvailable,
      tools,
      activeDevice,
      activeSession: runtime.activeSession,
      deviceSession,
      laneDevice: laneDevice ?? null,
      laneId: runtime.laneId,
      helper: helperToolInfo(),
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

  const buildProjectApp = async (target: ResolvedLaunchTarget, device: IosSimulatorDevice, projectRoot: string): Promise<string | null> => {
    const derivedDataPath = path.resolve(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");
    if (!target.projectPath || !target.scheme) {
      return target.appBundlePath;
    }
    if (target.shouldBuild) {
      const relativeProjectPath = relativeToRoot(projectRoot, target.projectPath);
      await fs.promises.mkdir(derivedDataPath, { recursive: true });
      args.logger.info("ios_simulator.build.start", {
        projectRoot,
        projectPath: relativeProjectPath,
        scheme: target.scheme,
        deviceUdid: device.udid,
        derivedDataPath,
      });
      try {
        activeBuildDataPaths.set(derivedDataPath, (activeBuildDataPaths.get(derivedDataPath) ?? 0) + 1);
        try {
          await run("xcodebuild", [
            "-project",
            relativeProjectPath,
            "-scheme",
            target.scheme,
            "-configuration",
            "Debug",
            "-sdk",
            "iphonesimulator",
            "-destination",
            `platform=iOS Simulator,id=${device.udid}`,
            "-derivedDataPath",
            derivedDataPath,
            "build",
          ], { cwd: projectRoot, timeoutMs: 10 * 60_000 });
        } finally {
          const remaining = (activeBuildDataPaths.get(derivedDataPath) ?? 1) - 1;
          if (remaining > 0) activeBuildDataPaths.set(derivedDataPath, remaining);
          else activeBuildDataPaths.delete(derivedDataPath);
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
    return findAppBundle(derivedDataPath, {
      bundleId: target.bundleId,
      scheme: target.scheme,
      // productName lives on the underlying launch target (ResolvedLaunchTarget
      // wraps IosSimulatorLaunchTarget). Prefer it over scheme so a project
      // whose scheme builds multiple .app bundles, or whose scheme name
      // differs from the produced .app, still resolves to the right bundle.
      productName: target.target.productName,
      appBundlePath: target.appBundlePath,
    });
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
      let bootedForLaunch = false;
      if (device.state === "Booted") {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Checking simulator readiness...", device.name, { deviceUdid: device.udid });
      } else {
        emitLaunchProgress(launchId, "boot-simulator", "running", "Booting simulator...", device.name, { deviceUdid: device.udid });
        bootedForLaunch = await bootSimulator(device);
      }
      await waitForSimulatorBootStatus(device);
      if (bootedForLaunch) invalidateDeviceList();
      // Same rule as `ensureDeviceBooted`: a fresh boot gets a fresh helper session.
      if (bootedForLaunch) await resetHelperDevice(device.udid, "boot");
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
        ? await buildProjectApp(target, device, projectRoot)
        : target.appBundlePath;
      emitLaunchProgress(
        launchId,
        "build-app",
        target.shouldBuild ? "complete" : "skipped",
        target.shouldBuild ? "Build complete." : "Using a previously built app.",
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
        await installAppOnSimulator(device, appBundle);
        emitLaunchProgress(launchId, "install-app", "complete", "App installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      } else {
        emitLaunchProgress(launchId, "install-app", "skipped", "App already installed.", bundleId, { deviceUdid: device.udid, targetId: target.target.id });
      }

      const launchEnvironment = normalizeLaunchEnvironment(launchArgs.environment);
      const launchArguments = normalizeLaunchArguments(launchArgs.arguments);
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
    await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", filePath], { timeoutMs: 30_000 });
    const buffer = await fs.promises.readFile(filePath);
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
  const fileScreenshotAsProof = (
    shot: IosSimulatorScreenshot,
    arg: IosSimulatorScreenshotArgs,
    runtime: LaneRuntime,
  ): string | null => {
    const filer = args.recordingDeps?.artifactFiler;
    if (!filer) return null;
    const chatSessionId = arg.chatSessionId?.trim()
      || runtime.activeSession?.chatSessionId
      || null;
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
        backend: { name: "apple-device", style: "local_fallback", toolName: "apple_screenshot" },
        ...(owners.length ? { owners } : {}),
        ...(args.projectRoot ? { callerRoot: args.projectRoot } : {}),
        provenance: { source: "ade-capture" },
        inputs: [
          {
            kind: "screenshot",
            title: caption,
            description: `Screen of the lane's Apple device at ${shot.capturedAt}.`,
            path: shot.filePath,
            mimeType: "image/png",
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
   * downstream (`scaleAccessibilityElementsToScreenshot`) already infers the
   * scale from the screenshot, so nothing here converts.
   */
  const readAccessibilityElements = async (deviceUdid: string): Promise<IosScreenElement[]> => {
    const payload = await helper().send({ type: "ax-describe", udid: deviceUdid });
    const tree = payload.tree;
    if (typeof tree !== "string" || !tree.trim()) {
      throw new Error("The simulator helper returned no accessibility tree. Is an app in the foreground?");
    }
    return collectAccessibilityElements(JSON.parse(tree) as unknown);
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
      const rawAccessibilityElements = await readAccessibilityElements(shot.deviceUdid);
      const scaledAccessibility = scaleAccessibilityElementsToScreenshot(rawAccessibilityElements, shot);
      accessibilityElements = scaledAccessibility.elements;
      accessibilityScreen = scaledAccessibility.screen;
      providers.push({
        source: "accessibility",
        available: true,
        elementCount: accessibilityElements.length,
      });
    } catch (error) {
      providers.push({
        source: "accessibility",
        available: false,
        elementCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const baseElements = mergeScreenElements(inspectorElements, accessibilityElements);
    const syntheticElements = synthesizeSwiftUITabBarElements(projectRoot, baseElements);
    const elements = syntheticElements.length
      ? mergeScreenElements(baseElements, syntheticElements)
      : baseElements;
    const screen = inspectorSnapshot?.screen ?? {
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
    return captureScreenSnapshot(
      snapshotArgs,
      await resolveScopedRootForSession({
        projectRoot: snapshotArgs.projectRoot,
        laneId: snapshotArgs.laneId,
      }, runtime),
      runtime,
    );
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
    if (!status.transport) return { ...status, streamUrl: null };
    return {
      ...status,
      // `streamUrl` would carry the same address, so redacting only the
      // transport would leave it in the field right next to it. Both go.
      streamUrl: null,
      transport: { ...status.transport, url: null, token: null },
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
    // A stopped stream has no local viewer. Cleared for every stop — the
    // renderer's own, the relay's, and the internal one that swaps devices —
    // so the flag cannot outlive the capture it described.
    if (runtime.laneId) localViewerLanes.delete(runtime.laneId);
    await stopCapture(runtime);
    const next = setStreamStopped(runtime, null);
    emit({ type: "stream-stopped", status: next });
    return next;
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
    const incomingChatSessionId = shutdownArgs.chatSessionId ?? null;
    if (
      runtime.activeSession
      && runtime.activeSession.chatSessionId
      && runtime.activeSession.chatSessionId !== incomingChatSessionId
      && !shutdownArgs.force
      && !shutdownArgs.ignoreOwnership
    ) {
      throw new IosSimulatorOwnedBySessionError(runtime.activeSession);
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
      // viewer set, so it never gets here.
      if (streamArgs.localViewer) markLocalViewer(runtime.laneId);
      if (bitrateKbps != null && (runtime.streamStatus.bitrateKbps ?? null) !== bitrateKbps) {
        const payload = await helper().send({
          type: "capture-start",
          udid: device.udid,
          fps: requestedFps,
          scale,
          bitrateKbps,
        });
        const url = typeof payload.url === "string" ? payload.url : null;
        const token = typeof payload.token === "string" ? payload.token : null;
        const transport = runtime.streamStatus.transport;
        if (url && token && transport && (url !== transport.url || token !== transport.token)) {
          // The helper must answer with the address it already had. If it did
          // not, the old readers are gone anyway: record the new address and
          // announce it as a new stream so viewers attach to it.
          args.logger.warn("apple.stream_cap_changed_address", { laneId: runtime.laneId, deviceUdid: device.udid });
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
   * A tap, as the helper wants it: a begin and an end at the same point.
   *
   * The helper's wire unit is DEVICE POINTS (`Protocol.swift`'s `DevicePoint`,
   * normalised to a 0..1 fraction in `DeviceMetrics` on the far side), which is
   * the same unit idb's `ui tap` took — so no call site had to change its
   * coordinates when the engine did.
   */
  const helperTap = async (deviceUdid: string, x: number, y: number): Promise<void> => {
    const client = helper();
    await client.send({ type: "touch", udid: deviceUdid, phase: "begin", x, y });
    await client.send({ type: "touch", udid: deviceUdid, phase: "end", x, y });
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
  ): Promise<void> => {
    const durationMs = input.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
    if (!Number.isFinite(durationMs)) throw new Error("durationMs must be a number.");
    const client = helper();
    const steps = Math.max(2, Math.min(60, Math.round(Math.max(durationMs, 1) / DRAG_STEP_MS)));
    const stepDelayMs = Math.max(0, Math.round(durationMs / steps));
    await client.send({ type: "touch", udid: deviceUdid, phase: "begin", x: input.startX, y: input.startY });
    for (let step = 1; step < steps; step += 1) {
      const progress = step / steps;
      await client.send({
        type: "touch",
        udid: deviceUdid,
        phase: "move",
        x: input.startX + ((input.endX - input.startX) * progress),
        y: input.startY + ((input.endY - input.startY) * progress),
      });
      if (stepDelayMs > 0) await delay(stepDelayMs);
    }
    await client.send({ type: "touch", udid: deviceUdid, phase: "end", x: input.endX, y: input.endY });
  };

  const tap = async (point: { deviceUdid?: string | null; x: number; y: number; laneId?: string | null; chatSessionId?: string | null; source?: AppleInputSource }): Promise<{ ok: true }> => {
    assertDarwin();
    const runtime = resolveRuntime(point);
    const deviceUdid = await resolveControlDeviceUdid(point.deviceUdid, runtime);
    const x = normalizeCoordinate(point.x, "x");
    const y = normalizeCoordinate(point.y, "y");
    return enqueueControl("tap", async () => {
      await helperTap(deviceUdid, x, y);
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "tap", x, y, source: point.source });
      return { ok: true };
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
    const wantedAxis = appleOrientationAxis(rawOrientation);
    return enqueueControl("rotate", async () => {
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
    });
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
      await helper().send({ type: "scroll", udid: deviceUdid, deltaX, deltaY, ...(anchor ?? {}) });
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      // A scroll IS injected input under the auto-record contract: it changes
      // what is on screen, and a video that skips it shows a jump cut. The
      // source is carried through so a person scrolling the pane does not look
      // like an agent and start a recording.
      noteInput(runtime, { udid: deviceUdid, kind: "drag", source: scrollArgs.source });
      return { ok: true as const, direction, deltaX, deltaY };
    });
  };

  const typeText = async (input: { deviceUdid?: string | null; text: string; laneId?: string | null; chatSessionId?: string | null; source?: AppleInputSource }): Promise<{ ok: true }> => {
    assertDarwin();
    const runtime = resolveRuntime(input);
    const deviceUdid = await resolveControlDeviceUdid(input.deviceUdid, runtime);
    return enqueueControl("text", async () => {
      await helperType(deviceUdid, input.text);
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "type", text: input.text, source: input.source });
      return { ok: true };
    });
  };

  const drag = async (input: IosSimulatorDragArgs): Promise<{ ok: true }> => {
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
      if (durationMs != null && !Number.isFinite(durationMs)) throw new Error("durationMs must be a number.");
      // `delta` was idb's step size and the helper owns its own stepping now.
      // Still validated rather than ignored: a caller passing a nonsense delta
      // has a bug, and silently accepting it hides it.
      if (deltaValue != null && (!Number.isFinite(deltaValue) || deltaValue <= 0)) throw new Error("delta must be a positive number.");
      await helperSwipe(deviceUdid, { startX, startY, endX, endY, durationMs });
      runtime.streamStatus = { ...runtime.streamStatus, inputBackend: "helper" };
      noteInput(runtime, { udid: deviceUdid, kind: "drag", x: endX, y: endY, source: input.source });
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
    noteInput(runtime, { udid: screenSnapshot.deviceUdid, kind: "select", x, y });
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
    const device = await laneDevices.deviceCreate({
      laneId: runtime.key,
      from: deviceArgs.from,
      name: deviceArgs.name,
    });
    invalidateStatus(runtime);
    return device;
  };

  const deviceAttach = async (deviceArgs: AppleDeviceAttachArgs): Promise<AppleLaneDevice> => {
    assertDarwin();
    const runtime = requireLaneScope(deviceArgs);
    const device = await laneDevices.deviceAttach({ laneId: runtime.key, simulator: deviceArgs.simulator });
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
    const sourceUdid = deviceArgs.create?.sourceUdid?.trim() || null;
    let laneDevice = laneDevices.get(laneId);
    if (!laneDevice) {
      if (sourceUdid) {
        laneDevice = await laneDevices.deviceCreate({ laneId, from: sourceUdid });
      } else if (requestedUdid) {
        laneDevice = await laneDevices.deviceAttach({ laneId, simulator: requestedUdid });
      } else {
        throw new Error("The lane has no Apple device yet. Pass a simulator udid to attach, or create: { sourceUdid } to clone one.");
      }
      invalidateStatus(runtime);
    } else if (requestedUdid && requestedUdid !== laneDevice.udid) {
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
    const laneDevice = runtime.key ? laneDevices.get(runtime.key) : null;
    // Widest-to-narrowest, the same precedence `resolveControlDeviceUdid`
    // uses, minus its final "whatever iPhone is booted" fallback: powering off
    // a simulator this lane never claimed is not a reasonable reading of
    // "stop my device".
    const udid = stopArgs.udid?.trim()
      || laneDevice?.udid
      || runtime.activeSession?.deviceUdid
      || runtime.hub?.getDeviceSession()?.deviceUdid
      || runtime.streamStatus.deviceUdid
      || null;
    if (!udid) {
      return { udid: null, poweredOff: false, previousState: null, released: false, stillRegistered: false };
    }
    const released = await shutdown({
      laneId: runtime.laneId,
      chatSessionId: stopArgs.chatSessionId ?? null,
      force: stopArgs.force ?? null,
      ignoreOwnership: stopArgs.ignoreOwnership ?? null,
    });
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
    await stopDeviceRecording(udid, "device-off");
    // After the recording is finished (so the helper has nothing left to
    // write) and before the power goes: the helper's session for this device
    // is bound to the boot that is about to end.
    await resetHelperDevice(udid, "power-off");
    let poweredOff = false;
    await run("xcrun", ["simctl", "shutdown", udid], { timeoutMs: 60_000 })
      .then(() => {
        poweredOff = true;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Already off is the result the caller wanted, not a failure. Anything
        // else is: a stop that silently did nothing is exactly the bug this
        // verb exists to fix, so it is not swallowed.
        if (!/current state: Shutdown|Unable to shutdown device in current state|not booted|Invalid device state/i.test(message)) {
          throw error;
        }
      });
    invalidateDeviceList();
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
    return laneDevices.deviceList({
      installed: deviceArgs.installed,
      laneId: runtime.key || null,
      // Opt-in: the picker paints its list from the cheap call and asks for the
      // numbers afterwards, so a `du` over a 20 GB device store never sits in
      // front of the first frame of the page.
      disk: deviceArgs.disk,
    });
  };

  /**
   * Remove an installed simulator by udid — the picker's per-device menu.
   *
   * No `requireLaneScope`: the target is named outright and the registry's own
   * guard is the one that matters (it refuses any device a lane holds). Asking
   * for a lane scope here would only say which lane is doing the tidying.
   */
  const deviceDeleteInstalled = async (deviceArgs: AppleDeviceDeleteInstalledArgs): Promise<void> => {
    assertDarwin();
    if (deviceArgs?.confirmedByUser !== true) {
      /*
       * Name the way through, like every other refusal here does.
       *
       * This used to say only "needs confirmedByUser: true", an internal
       * argument name with no next step — a test agent read it, could not act
       * on it, and filed it as a tooling gap. Deleting a simulator is not
       * recoverable, so the confirmation stays; what changes is that the
       * message says where a human gives it and what to pass if you are not
       * one.
       */
      throw new Error(
        "Deleting a simulator needs the owner's confirmation. Use the Apple Development picker's ⋯ menu on the device, which asks twice and names its size. From the CLI or an action, pass confirmedByUser: true only when a human has said yes to this device by name.",
      );
    }
    const runtime = resolveRuntime(deviceArgs);
    await laneDevices.deviceDeleteInstalled({ udid: deviceArgs.udid });
    invalidateStatus(runtime);
  };

  const deviceDelete = async (deviceArgs: AppleDeviceDeleteArgs = {}): Promise<void> => {
    const runtime = requireLaneScope(deviceArgs);
    // Whatever was driving it stops first: deleting a simulator out from under
    // a running stream leaves the reader waiting on bytes that never come.
    await shutdown({ laneId: runtime.laneId, chatSessionId: deviceArgs.chatSessionId, ignoreOwnership: true })
      .catch(() => ({ released: false, previousSession: null }));
    const deletedUdid = laneDevices.get(runtime.key)?.udid;
    if (deletedUdid) {
      await stopDeviceRecording(deletedUdid, "device-off");
      // The registry shuts the device down before deleting it.
      await resetHelperDevice(deletedUdid, "delete");
    }
    await laneDevices.deviceDelete({ laneId: runtime.key, force: deviceArgs.force });
    invalidateStatus(runtime);
    // The lane's binding changed ("Choose another device"): every surface that
    // shows the lane's device re-reads now rather than on its next poll.
    if (deletedUdid && runtime.key) {
      emit({ type: "apple.device.state", laneId: runtime.key, udid: deletedUdid, phase: "released" });
    }
  };

  /**
   * The lane's device, created on first ask.
   *
   * `launch` and `open-device` call this: a lane gets no device until it is
   * asked for, and the ask is what creates it. An un-laned caller keeps the old
   * behaviour of driving whatever simulator `resolveDevice` picks, because
   * there is no lane to own a clone.
   */
  const ensureLaneDevice = async (runtime: LaneRuntime): Promise<AppleLaneDevice | null> => {
    if (!runtime.key) return null;
    const existing = laneDevices.get(runtime.key);
    if (existing) return existing;
    const created = await laneDevices.ensure({ laneId: runtime.key });
    invalidateStatus(runtime);
    return created;
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
      udid: laneDevices.get(runtime.key)?.udid
        || runtime.activeSession?.deviceUdid
        || runtime.hub?.getDeviceSession()?.deviceUdid
        || runtime.streamStatus.deviceUdid
        || null,
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

  /**
   * Lane archive / delete. Called from `laneService`'s delete cascade next to
   * `removeLaneArtifactFiles`.
   *
   * Deletes the CLONE and never an attached device, and takes the recordings
   * directory with it. `force` here means "detach an attached device too",
   * which is what a lane that no longer exists needs.
   */
  const releaseLane = async (laneId: string): Promise<void> => {
    const key = laneId.trim();
    if (!key) return;
    const runtime = runtimes.get(key);
    if (runtime) {
      await shutdown({ laneId: key, force: true }).catch(() => ({ released: false, previousSession: null }));
      runtime.hub?.dispose();
      runtime.hub = null;
      runtimes.delete(key);
    }
    await laneDevices.deviceDelete({ laneId: key, force: true }).catch((error: unknown) => {
      args.logger.warn("apple.lane_device_release_failed", {
        laneId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    getStatus,
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
    frame,
    tap,
    pressButton,
    rotate,
    typeText,
    drag,
    swipe: drag,
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
    deviceDelete,
    deviceDeleteInstalled,
    /** Lane archive/delete hook. Deletes a clone, only detaches an attached device. */
    releaseLane,

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
      if (udid) noteInput(runtime, { udid, kind: "open-url", text: toolArgs.url });
      return result;
    },
    relaunchApp: async (toolArgs: IosSimulatorAppLifecycleArgs) => darwinHub(toolArgs).relaunchApp(toolArgs),
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
     */
    getForegroundApp: async (
      arg: { deviceUdid?: string | null; laneId?: string | null; chatSessionId?: string | null } = {},
    ): Promise<IosSimulatorForegroundApp> => {
      assertDarwin();
      const udid = await resolveControlDeviceUdid(arg.deviceUdid, resolveRuntime(arg));
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
        } as IosSimulatorScreenshot,
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
  };
}
