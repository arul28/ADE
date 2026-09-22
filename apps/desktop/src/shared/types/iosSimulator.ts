export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolStatus = {
  name: "xcrun" | "xcodebuild" | "simulator_window" | "helper";
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
  /** Which lane's session to end. Omitted resolves from the calling chat. */
  laneId?: string | null;
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
  /**
   * The device this lane owns, and how ADE got it.
   *
   * Distinct from `activeDevice`, which is whichever simulator the current
   * session happens to drive. A lane can own a device that is powered off and
   * driving nothing, and the column has to render that state.
   */
  laneDevice?: AppleLaneDevice | null;
  /** Which lane this status was computed for. Null for an un-laned caller. */
  laneId?: string | null;
  /** The vendored Swift helper. Replaces the old `idb` / `idb_companion` pair. */
  helper?: AppleHelperToolInfo | null;
  /**
   * The recording running on this lane's device right now, or null.
   *
   * Here so one `getStatus` answers "is something already recording?" — an
   * agent that starts a second one converts the auto recording to manual and
   * then owns the stop, which it cannot decide without knowing this.
   */
  recording?: IosSimulatorStatusRecording | null;
  /**
   * Every action this service will accept from an agent (§S2).
   *
   * Carried on status so an agent in a lane can learn what it may do with the
   * device from the tool it already calls, instead of reading source or
   * guessing verb names. Same names on `ade apple`, on the action bus, and
   * through `apple.invoke`.
   */
  capabilities?: readonly string[];
};

export type IosSimulatorStatusArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

/**
 * Every `ios_simulator` action an agent may call, in capability order.
 *
 * ONE list, read by three surfaces that used to keep three (round 5 §S2):
 * `ADE_ACTION_ALLOWLIST.ios_simulator` spreads it, `getStatus().capabilities`
 * reports it so an agent can discover the surface without reading source, and
 * `apple.invoke` gates the phone/web client on the same names. A capability
 * added to one of those and not the others is how `deviceStart` shipped
 * reachable from the desktop and unnamed everywhere else.
 *
 * The names are the SERVICE method names, which is also what `ade apple`
 * forwards for any subcommand it does not spell out. Add here first.
 */
export const APPLE_AGENT_ACTIONS = [
  /* Discovery. `getStatus` is the one-shot answer: platform, helper, lane
     device, stream, recording, and this list. */
  "getStatus",
  "listDevices",
  "listLaunchTargets",
  "claim",
  "attachToChatSession",

  /* The lane's device: find it, make one, bring it up, put it away. */
  "deviceList",
  "deviceCreate",
  "deviceAttach",
  "deviceStart",
  "deviceStop",
  "deviceDelete",
  "deviceDeleteInstalled",

  /* Video. */
  "startStream",
  "stopStream",
  "getStreamStatus",
  "frame",

  /* The app. */
  "launch",
  "relaunchApp",
  "terminateApp",
  "uninstallApp",
  "getAppState",
  "getForegroundApp",
  "openUrl",

  /* Input. `drag` with a duration is the scroll: a drag with no duration reads
     as a flick and scrolls nothing. */
  "tap",
  "typeText",
  "drag",
  "swipe",
  "scroll",
  "pressButton",
  "rotate",
  "selectPoint",

  /* Reading the screen by name rather than by pixel. */
  "getScreenSnapshot",
  "getInspectorSnapshot",
  "inspectPoint",
  "findElement",
  "tapElement",
  "fillElement",
  "waitForElement",
  "assertVisible",

  /* Device state, in place of a human in Settings. */
  "getDeviceSettings",
  "setAppearance",
  "setContentSize",
  "setAccessibilityOption",
  "setLocation",
  "clearLocation",
  "setPermission",
  "sendPushNotification",
  "setStatusBar",
  "clearStatusBar",

  /* The app's own log. */
  "startEventLog",
  "stopEventLog",
  "getEventLog",

  /* Evidence. Screenshots and recordings file themselves (§S3). */
  "screenshot",
  "captureProofBundle",
  "recordStart",
  "recordStop",
  "recordList",
  "recordDelete",
  "recordingsTotalBytes",

  /* SwiftUI previews. */
  "getPreviewCapability",
  "listPreviewTargets",
  "resolvePreviewMatch",
  "ensurePreviewWorkspace",
  "renderCurrentPreview",
  "renderPreview",
  "openPreviewWorkspace",

  /* Sessions. `shutdown` ends THIS CHAT'S claim; `deviceStop` powers the
     simulator off. They are different verbs and always have been. */
  "shutdown",
  "openDevice",
  "closeDevice",
  "getDeviceSession",
] as const;

