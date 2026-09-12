export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolStatus = {
  name: "xcrun" | "xcodebuild" | "simulator_window" | "idb" | "idb_companion";
  available: boolean;
  detail: string;
  installHint: string;
};

export const IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE = "IOS_SIMULATOR_OWNED_BY_OTHER_SESSION" as const;
/** A stored target id points at a project/app bundle that is not under the resolved build root. */
export const IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE = "IOS_SIMULATOR_TARGET_ROOT_MISMATCH" as const;
/** A second launch arrived while one was still running. */
export const IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE = "IOS_SIMULATOR_LAUNCH_IN_PROGRESS" as const;
/** Only a previously installed app resolved, and the caller did not ask for it by name. */
export const IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE = "IOS_SIMULATOR_NO_BUILDABLE_TARGET" as const;
/**
 * A laneId was supplied but no worktree could be resolved for it. Silently
 * falling back to the primary checkout is how a lane agent builds, screenshots,
 * and "verifies" code it never wrote.
 */
export const IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE = "IOS_SIMULATOR_LANE_NOT_RESOLVED" as const;
/** An `--out` path escaped the resolved build root. */
export const IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE = "IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT" as const;

export type IosSimulatorShutdownArgs = {
  /**
   * Who is asking. Shutdown enforces the same single-owner rule as `launch`:
   * a caller that is not the owning chat — including an anonymous caller that
   * names no chat at all — is refused with
   * `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` unless it passes `force`. Without
   * this field the service could not tell chat A's own stop apart from chat
   * B's, so any chat following its skill instructions killed whichever session
   * happened to be running.
   */
  chatSessionId?: string | null;
  force?: boolean | null;
  /**
   * Stop for whoever is running, without claiming to be them.
   *
   * ADE's lane-scoped simulator surface deliberately drives whatever session
   * its lane is running and hides the ownership card, so the guard has to step
   * aside for it. It used to do that by reading the owner's id off `getStatus`
   * and replaying it as `chatSessionId` — a caller impersonating the owner,
   * which is both a lie in the logs and a pattern any other caller can copy.
   * This says what is actually meant, and unlike `force` it asks for nothing
   * else: no companion sweep, no launch-lock reset.
   *
   * It is intent, not permission. The single-owner rule is cooperative — see
   * `docs/features/ios-simulator/README.md` — and exists to stop one chat
   * tearing down another's session by accident, not to make a session
   * un-evictable.
   */
  ignoreOwnership?: boolean | null;
};

export type IosSimulatorShutdownResult = {
  released: boolean;
  previousSession: IosSimulatorSession | null;
};

export type IosSimulatorStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  tools: IosSimulatorToolStatus[];
  activeDevice: IosSimulatorDevice | null;
  activeSession: IosSimulatorSession | null;
  /**
   * The booted-but-appless half of the hub. Present on hosts that support
   * device sessions; older hosts omit it and every caller treats that as null.
   */
  deviceSession?: IosSimulatorDeviceSession | null;
  /**
   * What the live view is doing, so one status read answers "what is going on".
   *
   * An agent asking that question had to call `getStatus` and `getStreamStatus`
   * and join them. This is the coarse half of the second call, carried here so
   * the poll an agent already makes is enough. It never carries the stream
   * address or its token: that is `startStream`'s to hand out.
   */
  stream?: IosSimulatorStatusStream | null;
};

/** The redacted live-view summary carried on `IosSimulatorStatus`. */
export type IosSimulatorStatusStream = {
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  deviceUdid: string | null;
  /** Measured by host-encoded backends only; null for window capture. */
  fps: number | null;
  bitrateKbps: number | null;
  lastError: string | null;
};

export type IosSimulatorLaunchMode = "snapshot" | "live";

export type IosSimulatorLaunchTargetKind = "project" | "built" | "installed";