export type AppleAgentAction = (typeof APPLE_AGENT_ACTIONS)[number];

/** The live recording, as `getStatus` reports it. */
export type IosSimulatorStatusRecording = {
  id: string;
  startedAt: string;
  mode: "auto" | "manual";
  /** The chat that owns it, so a second chat knows not to stop it. */
  chatSessionId: string | null;
};

/** The redacted live-view summary carried on `IosSimulatorStatus`. */
export type IosSimulatorStatusStream = {
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  deviceUdid: string | null;
  /** Measured by the helper's own encoder. */
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
  chatSessionId?: string | null;
  /**
   * File the PNG in the proof drawer. Default ON (round 5 §S3).
   *
   * A screenshot nobody can see is not evidence. Recordings have filed
   * themselves since round 3; a still had to be promoted by a second command
   * (`ade apple proof`) that agents forgot and the rail's Screenshot button
   * never ran at all — it wrote a PNG into a cache directory and told nobody.
   * Internal callers that already produce their own artifact — the proof
   * bundle's `screen.png`, the inspector's hit-test still — pass `false`.
   */
  proof?: boolean | null;
  /** Caption for the drawer row. Defaults to device + timestamp. */
  caption?: string | null;
};

export type IosSimulatorScreenshot = {
  deviceUdid: string;
  dataUrl: string;
  /** Absolute path of the written PNG. Agents read this instead of the data URL. */
  filePath: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
  /**
   * The proof-drawer row this screenshot was filed as, when it was filed.
   *
   * `null` means it was not filed (opted out, no drawer wired, or the drawer
   * refused it). Never a reason to fail the capture: the PNG on disk is the
   * result the caller asked for.
   */
  proofArtifactId?: string | null;
};

export type IosSimulatorStreamStatus = {
  deviceUdid: string | null;
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  requestedBackend?: IosSimulatorStreamBackend | null;
  fallbackReason?: string | null;
  degradationReason?: string | null;
  /**
   * Measured frame rate. The service never counts frames — the viewer that
   * decodes them does — so this stays null service-side instead of reporting a
   * number nobody counted.
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
  inputBackend?: "helper" | null;
  /** Where a viewer connects, and with what token. Minted by `startStream`. */
  transport?: IosSimulatorStreamTransport | null;
  /** Measured by the helper's encoder. */
  bitrateKbps?: number | null;
};

/**
 * There is ONE backend now.
 *
 * `helper-h264` is the vendored Swift helper (`native/ADESimHelper`) capturing
 * the simulator's own framebuffer, encoding H.264 on the machine that owns the
 * device, and serving access units over loopback HTTP. It replaced both of the
 * old names: `simulator-window-capture` (the renderer mirroring a real
 * Simulator.app window, which forced a Screen Recording grant, a visible
 * window, and a bezel in the picture) and `idb-h264` (which needed idb and
 * idb_companion installed). Keeping the field rather than deleting it means a
 * status reader still says WHICH engine produced the pixels; it just has one
 * answer.
 */
export type IosSimulatorStreamBackend = "helper-h264";

/*
 * The window-capture types lived here: `IosSimulatorWindowSource`,
 * `IosSimulatorWindowIssue`, `IosSimulatorWindowState`,
 * `IosSimulatorWindowCaptureSessionHint`, `IosSimulatorWindowSourcesResult`
 * and `IosSimulatorPrivacyPane`. Every one of them described a picture of
 * Simulator.app — a window id, whether that window was hidden or minimized,
 * and which macOS privacy grant was missing before the renderer could mirror
 * it. The helper reads the framebuffer directly, so there is no window, no
 * grant, and nothing left to describe.
 */

export type IosSimulatorPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

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
  laneId?: string | null;
  chatSessionId?: string | null;
  fps?: number | null;
  /** 0.1 to 1. Lower sends fewer pixels over the wire. */
  scaleFactor?: number | null;
  /**
   * 0.1 to 1. Lower spends fewer bits per pixel.
   *
   * Carried for callers that still pass it; the helper's encoder takes a
   * bitrate rather than a quality ratio, so it is advisory.
   */
  compressionQuality?: number | null;
  /** Caps the encoder's bitrate. Defaults to the `apple.remoteBitrateKbpsCap` setting. */
  bitrateKbps?: number | null;
  /**
   * Set by the desktop preload when a renderer on this machine is the caller.
   *
   * The relay consults it before stopping a capture for its last remote viewer:
   * a web tab can start the capture that the desktop column then joins, and
   * without this the tab closing would black out the column.
   */
  localViewer?: boolean;
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
  laneId?: string | null;
  chatSessionId?: string | null;
  deviceUdid?: string | null;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs?: number | null;
  delta?: number | null;
  source?: AppleInputSource;
};

/**
 * Who drove the device on an injected-input call.
 *
 * `user` is the desktop pane, the mini player, and the phone/web viewers — a
 * person looking at the screen. Anything else is an agent, and only an agent's
 * input starts an automatic recording (round 3, A2). The preload stamps this
 * on every call the renderer makes; nothing else sets it, so the default is
 * the safe one.
 */
export type AppleInputSource = "user" | "agent";

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
  | { type: "device-settings-changed"; settings: IosSimulatorDeviceSettings }
  | AppleDeviceStateEvent;

/**
 * Where `deviceStart` is in bringing a lane's device up.
 *
 * `starting` is emitted once the device is known (attached or created) and
 * before `simctl boot`; `booted` once `bootstatus` returns; `streaming` once
 * the helper capture is open; `failed` on any error, with `detail` carrying
 * the message. The loading card advances its two segments on these.
 *
 * `stopped` is `deviceStop`'s: the simulator is powered off and the lane still
 * owns it, so the pane swaps to "{name} is off. [Start]" without re-listing.
 *
 * `released` is the opposite pair: the simulator keeps running and the lane no
 * longer OWNS it, because another lane took it over. It is deliberately not
 * `stopped` — nothing was powered off, and a pane told "off" would offer Start
 * on a device that is not its own any more. The lane that lost it must
 * re-list, which is the one phase that means "your binding changed".
 */
export type AppleDeviceStatePhase =
  | "starting"
  | "booted"
  | "streaming"
  | "failed"
  | "stopped"
  | "released";

export type AppleDeviceStateEvent = {
  type: "apple.device.state";
  laneId: string;
  udid: string;
  phase: AppleDeviceStatePhase;
  detail?: string;
};

/* ------------------------------------------------------------------------- *
 * Device hub: device sessions, host-encoded video, device tools, semantic
 * actions, and the event log.
 *
 * The old window-capture backend only worked when the Simulator ran on the
 * same Mac as the ADE window, because the renderer captured the Simulator.app
 * window itself, so a chat pinned to a remote Mac had a live view it could
 * never show. The helper encodes on the machine that owns the simulator and
 * hands every viewer a loopback URL instead of a window id, so a Mac bound to
 * another Mac — and a phone, and a web tab — watch the same session the agent
 * drives.
 *
 * The Work tools pane offers the Apple tool when the bound runtime reports
 * `supported: true` (`iosSimulator.getStatus()`), not when the viewer's OS is
 * macOS. A Windows desktop pinned to a remote Mac can open the column; a
 * Linux runtime cannot.
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
  /** Frame size in PIXELS — what the decoder produces. */
  width: number | null;
  height: number | null;
  /**
   * Screen size in POINTS — what every input call takes.
   *
   * Both are needed and they are not the same number: a 3× phone decodes at
   * 1179×2556 and is 393×852 points. A viewer that laid its frame out in
   * pixels and then sent pointer coordinates straight to `tap` was sending
   * three times the intended position, which is why taps in round 2 landed
   * nowhere and the pane looked unresponsive.
   */
  pointWidth: number | null;
  pointHeight: number | null;
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
  "button-shapes",
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
  /**
   * Which lane's device session answers. Omitted resolves from the calling
   * chat, then from the single un-laned session, exactly as the build root
   * ladder resolves a project root.
   */
  laneId?: string | null;
  chatSessionId?: string | null;
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
 * The app in front of the simulator right now, read through the helper's
 * accessibility bridge. `null` when nothing but SpringBoard is up.
 */