export type IosSimulatorLaunchTarget = {
  id: string;
  kind: IosSimulatorLaunchTargetKind;
  name: string;
  bundleId: string | null;
  detail: string;
  projectPath: string | null;
  scheme: string | null;
  /**
   * Xcode product name produced by the application target this launch target
   * resolves to. Distinct from `scheme` because a scheme can build multiple
   * `.app` bundles or a scheme name can differ from the produced `.app`.
   * Used to disambiguate target ids and to resolve the right `.app` bundle
   * after a build (`findAppBundle` prefers `${productName}.app`).
   */
  productName: string | null;
  /**
   * Internal Xcode target identifier (PBXNativeTarget id). Only populated
   * for `kind === "project"`. Carries the discriminator into the target id
   * so two app targets that share a scheme don't collapse onto the same id.
   */
  appTargetId: string | null;
  appBundlePath: string | null;
  installed: boolean;
  canBuild: boolean;
  canLaunch: boolean;
  source: "xcode-project" | "derived-data" | "simctl-listapps";
};

export type IosSimulatorListLaunchTargetsArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  /**
   * Lane the caller is working in. When no explicit `projectRoot` is given the
   * service resolves this lane's worktree and uses it as the build root, so an
   * agent running in a lane never builds the primary checkout by accident.
   */
  laneId?: string | null;
};

export type IosSimulatorClaimArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  /**
   * Take a session another chat owns, deliberately.
   *
   * Claim rewrites `activeSession.chatSessionId`, so without a guard it was the
   * cheapest eviction path of all: any chat could name itself the owner and
   * then issue a plain `shutdown`, which the single-owner rule would accept.
   * The same cooperative guard `shutdown` uses now applies here, and this is
   * how a caller says it means to take over. Re-attributing the *lane* alone
   * never trips it — that leaves the owning chat exactly where it was.
   */
  ignoreOwnership?: boolean | null;
  /** Same bypass as `ignoreOwnership`, spelled the way `launch`/`shutdown` spell it. */
  force?: boolean | null;
};

export type IosSimulatorLaunchArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  targetId?: string | null;
  bundleId?: string | null;
  appBundlePath?: string | null;
  projectPath?: string | null;
  scheme?: string | null;
  chatSessionId?: string | null;
  build?: boolean;
  mode?: IosSimulatorLaunchMode;
  keepSimulatorInBackground?: boolean | null;
  force?: boolean | null;
  environment?: Record<string, string> | null;
  arguments?: string[] | null;
  /**
   * Ask the desktop shell to open the iOS simulator drawer for this launch.
   * Defaults to false: agent launches must not steal the user's screen. The
   * drawer passes true for its own launches.
   */
  openDrawer?: boolean | null;
};

export type IosSimulatorCapabilities = {
  canTap: boolean;
  canType: boolean;
  canDrag: boolean;
  canInspect: boolean;
};

export type IosSimulatorSession = {
  id: string;
  deviceUdid: string;
  deviceName: string | null;
  bundleId: string;
  appName: string | null;
  appBundlePath: string | null;
  targetId: string | null;
  projectRoot: string | null;
  laneId: string | null;
  chatSessionId: string | null;
  mode: IosSimulatorLaunchMode;
  keepSimulatorInBackground?: boolean | null;
  bridgeUrl: string | null;
  startedAt: string;
  claimedAt: string | null;
  /**
   * Absolute directory xcodebuild ran in. Equals the lane worktree for lane
   * launches. Optional on the session because a session restored from an older
   * shape (or observed before a launch completed) has never carried one; the
   * launch result below narrows it to a required string.
   */
  buildRoot?: string | null;
  /** True when nothing was rebuilt, so the running app can predate the caller's code changes. */
  usedInstalledBinary?: boolean | null;
};

export type IosSimulatorLaunchResult = IosSimulatorSession & {
  buildRoot: string;
  usedInstalledBinary: boolean;
  /** Launch-only: what the resolved input backend can drive right now. */
  capabilities: IosSimulatorCapabilities;
};

export type IosSimulatorScreenshotArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /** Where to write the PNG. Relative paths resolve against the build root. */
  outPath?: string | null;
};

export type IosSimulatorScreenshot = {
  deviceUdid: string;
  dataUrl: string;
  /** Absolute path of the written PNG. Agents read this instead of the data URL. */
  filePath: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
};