export type IosSimulatorForegroundApp = {
  bundleId: string;
  pid: number | null;
  checkedAt: string;
} | null;

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
  chatSessionId?: string | null;
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
  /** The device the bundle was taken from, carried so the drawer row can name it. */
  deviceUdid: string;
  width: number | null;
  height: number | null;
  /**
   * The proof-drawer row for `screen.png`, or null when no filer is attached.
   *
   * `proof-bundle` is a proof verb and filed nothing at all until this existed:
   * it wrote the directory and returned, so a reviewer had no row to open and
   * an agent reporting "proof filed" was wrong.
   */
  proofArtifactId?: string | null;
};

/* ───────────────────────── Apple device environment ───────────────────────── */

/** A lane may not delete a simulator it merely attached. */
export const APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE = "APPLE_DEVICE_ATTACHED_NOT_DELETABLE" as const;
/** The lane already owns a device; delete it before creating another. */
export const APPLE_DEVICE_EXISTS_CODE = "APPLE_DEVICE_EXISTS" as const;
/**
 * A lane holds this simulator, so it is not the picker's to delete.
 *
 * Deleting a device out from under another lane would take its live view away
 * with no warning on that lane's screen. The lane that owns it gives it up
 * through `deviceDelete`, which stops its stream first.
 */
export const APPLE_DEVICE_OWNED_BY_LANE_CODE = "APPLE_DEVICE_OWNED_BY_LANE" as const;
/**
 * The chosen clone template is running, and `simctl` cannot clone a booted
 * device (error 405, "Unable to clone device in current state: Booted").
 */
export const APPLE_TEMPLATE_BOOTED_CODE = "APPLE_TEMPLATE_BOOTED" as const;
/** No simulator runtime is installed, and ADE never downloads one. */
export const APPLE_NO_INSTALLED_SIMULATORS_CODE = "APPLE_NO_INSTALLED_SIMULATORS" as const;
/** The vendored Swift helper is missing, not running, or not answering. */
export const APPLE_HELPER_UNAVAILABLE_CODE = "APPLE_HELPER_UNAVAILABLE" as const;
/** `frame` needs a running stream; `screenshot` does not. */
export const APPLE_STREAM_NOT_RUNNING_CODE = "APPLE_STREAM_NOT_RUNNING" as const;
/** A recording marked `proof` cannot be deleted by an agent. */
export const APPLE_RECORDING_PINNED_CODE = "APPLE_RECORDING_PINNED" as const;
/**
 * A hardware button this helper (and this Xcode's `simctl`) cannot press.
 *
 * `shake` is the current case: it is not a helper `button` name, and `simctl`
 * has no shake verb. Other unknown names use the same code so callers can
 * branch once.
 */
export const APPLE_BUTTON_UNSUPPORTED_CODE = "APPLE_BUTTON_UNSUPPORTED" as const;

export type AppleLaneDeviceFamily = "iphone" | "ipad" | "watch";

/** A simulator this Mac actually has. Never a runtime that could be downloaded. */
export type AppleInstalledSimulator = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
  family: AppleLaneDeviceFamily;
  deviceTypeIdentifier: string | null;
};

/**
 * The one device a lane owns.
 *
 * `origin` is the whole reason this record exists rather than a bare udid:
 * `clone` is ADE's to delete on lane archive, `attached` is the user's and is
 * only ever detached.
 */
export type AppleLaneDevice = {
  laneId: string;
  udid: string;
  name: string;
  origin: "clone" | "attached";
  family: AppleLaneDeviceFamily;
  runtime: string;
  createdAt: string;
  templateUdid: string | null;
};

export type AppleDeviceCreateArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  /** udid or name of an installed simulator to clone. Defaults per the spec. */
  from?: string | null;
  name?: string | null;
};

export type AppleDeviceAttachArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  /** udid or name of an installed simulator to bind without cloning. */
  simulator: string;
};

export type AppleDeviceListArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  installed?: boolean | null;
  /**
   * Also measure what CoreSimulator's device store costs on disk.
   *
   * OFF by default and asked for separately, because it is the one expensive
   * part of this call: measuring means walking the device directories, and the
   * picker must paint its list before it knows the numbers. The renderer makes
   * a second, disk-only call after the first paint.
   */
  disk?: boolean | null;
};