export type IosSimulatorStreamStatus = {
  deviceUdid: string | null;
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  requestedBackend?: IosSimulatorStreamBackend | null;
  fallbackReason?: string | null;
  degradationReason?: string | null;
  /**
   * Measured frame rate. The service never measures frames — the renderer owns
   * the Simulator.app window capture — so this stays null service-side instead
   * of reporting a number nobody counted.
   */
  fps: number | null;
  targetFps: number | null;
  /** Null service-side for the same reason as `fps`. */
  frameCount: number | null;
  startedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
  error?: {
    code: string;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  streamUrl: string | null;
  averageLatencyMs?: number | null;
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  helperPid?: number | null;
  inputBackend?: "idb" | null;
  /** Set by host-encoded backends only. Null for window capture. */
  transport?: IosSimulatorStreamTransport | null;
  /** Measured by host-encoded backends only. */
  bitrateKbps?: number | null;
};

/**
 * `simulator-window-capture` is the renderer capturing the real Simulator.app
 * window on this Mac. It is the cheapest path that exists — Chromium hands the
 * compositor's own frames to a `<video>` element with no encode and no copy —
 * and it stays the default whenever the simulator is local.
 *
 * `idb-h264` encodes on the machine that owns the simulator and serves access
 * units over loopback HTTP. It costs an encode and a decode, but it is the only
 * path that works when that machine is not this one, and it needs no Screen
 * Recording grant and no visible Simulator window.
 */
export type IosSimulatorStreamBackend = "simulator-window-capture" | "idb-h264";

export type IosSimulatorWindowSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
};

export type IosSimulatorWindowIssue =
  | "not-running"
  | "hidden"
  | "minimized"
  | "no-window"
  | "screen-recording-permission"
  | "automation-denied"
  | "unknown";

/**
 * Live-view capture of the real Simulator window depends on two macOS privacy
 * grants that the app cannot see through `simctl`: Screen Recording (or
 * `desktopCapturer` hands back black thumbnails) and Automation/System Events
 * (or every window query and park silently no-ops). Both used to surface as
 * `issue: "unknown"` with a null message, so the drawer showed a blank live
 * view and named no blocker — hence the two dedicated `IosSimulatorWindowIssue`
 * members above, which the overlay turns into an "Open Settings" affordance.
 */
export type IosSimulatorPrivacyPane = "screen-recording" | "automation";

export type IosSimulatorPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export type IosSimulatorWindowState = {
  appRunning: boolean;
  visible: boolean | null;
  windowCount: number | null;
  minimizedWindowCount: number | null;
  capturable: boolean | null;
  issue: IosSimulatorWindowIssue | null;
  message: string | null;
};

/**
 * The window-parking path runs in Electron main, whose own iOS simulator
 * service never sees a launch that the brain daemon owns — its `activeSession`
 * is always null. Callers that already hold the runtime session pass it here so
 * parking keys off the session that actually exists.
 */
export type IosSimulatorWindowCaptureSessionHint = {
  deviceUdid: string;
  deviceName: string | null;
};

export type IosSimulatorWindowSourcesResult = {
  sources: IosSimulatorWindowSource[];
  windowState: IosSimulatorWindowState | null;
  /** Short, actionable blocker text. Null when `sources` is non-empty. */
  message: string | null;
};

export type IosSimulatorPreviewWindow = {
  tabIdentifier: string;
  title: string | null;
  workspacePath: string | null;
  raw: string;
};

export type IosSimulatorPreviewCapability = {
  platform: NodeJS.Platform;
  supported: boolean;
  docsUrl: string;
  xcodeVersion: string | null;
  mcpbridgeAvailable: boolean;
  xcodeRunning: boolean;
  xcodeWindows: IosSimulatorPreviewWindow[];
  selectedWindow: IosSimulatorPreviewWindow | null;
  setupSteps: string[];
  error: string | null;
  checkedAt: string;
};

export type IosSimulatorPreviewTarget = {
  id: string;
  title: string;
  sourceFile: string;
  sourceFilePath: string;
  absoluteSourceFile: string;
  sourceLine: number;
  previewDefinitionIndexInFile: number;
  kind: "preview-macro" | "preview-provider";
  proximity: "selected-file" | "feature-file" | "project";
};