/**
 * `deviceStart`: attach (or create) if the lane has no device, boot it if it
 * is shut down, wait for `bootstatus`, then open the live view — one call for
 * the picker's Start/Open/Create actions and for `ade apple start`.
 *
 * `udid` names an installed simulator to attach when the lane owns nothing.
 * `create.sourceUdid` clones that simulator for the lane instead. Neither is
 * consulted when the lane already owns a device: that device is started.
 */
export type AppleDeviceStartArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  udid?: string | null;
  create?: { sourceUdid: string } | null;
};

/**
 * Which lane holds a given simulator, by name.
 *
 * `deviceList` used to answer only "what is installed" and "what does MY lane
 * own", which left the picker unable to tell a free device from one another
 * lane is driving. It offered Open on a simulator lane B was mid-test in, and
 * an agent that could not see the difference stopped to ask a human for
 * permission instead of creating its own device. `laneName` is the display
 * name and not the id on purpose: "in use by lane dca9f144" names nothing a
 * person recognises.
 */
export type AppleSimulatorOwner = {
  udid: string;
  laneId: string;
  /** The lane's display name, or null when the lane row is gone or unnamed. */
  laneName: string | null;
  origin: "clone" | "attached";
  /** True when the owning lane is the lane this list was computed for. */
  mine: boolean;
};

/** One device data directory's cost on disk. */
export type AppleSimulatorDiskUsage = {
  udid: string;
  bytes: number;
};

/**
 * What the simulators on this Mac cost on disk.
 *
 * Measured only when `deviceList` is asked for it. One `du` pass over
 * CoreSimulator's device store answers both halves — the per-device rows and
 * the store's own total — so the picker never pays for two walks.
 */
export type AppleDeviceDiskUsage = {
  /** Every byte under the device store, including devices no lane owns. */
  totalBytes: number;
  /** Bytes per device directory. A device with no directory yet is absent. */
  devices: AppleSimulatorDiskUsage[];
  /** The directory that was measured, so a surprising number is checkable. */
  root: string;
  measuredAt: string;
};

export type AppleDeviceListResult = {
  installed: AppleInstalledSimulator[];
  lane: AppleLaneDevice | null;
  /**
   * Every lane binding this project knows about, mine flagged.
   *
   * Complete rather than filtered: the picker's three groups (mine, free, in
   * use elsewhere) are a partition of the installed list against this array,
   * and a payload that carried only the caller's lane could not express the
   * third group at all.
   */
  owners: AppleSimulatorOwner[];
  /** Which lane this list was computed for. Null for an un-laned caller. */
  laneId: string | null;
  /** Present only when `disk` was asked for. */
  disk?: AppleDeviceDiskUsage | null;
};

export type AppleDeviceDeleteArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean | null;
};

/**
 * `deviceDeleteInstalled`: remove one simulator the owner picked from the list.
 *
 * Not the same verb as `deviceDelete`, which means "this lane gives up its own
 * device". This one is housekeeping — usually disk — and it refuses any
 * simulator a lane holds with `APPLE_DEVICE_OWNED_BY_LANE`.
 */
export type AppleDeviceDeleteInstalledArgs = {
  udid: string;
  /**
   * The owner said yes to THIS device, by name, in a confirmation.
   *
   * Required, and deliberately not defaulted. Deleting a simulator is not
   * recoverable, the owner's standing rule is that nothing deletes one without
   * their approval, and this verb is reachable by any agent because ADE keeps
   * one action list per domain. A caller that has to write the claim out
   * cannot arrive here by drifting through a default.
   */
  confirmedByUser: true;
  laneId?: string | null;
  projectRoot?: string | null;
};

/**
 * `deviceStop`: power the lane's simulator OFF and leave it registered.
 *
 * The opposite of `deviceStart`, and deliberately not `shutdown`. `shutdown`
 * ends the chat's *session* — it releases the ownership claim and stops the
 * stream, and the simulator keeps running. Round 4 wired "Close and shut down"
 * to it, so the tools card still read "ADE Repro · Running" the moment the tab
 * closed and the device came straight back. This is the verb that runs
 * `simctl shutdown`.
 *
 * The lane device stays in the registry: powering a device off says nothing
 * about which device the lane uses, so the pane's next visit offers Start
 * rather than the picker. `deviceDelete` is the verb that un-registers.
 */