export type IosSimulatorPreviewMatchStatus =
  | "matched"
  | "missing-source"
  | "missing-preview"
  | "no-context";

export type IosSimulatorPreviewMatch = {
  status: IosSimulatorPreviewMatchStatus;
  target: IosSimulatorPreviewTarget | null;
  confidence: "exact" | "nearby" | "fallback" | "none";
  reason: string;
  selectedSourceFile: string | null;
  selectedSourceLine: number | null;
  suggestedTitle: string | null;
  suggestedSourceFile: string | null;
  suggestedSourceFilePath: string | null;
};

export type IosSimulatorListPreviewsArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
  elementLabel?: string | null;
  componentId?: string | null;
};

export type IosSimulatorEnsurePreviewWorkspaceArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
  openIfNeeded?: boolean | null;
  timeoutMs?: number | null;
};

export type IosSimulatorEnsurePreviewWorkspaceResult = {
  ok: boolean;
  opened: boolean;
  path: string | null;
  capability: IosSimulatorPreviewCapability;
  error: string | null;
};

export type IosSimulatorRenderPreviewArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFilePath: string;
  previewDefinitionIndexInFile?: number | null;
  tabIdentifier?: string | null;
  timeoutSec?: number | null;
  manageXcode?: boolean | null;
};

export type IosSimulatorRenderPreviewResult = {
  ok: boolean;
  target: {
    sourceFilePath: string;
    previewDefinitionIndexInFile: number;
    tabIdentifier: string | null;
  };
  previewSnapshotPath: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  renderedAt: string;
  capability: IosSimulatorPreviewCapability;
  error: string | null;
};

export type IosSimulatorRenderCurrentPreviewArgs = IosSimulatorListPreviewsArgs & {
  tabIdentifier?: string | null;
  timeoutSec?: number | null;
};

export type IosSimulatorRenderCurrentPreviewResult = {
  ok: boolean;
  match: IosSimulatorPreviewMatch;
  target: IosSimulatorPreviewTarget | null;
  render: IosSimulatorRenderPreviewResult | null;
  error: string | null;
};

export type IosSimulatorOpenPreviewWorkspaceArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
};

export type IosSimulatorStartStreamArgs = {
  deviceUdid?: string | null;
  fps?: number | null;
  backend?: "auto" | IosSimulatorStreamBackend | null;
  /** `idb-h264` only. 0.1 to 1. Lower sends fewer pixels over the wire. */
  scaleFactor?: number | null;
  /** `idb-h264` only. 0.1 to 1. Lower spends fewer bits per pixel. */
  compressionQuality?: number | null;
};

export type IosSimulatorFrame = {
  deviceUdid: string;
  dataUrl: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
  frameCount: number;
  backend: IosSimulatorStreamBackend;
};

export type IosSimulatorLaunchStepId =
  | "resolve-device"
  | "boot-simulator"
  | "open-simulator"
  | "resolve-target"
  | "build-app"
  | "install-app"
  | "launch-app"
  | "ready";

export type IosSimulatorLaunchStepStatus = "pending" | "running" | "complete" | "skipped" | "failed";

export type IosSimulatorLaunchProgress = {
  launchId: string;
  step: IosSimulatorLaunchStepId;
  status: IosSimulatorLaunchStepStatus;
  message: string;
  detail?: string | null;
  /**
   * Who owns this launch. These events broadcast project-wide, so a second
   * drawer in the same project sees every other chat's steps — including
   * another lane's build root. Drawers drop progress stamped for a chat or lane
   * that is not theirs; unstamped progress is still accepted so an older host
   * keeps working.
   */
  chatSessionId?: string | null;
  laneId?: string | null;
  deviceUdid?: string | null;
  targetId?: string | null;
  /**
   * Absolute build root for the `build-app` step. Carried as data so the
   * stepper UI never has to parse it back out of `message`/`detail` prose.
   */
  buildRoot?: string | null;
  updatedAt: string;
};

export type IosSimulatorPoint = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  x: number;
  y: number;
};

export type IosSimulatorDragArgs = {
  deviceUdid?: string | null;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs?: number | null;
  delta?: number | null;
};

export type IosInspectableFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type IosElementContextItem = {
  kind: "ios_element";
  id: string;
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: IosInspectableFrame | null;
  metadata: Record<string, unknown>;
  accessibilityIdentifier?: string | null;
  screenshotDataUrl?: string | null;
  selectedAt: string;
};

export type IosInspectableScreen = {
  width: number;
  height: number;
  scale: number;
};

export type IosInspectableElement = {
  id: string;
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: IosInspectableFrame;
  pixelFrame: IosInspectableFrame;
  metadata: Record<string, unknown>;
  accessibilityIdentifier?: string | null;
};

export type IosInspectorSnapshot = {
  deviceUdid: string;
  appContainerPath: string;
  generatedAt: string;
  screen: IosInspectableScreen;
  elements: IosInspectableElement[];
};

export type IosScreenElementSource = "ade-inspector" | "accessibility";

export type IosScreenElementLayer = "app" | "accessibility";

export type IosScreenElement = {
  id: string;
  source: IosScreenElementSource;
  layer: IosScreenElementLayer;
  label: string | null;
  value: string | null;
  role: string | null;
  elementType: string | null;
  identifier: string | null;
  frame: IosInspectableFrame;
  pixelFrame: IosInspectableFrame;
  componentId: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  metadata: Record<string, unknown>;
};

export type IosScreenSnapshotProvider = {
  source: IosScreenElementSource | "screenshot";
  available: boolean;
  elementCount?: number;
  error?: string | null;
  generatedAt?: string | null;
};

export type IosScreenSnapshotArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  x?: number | null;
  y?: number | null;
};

export type IosScreenSnapshot = {
  deviceUdid: string;
  capturedAt: string;
  screenshot: IosSimulatorScreenshot;
  screen: IosInspectableScreen;
  elements: IosScreenElement[];
  hitElement: IosScreenElement | null;
  providers: IosScreenSnapshotProvider[];
  inspectorSnapshot: IosInspectorSnapshot | null;
};

export type IosSimulatorInspectPointArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  x: number;
  y: number;
  includeScreenshot?: boolean | null;
};

export type IosSimulatorInspectResult = {
  item: IosElementContextItem | null;
  source: "ade-inspector" | "accessibility" | "coordinate-fallback" | "none";
  snapshot: IosInspectorSnapshot | null;
  screenSnapshot?: IosScreenSnapshot | null;
};

export type IosSimulatorSelectResult = {
  item: IosElementContextItem;
  source: "ade-inspector" | "accessibility" | "coordinate-fallback";
};

export type IosSimulatorDrawerMode = "interact" | "inspect" | "preview";

export type IosSimulatorEventPayload =
  | {
    type: "drawer-open-requested";
    action: string;
    mode: IosSimulatorDrawerMode;
    chatSessionId?: string | null;
    laneId?: string | null;
  }
  | { type: "session-started"; session: IosSimulatorSession }
  | { type: "session-updated"; session: IosSimulatorSession | null }
  | { type: "session-released"; previousSession: IosSimulatorSession | null }
  | { type: "selection"; item: IosElementContextItem }
  | { type: "launch-progress"; progress: IosSimulatorLaunchProgress }
  | { type: "stream-started"; status: IosSimulatorStreamStatus }
  | { type: "stream-status"; status: IosSimulatorStreamStatus }
  | { type: "stream-stopped"; status: IosSimulatorStreamStatus }
  | { type: "stream-frame"; frame: IosSimulatorFrame }
  | { type: "stream-error"; status: IosSimulatorStreamStatus }
  | { type: "device-session-started"; deviceSession: IosSimulatorDeviceSession }
  | { type: "device-session-released"; previousDeviceSession: IosSimulatorDeviceSession | null }
  | { type: "device-settings-changed"; settings: IosSimulatorDeviceSettings };