export type AppleDeviceStopArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  /** Power off this simulator instead of the lane's. Rarely needed. */
  udid?: string | null;
  /** Release a session another chat owns as well. */
  force?: boolean | null;
  /**
   * Stop for whoever is running, without claiming to be them.
   *
   * The Work pane's close path: it is lane-scoped, it drives whatever session
   * its lane is running, and it must not impersonate the owner to do it.
   */
  ignoreOwnership?: boolean | null;
};

export type AppleDeviceStopResult = {
  /** The simulator that was asked to power off, or null when the lane owns none. */
  udid: string | null;
  /** `simctl shutdown` reported the device off. False when it was already off. */
  poweredOff: boolean;
  /** The device state before the call, as `simctl` reported it. */
  previousState: string | null;
  /** A chat session claim was released as part of this. */
  released: boolean;
  /** The lane still owns this device. Always true unless the lane owned none. */
  stillRegistered: boolean;
};

/**
 * Which way the VIEWPORT travels, the way a reader means it.
 *
 * `down` reveals what is below, like a page-down — which on a touch screen is
 * a finger swiping UP. The sign flip lives in the service so no caller has to
 * hold both models in its head; the helper's own `scroll` speaks in content
 * movement, and `ade apple scroll down` has to mean what a person says.
 */
export const APPLE_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type AppleScrollDirection = (typeof APPLE_SCROLL_DIRECTIONS)[number];

/**
 * `scroll`: the helper's own scroll gesture, which nothing in ADE could reach.
 *
 * The vendored helper has had a `scroll` command since it was vendored — it
 * turns the delta into a touch drag on the digitizer and RE-ANCHORS when the
 * finger nears an edge, so a scroll longer than the screen keeps going instead
 * of stopping at the bezel. Nothing in TypeScript ever sent it: the pane's
 * wheel handler and every agent fell back to `drag`, which is one finger
 * stroke bounded by the screen. Round 5 §S2 exposes it under its own name.
 */
export type AppleScrollArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  deviceUdid?: string | null;
  direction: AppleScrollDirection;
  /** How far, in device pixels. Defaults to roughly one screen. */
  amount?: number | null;
  /**
   * Where the finger lands, in device POINTS. Both or neither.
   *
   * iOS hit-tests the scroll view under the touch, so an anchor is how a
   * caller scrolls a bottom sheet rather than the map behind it. Omitted means
   * the centre of the screen.
   */
  anchorX?: number | null;
  anchorY?: number | null;
  /**
   * Whether the gesture came from a person at this window or from an agent.
   * The preload stamps `"user"` on the pane's wheel handler; without it a
   * human scroll would look like agent input and start an auto-recording.
   */
  source?: AppleInputSource;
};

export type AppleScrollResult = {
  ok: true;
  direction: AppleScrollDirection;
  /** What the helper was told, in its own content-movement convention. */
  deltaX: number;
  deltaY: number;
};

export type AppleFrameArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  deviceUdid?: string | null;
  outPath?: string | null;
};

export type AppleFrameResult = {
  filePath: string;
  width: number;
  height: number;
};

/** Hardware buttons `pressButton` accepts. `shake` is named here so the column can call it; the service refuses it with `APPLE_BUTTON_UNSUPPORTED`. */
export const APPLE_HARDWARE_BUTTONS = [
  "home",
  "lock",
  "volume-up",
  "volume-down",
  "siri",
  "shake",
] as const;
export type AppleHardwareButtonName = (typeof APPLE_HARDWARE_BUTTONS)[number];

export type ApplePressButtonArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  deviceUdid?: string | null;
  name: AppleHardwareButtonName;
};

export type ApplePressButtonResult = {
  ok: true;
};

/**
 * Values the helper's `orientation` command understands.
 *
 * These are UIInterfaceOrientation numbers, which is what `HIDInjector`
 * sends: portrait=1, portrait-upside-down=2, landscape-right=3,
 * landscape-left=4. (UIDeviceOrientation swaps the two landscapes.)
 */
export const APPLE_DEVICE_ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const;
export type AppleDeviceOrientation = (typeof APPLE_DEVICE_ORIENTATIONS)[number];

export type AppleRotateArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  deviceUdid?: string | null;
  orientation: AppleDeviceOrientation;
};