/* ------------------------------------------------------------------------- *
 * Device hub: device sessions, host-encoded video, device tools, semantic
 * actions, and the event log.
 *
 * The window-capture backend only works when the Simulator runs on the same
 * Mac as the ADE window, because the renderer captures the Simulator.app
 * window itself. A chat pinned to a remote Mac therefore had a live view it
 * could never show. The `idb-h264` backend moves the encode to the machine
 * that owns the simulator and hands the desktop a loopback URL instead of a
 * window id, so a Windows or Linux desktop bound to a remote Mac watches the
 * same session the agent drives.
 * ------------------------------------------------------------------------- */

/**
 * A booted simulator with no app of its own.
 *
 * `activeSession` above is an *app* session: it names a bundle id, a build
 * root, and a lane. Opening a device is the other half — it boots a simulator
 * and makes it streamable so a human can look at whatever already runs there,
 * with no build and no install. Keeping the two apart is what lets a chat
 * attach to a simulator it did not launch.
 */
export type IosSimulatorDeviceSession = {
  deviceUdid: string;
  deviceName: string | null;
  chatSessionId: string | null;
  laneId: string | null;
  openedAt: string;
  /**
   * True when ADE booted this device. A device that was already booted stays
   * booted when ADE closes its session: ADE must not shut down a simulator the
   * user started for something else.
   */
  bootedByAde: boolean;
};

export type IosSimulatorOpenDeviceArgs = {
  deviceUdid?: string | null;
  chatSessionId?: string | null;
  laneId?: string | null;
  /** Open Simulator.app as well. False keeps the device headless. */
  openWindow?: boolean | null;
  /** Take a device session another chat owns. */
  force?: boolean | null;
};

export type IosSimulatorCloseDeviceArgs = {
  deviceUdid?: string | null;
  chatSessionId?: string | null;
  force?: boolean | null;
  ignoreOwnership?: boolean | null;
  /** Shut the simulator down even when ADE did not boot it. */
  shutdownDevice?: boolean | null;
};

export type IosSimulatorCloseDeviceResult = {
  released: boolean;
  shutdown: boolean;
  previousDeviceSession: IosSimulatorDeviceSession | null;
};

/**
 * The framing the video server writes and the renderer reads.
 *
 * A chunked HTTP body has no message boundaries, so every record carries a
 * fixed 12-byte header. The constants live here, in the one module both
 * processes already import, because two independent copies of a binary
 * contract desynchronise at runtime instead of failing to compile.
 */
export const IOS_VIDEO_RECORD_MAGIC = 0xade1f00d;
export const IOS_VIDEO_RECORD_HEADER_BYTES = 12;
export const IOS_VIDEO_RECORD_TYPE_CONFIG = 1;
export const IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT = 2;
export const IOS_VIDEO_RECORD_FLAG_KEYFRAME = 1;
export const IOS_VIDEO_STREAM_PATH = "/ios-simulator-video";

/**
 * Where a host-encoded stream can be read.
 *
 * The URL always names loopback on the machine that runs the simulator. When
 * that machine is remote the desktop opens an SSH port forward and rewrites
 * the host and port, exactly as it already does for a lane preview server.
 * The token is required on every request so nothing else on that machine can
 * read the screen.
 */
export type IosSimulatorStreamTransport = {
  /**
   * Null on a status read.
   *
   * The URL carries the token in its query string, and the token is the only
   * thing standing between a local process and the simulator's screen. Only
   * `startStream` — the call that creates the stream — hands it out; a
   * `getStreamStatus` that any agent can run reports the shape without the
   * secret, so a live token never reaches a durable transcript.
   */
  url: string | null;
  port: number;
  /** Null on a status read, for the same reason as `url`. */
  token: string | null;
  /** WebCodecs codec string built from the stream's own SPS, e.g. `avc1.640032`. */
  codec: string | null;
  width: number | null;
  height: number | null;
};

export type IosSimulatorAppearance = "light" | "dark";

export const IOS_SIMULATOR_CONTENT_SIZES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

export type IosSimulatorContentSize = (typeof IOS_SIMULATOR_CONTENT_SIZES)[number];

/**
 * `increase-contrast` is the only one `simctl ui` knows. The rest live in the
 * device's own `com.apple.Accessibility` preferences, which is why they are
 * written with `simctl spawn defaults write` and then announced with
 * `notifyutil`: a preference written without the notification is read by
 * nothing until the next app launch.
 */
export const IOS_SIMULATOR_ACCESSIBILITY_OPTIONS = [
  "increase-contrast",
  "reduce-motion",
  "reduce-transparency",
  "bold-text",
  "invert-colors",
  "grayscale",
  "voice-over",
] as const;

export type IosSimulatorAccessibilityOption =
  (typeof IOS_SIMULATOR_ACCESSIBILITY_OPTIONS)[number];

export const IOS_SIMULATOR_PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;

export type IosSimulatorPrivacyService = (typeof IOS_SIMULATOR_PRIVACY_SERVICES)[number];

export type IosSimulatorPrivacyAction = "grant" | "revoke" | "reset";

export type IosSimulatorLocation = {
  latitude: number;
  longitude: number;
};

/**
 * What the device reports right now, plus what ADE last asked for where the
 * device cannot be read back.
 *
 * `simctl location` is write-only, so `location` is ADE's own record of the
 * last value it set on this device and is null after a restart. It is marked
 * as such rather than guessed.
 */
export type IosSimulatorDeviceSettings = {
  deviceUdid: string;
  appearance: IosSimulatorAppearance | "unsupported" | "unknown";
  contentSize: IosSimulatorContentSize | "unknown";
  accessibility: Record<IosSimulatorAccessibilityOption, boolean | null>;
  /** Null when ADE has not set a location on this device in this process. */
  location: IosSimulatorLocation | null;
  statusBarOverridden: boolean;
  readAt: string;
};

export type IosSimulatorDeviceArgs = {
  deviceUdid?: string | null;
};

export type IosSimulatorSetAppearanceArgs = IosSimulatorDeviceArgs & {
  appearance: IosSimulatorAppearance;
};

export type IosSimulatorSetContentSizeArgs = IosSimulatorDeviceArgs & {
  contentSize: IosSimulatorContentSize;
};

export type IosSimulatorSetAccessibilityArgs = IosSimulatorDeviceArgs & {
  option: IosSimulatorAccessibilityOption;
  enabled: boolean;
};

export type IosSimulatorSetLocationArgs = IosSimulatorDeviceArgs & IosSimulatorLocation;

export type IosSimulatorSetPermissionArgs = IosSimulatorDeviceArgs & {
  /** Required for `grant` and `revoke`. A `reset` applies without one. */
  bundleId?: string | null;
  service: IosSimulatorPrivacyService;
  action: IosSimulatorPrivacyAction;
};

export type IosSimulatorPushArgs = IosSimulatorDeviceArgs & {
  bundleId: string;
  /** An APNs payload. `aps.alert` is filled in from `title`/`body` when absent. */
  payload?: Record<string, unknown> | null;
  title?: string | null;
  body?: string | null;
};

export type IosSimulatorOpenUrlArgs = IosSimulatorDeviceArgs & {
  url: string;
};

export type IosSimulatorAppLifecycleArgs = IosSimulatorDeviceArgs & {
  bundleId: string;
};

/**
 * `uninstallApp` is the one guarded device tool, so its arguments carry the
 * caller's identity and the deliberate override the guard accepts.
 */
export type IosSimulatorUninstallAppArgs = IosSimulatorAppLifecycleArgs & {
  chatSessionId?: string | null;
  force?: boolean | null;
};

export type IosSimulatorStatusBarArgs = IosSimulatorDeviceArgs & {
  time?: string | null;
  dataNetwork?: string | null;
  wifiBars?: number | null;
  cellularBars?: number | null;
  batteryLevel?: number | null;
  batteryState?: "charging" | "charged" | "discharging" | null;
};

export type IosSimulatorAppState = {
  bundleId: string;
  running: boolean;
  pid: number | null;
  checkedAt: string;
};

/**
 * One row of the device hub's event log.
 *
 * `device` rows come from `log stream` on the simulator. `ade` rows are what
 * ADE itself did, interleaved in the same order, so a human reading the log
 * can see that the dark-mode switch happened between two app log lines. An
 * `ade` row carries the `ade ios-sim` command that reproduces it.
 */