/**
 * How `rotate` knows what it is telling you.
 *
 * `rotate` used to answer `applied: true` the instant the helper's GSEvent
 * left the host, which says only that a mach message was sent. Measured on
 * 2026-09-21 against a machine with no `Simulator.app` on it at all: the
 * simulator accepts that event anyway and the DEVICE orientation really does
 * change. What refuses is the foreground app. SpringBoard and Settings on an
 * iPhone are portrait-only, so the framebuffer stayed 1179x2556 through four
 * landscape rotates that all reported success — and then Safari, launched on
 * the same device with the device already turned, came up at 2556x1179 on its
 * first frame.
 *
 * So the send is never the answer. The framebuffer is.
 */
export const APPLE_ROTATE_VERIFICATIONS = [
  /** The framebuffer turned onto the requested axis. Proof that it moved. */
  "rotated",
  /**
   * The framebuffer was already on the requested axis. A 180-degree flip
   * inside one axis (`portrait` <-> `portrait-upside-down`, or one landscape
   * to the other) leaves the geometry identical, so that part is not
   * observable from pixels and is deliberately not claimed.
   */
  "already-on-axis",
  /** The event was sent and accepted, and the screen never turned. */
  "not-adopted",
  /** The helper could not send the event at all. */
  "send-failed",
  /** The framebuffer could not be read, so nothing is claimed either way. */
  "unmeasurable",
] as const;
export type AppleRotateVerification = (typeof APPLE_ROTATE_VERIFICATIONS)[number];

/** The device took the orientation; the app on screen kept its own. */
export const APPLE_ROTATE_NOT_ADOPTED_CODE = "APPLE_ROTATE_NOT_ADOPTED";
/** The helper never got the event onto the device. */
export const APPLE_ROTATE_SEND_FAILED_CODE = "APPLE_ROTATE_SEND_FAILED";
/** No framebuffer reading, so no claim. */
export const APPLE_ROTATE_UNMEASURABLE_CODE = "APPLE_ROTATE_UNMEASURABLE";

/** Framebuffer pixels, which is the only orientation reading iOS gives back. */
export type AppleRotateFrame = {
  width: number;
  height: number;
};

export type AppleRotateResult = {
  /**
   * True only when the framebuffer was **observed** showing the requested
   * axis. A send that iOS ignored reports `false`, not `true`.
   */
  applied: boolean;
  /** The orientation that was asked for. */
  orientation: AppleDeviceOrientation;
  /** Which of the five outcomes above this was. */
  verification: AppleRotateVerification;
  /** A machine-readable code. Present exactly when `applied` is false. */
  reason: string | null;
  /** One sentence, for a rail or a CLI line to show as-is. */
  detail: string | null;
  /** Framebuffer pixels read before the request, and after the wait. */
  frameBefore: AppleRotateFrame | null;
  frameAfter: AppleRotateFrame | null;
};

export type AppleRecordStartArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
  /**
   * The caller's workspace, so a caller with no lane id is placed by the
   * worktree it stands in — the same field the screenshot verbs send.
   *
   * Recordings were the one capture path that did not carry it, so an unbound
   * caller's recording filed against whichever lane owned the DEVICE.
   */
  projectRoot?: string | null;
  overlays?: boolean | null;
  label?: string | null;
};

export type AppleRecordStopArgs = {
  /** The caller's workspace, so a lane-less caller is placed by where it stands. */
  projectRoot?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  keep?: boolean | null;
  discard?: boolean | null;
};

export type AppleRecordListArgs = {
  /** The caller's workspace, so a lane-less caller is placed by where it stands. */
  projectRoot?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type AppleRecordDeleteArgs = {
  /** The caller's workspace, so a lane-less caller is placed by where it stands. */
  projectRoot?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  id: string;
  force?: boolean | null;
  /**
   * The user pressed Delete in the drawer.
   *
   * Every stopped recording is proof now, so this is what separates "the
   * person who owns this Mac asked" from "an agent tried to delete the
   * evidence" — which is still refused with `APPLE_RECORDING_PINNED`.
   */
  allowProof?: boolean | null;
};

/** What `status.tools` reports for the vendored helper. */
export type AppleHelperToolInfo = {
  present: boolean;
  path: string;
  version: number | null;
};