export type IosSimulatorLogRow = {
  id: number;
  at: string;
  source: "device" | "ade";
  level: "default" | "info" | "debug" | "error" | "fault" | "action";
  process: string | null;
  subsystem: string | null;
  category: string | null;
  message: string;
  command?: string | null;
};

export type IosSimulatorEventLogArgs = IosSimulatorDeviceArgs & {
  /** Only rows after this id. */
  sinceId?: number | null;
  limit?: number | null;
};

export type IosSimulatorEventLogPage = {
  deviceUdid: string | null;
  running: boolean;
  rows: IosSimulatorLogRow[];
  /** Pass this back as `sinceId` on the next read. */
  cursor: number;
  /** Rows dropped from the head of the ring since the last read. */
  dropped: number;
  lastError: string | null;
};

export type IosSimulatorStartEventLogArgs = IosSimulatorDeviceArgs & {
  /**
   * Only keep rows whose `os_log` subsystem starts with this bundle id.
   *
   * Required, and there is no raw-predicate option, for the same reason.
   * `log stream` reads the whole device, so a missing scope returns every
   * other app's rows and the system's besides — a chat that asks for one app's
   * log must not be handed the device's.
   */
  bundleId: string;
  /** The chat that owns the device session, when one is open. */
  chatSessionId?: string | null;
  /** Take the event log from a chat that owns the device session. */
  force?: boolean | null;
};

/** The event log is one process per host, so stopping it is an ownership call. */
export type IosSimulatorStopEventLogArgs = {
  chatSessionId?: string | null;
  force?: boolean | null;
};

/**
 * How to name an element without naming a pixel.
 *
 * A coordinate tap is a guess that the layout did not move. A query is a
 * claim about the app: "the button labelled Continue". The first match wins
 * unless `index` says otherwise, and an action reports how many elements
 * matched so an ambiguous query is visible instead of silent.
 */
export type IosSimulatorElementQuery = {
  ref?: string | null;
  identifier?: string | null;
  label?: string | null;
  /** Substring, case-insensitive, matched against label and value. */
  text?: string | null;
  role?: string | null;
  index?: number | null;
};

export type IosSimulatorElementMatch = {
  ref: string;
  element: IosScreenElement;
  matchCount: number;
};

export type IosSimulatorElementActionKind = "tap" | "fill" | "wait" | "assert";

export type IosSimulatorElementActionResult = {
  ok: boolean;
  action: IosSimulatorElementActionKind;
  match: IosSimulatorElementMatch | null;
  matchCount: number;
  message: string | null;
  waitedMs: number | null;
};

export type IosSimulatorFindElementArgs = IosSimulatorDeviceArgs & {
  projectRoot?: string | null;
  laneId?: string | null;
  query: IosSimulatorElementQuery;
};

export type IosSimulatorTapElementArgs = IosSimulatorFindElementArgs;

export type IosSimulatorFillElementArgs = IosSimulatorFindElementArgs & {
  text: string;
  /** Tap the element first so the keyboard targets it. Defaults to true. */
  focusFirst?: boolean | null;
};

export type IosSimulatorWaitForElementArgs = IosSimulatorFindElementArgs & {
  /** Defaults to 5000. Capped at 60000. */
  timeoutMs?: number | null;
  /** Defaults to `visible`. */
  state?: "visible" | "gone" | null;
};

export type IosSimulatorAssertVisibleArgs = IosSimulatorFindElementArgs;

/**
 * Everything a reviewer needs to believe a screenshot.
 *
 * A bare PNG says what the screen looked like. It does not say which machine,
 * which simulator, which build root, or what the agent had just done — which
 * is exactly what a reviewer asks. The bundle writes all of it next to the
 * image.
 */
export type IosSimulatorProofBundleArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /** Directory to write into. Relative paths resolve against the build root. */
  outDir?: string | null;
  caption?: string | null;
  includeElements?: boolean | null;
  logRowLimit?: number | null;
};

export type IosSimulatorProofBundle = {
  dir: string;
  screenshotPath: string;
  metadataPath: string;
  elementsPath: string | null;
  logPath: string | null;
  caption: string | null;
  capturedAt: string;
};
