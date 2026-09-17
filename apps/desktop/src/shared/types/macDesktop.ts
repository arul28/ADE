/**
 * The Mac Desktop contract: one private macOS screen per lane.
 *
 * Every type here crosses a process boundary — renderer to Electron main, CLI
 * to the ADE runtime, runtime to the native `ade-desktop-driver` helper — so
 * this file is the single place the shapes are written down.
 *
 * Two deliberate shapes are worth naming before you read the rest.
 *
 * `DesktopSeatProvider` is a provider interface with exactly one implementation
 * today, the Mac virtual-display backend. A Linux "seat" (a container with its
 * own X display) is a later lane, and the interface exists so that lane adds a
 * file rather than reshaping this one. Do not add a second backend's concepts
 * here before its backend exists — an interface written for an absent
 * implementation is a guess, not a contract.
 *
 * `MacDesktopStatus` is the capability gate. `getStatus` answers on every
 * platform; every other method rejects off macOS. That asymmetry is the same
 * one the iOS simulator uses and for the same reason: a non-Mac desktop learns
 * it cannot host a display by *reading*, and a read that throws cannot tell it.
 */

import type { AgentActionTraceEntry, AgentFrame } from "./agentObservation";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Codes carried on thrown errors. The service states the fact and the code and
 * stops there; the "now run this" half lives in the CLI's own hint, keyed off
 * the code, exactly as `iosSimulatorErrorHint` does. The drawer and the phone
 * read the same string and cannot run a shell command.
 */
export const MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE = "MAC_DESKTOP_UNSUPPORTED_PLATFORM" as const;
export const MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE = "MAC_DESKTOP_DRIVER_UNAVAILABLE" as const;
export const MAC_DESKTOP_PERMISSION_REQUIRED_CODE = "MAC_DESKTOP_PERMISSION_REQUIRED" as const;
export const MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE = "MAC_DESKTOP_DISPLAY_UNAVAILABLE" as const;
export const MAC_DESKTOP_NO_DISPLAY_CODE = "MAC_DESKTOP_NO_DISPLAY" as const;
export const MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE = "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE" as const;
export const MAC_DESKTOP_WINDOW_NOT_FOUND_CODE = "MAC_DESKTOP_WINDOW_NOT_FOUND" as const;
export const MAC_DESKTOP_HANDLE_EXPIRED_CODE = "MAC_DESKTOP_HANDLE_EXPIRED" as const;
export const MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE = "MAC_DESKTOP_INPUT_LEASE_REQUIRED" as const;
export const MAC_DESKTOP_USER_HAS_CONTROL_CODE = "MAC_DESKTOP_USER_HAS_CONTROL" as const;
export const MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE = "MAC_DESKTOP_LEASE_HELD_BY_OTHER" as const;
export const MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE = "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT" as const;
export const MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE = "MAC_DESKTOP_RECORDING_NOT_RUNNING" as const;

export type MacDesktopErrorCode =
  | typeof MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE
  | typeof MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE
  | typeof MAC_DESKTOP_PERMISSION_REQUIRED_CODE
  | typeof MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE
  | typeof MAC_DESKTOP_NO_DISPLAY_CODE
  | typeof MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE
  | typeof MAC_DESKTOP_WINDOW_NOT_FOUND_CODE
  | typeof MAC_DESKTOP_HANDLE_EXPIRED_CODE
  | typeof MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE
  | typeof MAC_DESKTOP_USER_HAS_CONTROL_CODE
  | typeof MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE
  | typeof MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE
  | typeof MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE;

/** The one sentence every non-macOS rejection carries. */
export const MAC_DESKTOP_MACOS_ONLY_MESSAGE =
  "A Mac Desktop display is only available on a macOS runtime host.";

// ---------------------------------------------------------------------------
// Capability and health
// ---------------------------------------------------------------------------

export type MacDesktopPermissionState = "granted" | "denied" | "unknown";

export type MacDesktopPermissions = {
  /** ScreenCaptureKit needs this before any frame exists. */
  screenRecording: MacDesktopPermissionState;
  /** The Accessibility API needs this before any element action works. */
  accessibility: MacDesktopPermissionState;
};

/**
 * Helper health, modelled on `AttentionNotchHealth` so the same settings-style
 * recovery verbs reach the UI.
 */
export type MacDesktopDriverState =
  | "running"
  | "starting"
  | "missing"
  | "crash_loop"
  | "protocol_error"
  | "unsupported";

export type MacDesktopDriverHealth = {
  state: MacDesktopDriverState;
  title: string;
  message: string;
  recovery: "retry" | "reinstall_or_update" | "grant_permission" | null;
  version: string | null;
};

/**
 * How the lane's windows are actually being kept off the user's screen.
 *
 * `virtual` is the real thing. `offscreen-region` is the fail-closed fallback
 * for a macOS release that removed the private virtual-display classes: the
 * windows sit outside the main display's visible frame, which is genuinely
 * weaker, so it is reported rather than hidden. `unavailable` means neither
 * worked and nothing is parked.
 */
export type MacDesktopDisplayMode = "virtual" | "offscreen-region" | "unavailable";

// ---------------------------------------------------------------------------
// The display
// ---------------------------------------------------------------------------

/**
 * Resolution of a lane's display. 4K costs real encode bandwidth for a screen
 * nobody is reading at full size, so the default is a comfortable working size
 * and the large option is opt-in through settings.
 */
export type MacDesktopResolutionPreset = "1440p" | "1080p" | "4k";

export const MAC_DESKTOP_RESOLUTION_PRESETS: Record<
  MacDesktopResolutionPreset,
  { width: number; height: number; label: string }
> = {
  "1080p": { width: 1920, height: 1080, label: "1920 x 1080" },
  // The default. Enough room for an editor beside a simulator, and about half
  // the pixels of 4K to encode.
  "1440p": { width: 2560, height: 1440, label: "2560 x 1440" },
  "4k": { width: 3840, height: 2160, label: "3840 x 2160" },
};

export const MAC_DESKTOP_DEFAULT_RESOLUTION: MacDesktopResolutionPreset = "1440p";

export type MacDesktopDisplay = {
  laneId: string;
  /**
   * CoreGraphics display id, or `null` when there is no CoreGraphics display
   * behind the lane — which is every `offscreen-region` display. `0` is a
   * legal display id on macOS, so absence has to be its own value rather than
   * a sentinel every reader would have to know about.
   */
  displayId: number | null;
  /** "ADE · <lane name>" — what Mission Control and Displays show. */
  name: string;
  mode: MacDesktopDisplayMode;
  width: number;
  height: number;
  /** Backing scale factor. 2 for a HiDPI display. */
  scale: number;
  /** Origin of the display on the global coordinate plane. */
  origin: { x: number; y: number };
  createdAt: string;
  /** Windows parked here right now. */
  windowCount: number;
  /** Last time an agent action, an input event, or a viewer touched it. */
  lastActivityAt: string;
};

export type MacDesktopLaneSummary = {
  laneId: string;
  laneName: string | null;
  /** Null in `offscreen-region` mode. See `MacDesktopDisplay.displayId`. */
  displayId: number | null;
  windowCount: number;
  streaming: boolean;
};

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type MacDesktopWindowOrigin = "ade_launched" | "claimed" | "adopted";

export type MacDesktopWindow = {
  /** CoreGraphics window number. Dies with its process; never cache it. */
  id: number;
  pid: number;
  appName: string;
  bundleId: string | null;
  title: string | null;
  frame: AgentFrame;
  /** Null while the window is not parked on a lane display. */
  laneId: string | null;
  origin: MacDesktopWindowOrigin;
  onDisplayId: number | null;
  minimized: boolean;
  /** Set when this app refuses to run twice, so one lane holds it at a time. */
  singleInstance: boolean;
};

export type MacDesktopOpenArgs = {
  laneId: string;
  /** An app name, a bundle id, a filesystem path, or a URL. */
  target: string;
  /** Extra arguments passed to the launched app. */
  args?: string[] | null;
  chatSessionId?: string | null;
};

export type MacDesktopOpenResult = {
  laneId: string;
  pid: number | null;
  appName: string | null;
  bundleId: string | null;
  /** Windows parked so far. An app that opens its window late reports none. */
  windows: MacDesktopWindow[];
  /** True when the driver is still watching this pid for late windows. */
  watching: boolean;
};

export type MacDesktopClaimArgs = {
  laneId: string;
  windowId: number;
  chatSessionId?: string | null;
};

export type MacDesktopReleaseArgs = {
  laneId: string;
  /** Omit to release every window this lane holds. */
  windowId?: number | null;
};

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * One accessibility element.
 *
 * Deliberately not `AgentElementSnapshot`: that shape is DOM-flavoured
 * (`tagName`, `selector`, `href`, `testId`) because the browser and App Control
 * share one in-page collector. macOS has no DOM. Reusing the DOM type here
 * would have meant six null fields on every element and no home for the two
 * that matter — `subrole` and the element's supported `actions`.
 *
 * `frame` is in global screen points, the same plane the display's `origin`
 * uses, so a point on the stream maps to a point here without a second space.
 */
export type MacDesktopElement = {
  index: number;
  /** `obs-<observationId>:e:<index>`. Valid only for its own observation. */
  handle: string;
  role: string;
  subrole: string | null;
  title: string | null;
  label: string | null;
  value: string | null;
  identifier: string | null;
  help: string | null;
  enabled: boolean;
  focused: boolean;
  /** Accessibility actions this element answers, e.g. `AXPress`. */
  actions: string[];
  frame: AgentFrame;
  center: { x: number; y: number };
  windowId: number | null;
  pid: number;
  /** Index into the observation's element list, or null for a root. */
  parentIndex: number | null;
};

export type MacDesktopObservation = {
  id: string;
  laneId: string;
  capturedAt: string;
  /** Host-absolute path to the screenshot. Opaque to clients. */
  screenshotPath: string;
  /** Host-absolute path to the numbered element map, when `--map` was asked. */
  mapPath: string | null;
  display: { width: number; height: number; scale: number };
  windows: MacDesktopWindow[];
  elements: MacDesktopElement[];
  /** Total elements found before the observation cap trimmed the list. */
  elementCount: number;
  /** True when `elements` is shorter than `elementCount`. */
  truncated: boolean;
  /** One line describing what produced this frame, e.g. "click · Sign in". */
  caption: string | null;
};

export type MacDesktopObserveArgs = {
  laneId: string;
  /** Limit the tree to one parked window instead of the whole display. */
  windowId?: number | null;
  /** Write a numbered element map image beside the screenshot. */
  map?: boolean | null;
  /** Cap on returned elements. The service clamps this. */
  limit?: number | null;
  chatSessionId?: string | null;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * How an input command reaches the app.
 *
 * `accessibility` is the default and needs no lease: it performs an action on
 * one element in one process and moves no pointer. `real` posts a `CGEvent`,
 * which is global to the machine, so it is the one capability behind the lease.
 */
export type MacDesktopInputMode = "accessibility" | "real";

/** One way of naming what to act on, in the order the service resolves them. */
export type MacDesktopTarget = {
  /** A handle from the most recent observation. */
  handle?: string | null;
  /** Case-insensitive match against an element's title, label, or value. */
  text?: string | null;
  /** Global screen point. Needs `mode: "real"` unless an element is under it. */
  x?: number | null;
  y?: number | null;
  windowId?: number | null;
};

/**
 * Who is asking, when it is not a chat.
 *
 * Real input is checked against the lease *holder*, and a human takeover holds
 * the lease under the controller id the viewing client minted
 * (`ade-window:<uuid>`), never under a chat session id. A panel that sent only
 * its `chatSessionId` was therefore refused with `MAC_DESKTOP_USER_HAS_CONTROL`
 * for input the user had just taken control to perform. `controllerId` is that
 * client saying which holder it is; the service prefers it over
 * `chatSessionId` when checking the lease, and it authorizes nothing on its
 * own — an id that does not hold the lease is refused exactly as before.
 */
export type MacDesktopControllerArgs = {
  controllerId?: string | null;
};

/**
 * "Act, and do not look."
 *
 * Every acting command re-observes afterwards, because an agent's next decision
 * needs the screen it just changed. A human driving the display needs none of
 * that: they are watching the live stream, the observation costs a full capture
 * and an AX walk per keystroke, and each one lands in the chat as an
 * `observation` event with a caption describing what the *user* just did.
 *
 * So a takeover asks for silence. It is deliberately not a flag an agent can
 * set on its own: the service only honours it for `mode: "real"` from a caller
 * that named a `controllerId`, which is the id a human takeover holds the lease
 * under and which nothing else can hold while it does.
 */
export type MacDesktopSilentArgs = {
  /** Skip the post-action observation and emit no `observation` event. */
  silent?: boolean | null;
};

export type MacDesktopClickArgs = MacDesktopTarget & MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  mode?: MacDesktopInputMode | null;
  button?: "left" | "right" | null;
  count?: number | null;
  chatSessionId?: string | null;
};

export type MacDesktopTypeArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  text: string;
  /** Replace the focused element's value instead of appending to it. */
  clear?: boolean | null;
  mode?: MacDesktopInputMode | null;
  target?: MacDesktopTarget | null;
  chatSessionId?: string | null;
};

export type MacDesktopPressArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  /** A key name (`return`, `tab`, `escape`, `f5`) or a single character. */
  key: string;
  modifiers?: Array<"cmd" | "shift" | "option" | "control"> | null;
  mode?: MacDesktopInputMode | null;
  chatSessionId?: string | null;
};

export type MacDesktopScrollArgs = MacDesktopTarget & MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  direction: "up" | "down" | "left" | "right";
  /** Scroll lines. The service clamps this. */
  amount?: number | null;
  mode?: MacDesktopInputMode | null;
  chatSessionId?: string | null;
};

export type MacDesktopDragArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  from: MacDesktopTarget;
  to: MacDesktopTarget;
  durationMs?: number | null;
  /** Always `real`: a drag has no accessibility action. Kept for symmetry. */
  mode?: MacDesktopInputMode | null;
  chatSessionId?: string | null;
};

/**
 * The pointer, moved and nothing else.
 *
 * Only real: there is no accessibility verb for "the mouse is now here", and
 * the reason to want it is a human driving the display — hover states, tooltips
 * and the captured system cursor all track the pointer, so a takeover that only
 * sent clicks looked frozen between them. Always silent for the same reason a
 * takeover click is: sixty observations a second is not a thing to do.
 */
export type MacDesktopMoveArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  /** Global screen point, the same plane `MacDesktopElement.frame` uses. */
  x: number;
  y: number;
  chatSessionId?: string | null;
};

export type MacDesktopWaitArgs = {
  laneId: string;
  /** Wait until an element matching this text exists. */
  text?: string | null;
  /** Wait until no element matching this text exists. */
  gone?: string | null;
  /** Wait until a window with this title substring exists. */
  windowTitle?: string | null;
  timeoutMs?: number | null;
  chatSessionId?: string | null;
};

/**
 * Every acting command answers the same way: what it did, and what the screen
 * looks like now. A caller never has to observe again to learn whether its
 * click landed.
 */
export type MacDesktopActionResult = {
  ok: true;
  action: string;
  mode: MacDesktopInputMode;
  /** The element the target resolved to, when it resolved to one. */
  resolved: MacDesktopElement | null;
  observation: MacDesktopObservation;
  trace: AgentActionTraceEntry;
};

/**
 * What a silent action answers with.
 *
 * Deliberately not a `MacDesktopActionResult` with empty fields: there is no
 * observation, so there is no `observationId` to put in a trace and no element
 * to report as resolved. A caller that needs the screen back asks for it.
 */
export type MacDesktopSilentActionResult = {
  ok: true;
  action: string;
  mode: MacDesktopInputMode;
  silent: true;
  resolved: null;
  observation: null;
  trace: null;
};

/** What every acting command returns: the observed result, or the silent one. */
export type MacDesktopInputResult = MacDesktopActionResult | MacDesktopSilentActionResult;

export type MacDesktopWaitResult = {
  ok: boolean;
  waitedMs: number;
  /** Null when the wait timed out. */
  matched: MacDesktopElement | null;
  observation: MacDesktopObservation;
};

// ---------------------------------------------------------------------------
// The input lease
// ---------------------------------------------------------------------------

export type MacDesktopLeaseHolderKind = "agent" | "user";

export type MacDesktopLeaseState = {
  laneId: string;
  holder: MacDesktopLeaseHolderKind;
  /** The chat that holds it, or the client that took over. Never null. */
  holderId: string;
  /** Human label for the strip: a chat title, or "You". */
  holderLabel: string | null;
  grantedAt: string;
  /**
   * When the lease lapses without a renewal.
   *
   * A heartbeat deadline rather than a durable flag on purpose: a remote viewer
   * that disconnects mid-takeover, or a machine that sleeps, must not leave the
   * lane permanently un-drivable. Nothing has to notice the disconnect for the
   * lease to end.
   */
  expiresAt: string;
};

export type MacDesktopLeaseRequestArgs = {
  laneId: string;
  chatSessionId: string;
  /** Shown on the pending-input card so the user knows what is being asked. */
  reason?: string | null;
};

export type MacDesktopLeaseRequestResult = {
  granted: boolean;
  /** Set when the grant was refused, using one of the codes above. */
  code: MacDesktopErrorCode | null;
  lease: MacDesktopLeaseState | null;
};

export type MacDesktopTakeoverArgs = {
  laneId: string;
  /** The client taking control. A window id, a session id — any stable token. */
  controllerId: string;
  controllerLabel?: string | null;
};

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Where the desktop reads H.264 access units from. Same shape as the sim. */
export type MacDesktopStreamTransport = {
  /** Null on every read but `startStream` — the URL carries the token. */
  url: string | null;
  port: number;
  /** Null on every read but `startStream`. */
  token: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
};

export type MacDesktopStreamStatus = {
  laneId: string;
  running: boolean;
  /** Frames per second the encoder is currently asked for. */
  fps: number;
  /** True while the stream is in its low-power idle rate. */
  idle: boolean;
  bitrateKbps: number | null;
  transport: MacDesktopStreamTransport | null;
  lastError: string | null;
  /** Readers attached right now. Zero stops the encoder after a grace period. */
  clients: number;
};

/** The redacted half of `getStatus`. Never carries the token. */
export type MacDesktopStreamSummary = {
  running: boolean;
  idle: boolean;
  fps: number;
  bitrateKbps: number | null;
  lastError: string | null;
};

export type MacDesktopStartStreamArgs = {
  laneId: string;
  /** Full rate while something is happening. The service clamps this. */
  fps?: number | null;
  /** Rate while nothing is happening. The service clamps this. */
  idleFps?: number | null;
  chatSessionId?: string | null;
};

// ---------------------------------------------------------------------------
// Recording, proof, and the turn time-lapse
// ---------------------------------------------------------------------------

export type MacDesktopRecordingStatus = {
  laneId: string;
  running: boolean;
  startedAt: string | null;
  /** Host-absolute path, present once the recording stops. */
  filePath: string | null;
  durationMs: number | null;
  /** Set when `record start` was given one; it opts the file into proof. */
  caption: string | null;
};

export type MacDesktopRecordStartArgs = {
  laneId: string;
  /** A caption opts the finished recording into the proof drawer. */
  caption?: string | null;
  fps?: number | null;
  chatSessionId?: string | null;
};

/**
 * A short clip of what an agent turn did on the desktop.
 *
 * Context, not proof: it never reaches the broker, and it is built from frames
 * the stream already kept rather than from a second capture.
 */
export type MacDesktopTimeLapse = {
  laneId: string;
  chatSessionId: string;
  turnId: string;
  filePath: string;
  durationMs: number;
  frameCount: number;
  createdAt: string;
};

export type MacDesktopScreenshotArgs = {
  laneId: string;
  windowId?: number | null;
  /** Relative paths resolve against the lane worktree and must stay inside it. */
  out?: string | null;
  chatSessionId?: string | null;
};

export type MacDesktopScreenshotResult = {
  laneId: string;
  filePath: string;
  width: number;
  height: number;
  capturedAt: string;
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type MacDesktopStatus = {
  platform: NodeJS.Platform;
  /** False on any non-macOS host, and on a Mac with no usable driver. */
  supported: boolean;
  /** Present exactly when `supported` is false. */
  unsupportedReason: string | null;
  driver: MacDesktopDriverHealth;
  permissions: MacDesktopPermissions;
  /** What the host can do right now, before any lane asks for a display. */
  displayMode: MacDesktopDisplayMode;
  /**
   * The requested lane's display, or null when it has none. `getStatus` with
   * no lane reports null here and still fills `lanes`.
   */
  display: MacDesktopDisplay | null;
  /** The requested lane's windows. Empty when it has no display. */
  windows: MacDesktopWindow[];
  lease: MacDesktopLeaseState | null;
  /** Redacted on purpose — `getStatus` is on the agent action allowlist. */
  stream: MacDesktopStreamSummary | null;
  recording: MacDesktopRecordingStatus | null;
  /** Every lane holding a display on this host, so one read explains the Mac. */
  lanes: MacDesktopLaneSummary[];
  /**
   * True when the ADE window asking is on the same Mac that hosts the display.
   * "Bring to my screen" is shown only then, because moving a window to "my
   * screen" is meaningless from another machine.
   */
  hostIsLocal: boolean;
};

export type MacDesktopGetStatusArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type MacDesktopStartArgs = {
  laneId: string;
  /** Falls back to the configured default. */
  resolution?: MacDesktopResolutionPreset | null;
  /** Used for the display name shown in Mission Control. */
  laneName?: string | null;
  chatSessionId?: string | null;
};

export type MacDesktopStopArgs = {
  laneId: string;
  chatSessionId?: string | null;
};

export type MacDesktopStopResult = {
  stopped: boolean;
  /** Windows moved back to the main display on the way out. */
  releasedWindows: number;
};

/** Move the lane's windows to the user's main display, and back again. */
export type MacDesktopPresentArgs = {
  laneId: string;
  /** `main` brings them over; `display` sends them back. */
  destination: "main" | "display";
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type MacDesktopEventPayload =
  | { type: "display-created"; display: MacDesktopDisplay }
  | { type: "display-destroyed"; laneId: string; reason: "stopped" | "idle" | "lane_removed" | "driver_lost" }
  | { type: "windows-changed"; laneId: string; windows: MacDesktopWindow[] }
  | { type: "observation"; laneId: string; observation: MacDesktopObservation }
  | { type: "lease-changed"; laneId: string; lease: MacDesktopLeaseState | null }
  | { type: "lease-requested"; laneId: string; chatSessionId: string; reason: string | null }
  | { type: "stream-started"; status: MacDesktopStreamStatus }
  | { type: "stream-status"; status: MacDesktopStreamStatus }
  | { type: "stream-stopped"; status: MacDesktopStreamStatus }
  | { type: "stream-error"; status: MacDesktopStreamStatus }
  | { type: "recording-changed"; status: MacDesktopRecordingStatus }
  | { type: "time-lapse"; timeLapse: MacDesktopTimeLapse }
  /**
   * The driver could not park a window on the lane's display.
   *
   * Forwarded rather than swallowed: the window is on the user's own screen
   * until something moves it, and the only surface that can say so is the one
   * watching the lane.
   */
  | { type: "window-not-parked"; laneId: string; windowId: number; reason: string }
  | { type: "permission-changed"; permissions: MacDesktopPermissions }
  | { type: "driver-health"; health: MacDesktopDriverHealth };

/**
 * A window `window-not-parked` reported, as a client holds it.
 *
 * `at` is the client's own clock (`Date.now()`) rather than a host timestamp:
 * the event carries none, and this is only ever used to order three entries
 * against each other, never compared across machines.
 */
export type MacDesktopNotParked = {
  windowId: number;
  reason: string;
  at: number;
  /**
   * When this window's current not-parked streak started.
   *
   * Separate from `at` because a retrying driver reports the same window once
   * per poll: `at` is the newest report, `firstSeenAt` is how long the window
   * has actually been stuck, and only the second one can tell a transient
   * "not yet" apart from a window that really is stranded.
   */
  firstSeenAt: number;
};

/**
 * Reasons that mean "the driver will try again in a moment", not "this failed".
 *
 * `not_ready` is emitted by the window watcher for a window whose accessibility
 * element has not appeared yet, and the watcher deliberately forgets the window
 * so the next poll re-parks it. A service window that exists for half a second
 * — TextEdit's, say — produced one of these and then vanished, and showing it
 * meant the panel accused the user of a stranded window that had never existed
 * for them to look at.
 */
const MAC_DESKTOP_NOT_PARKED_RETRY_REASONS: ReadonlySet<string> = new Set([
  "not_ready",
  "window_not_ready",
]);

export function isMacDesktopNotParkedRetry(reason: string): boolean {
  return MAC_DESKTOP_NOT_PARKED_RETRY_REASONS.has(reason.trim().toLowerCase());
}

/**
 * How long a retry may keep retrying before it is worth saying out loud.
 *
 * A window that is still not ready after this has stopped being "opening" and
 * started being "stuck", and it is still on the user's own screen either way.
 */
export const MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS = 5_000;

/**
 * The subset of tracked entries a surface should actually show.
 *
 * Tracking and showing are separated on purpose: the reducer has to remember a
 * retry to know how long it has been going on, but a retry in progress is not
 * news. An entry becomes news when its reason is final, or when the retry has
 * outlived the grace window and the window is still not parked.
 */
export function macDesktopVisibleNotParked(
  entries: readonly MacDesktopNotParked[],
  now: number,
): MacDesktopNotParked[] {
  return entries.filter(
    (entry) =>
      !isMacDesktopNotParkedRetry(entry.reason)
      || now - entry.firstSeenAt > MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS,
  );
}

/**
 * The human half of a driver reason code.
 *
 * One map, read by the desktop panel and mirrored by the Work-tools sheet, so
 * the two surfaces cannot drift into describing the same code differently. An
 * unknown code falls through to itself rather than to a vague sentence: a
 * reason nobody has humanized yet is still more useful than "something failed".
 */
export function macDesktopNotParkedPhrase(reason: string): string {
  const code = reason.trim().toLowerCase();
  if (isMacDesktopNotParkedRetry(code)) return "is still opening";
  if (code === "escaped" || code === "window_escaped" || code === "gave_up") {
    return "keeps leaving the lane screen";
  }
  if (code.includes("permission") || code.includes("accessibility") || code.includes("not_trusted")) {
    return "needs Accessibility permission";
  }
  return reason;
}

/**
 * How many stranded windows a client remembers.
 *
 * A driver that cannot park anything emits one of these per window per attempt,
 * and the surfaces that show them have room for a single line. Three is enough
 * to say "this keeps happening" without turning the footer into a log.
 */
export const MAC_DESKTOP_NOT_PARKED_MAX = 3;

/**
 * Folds one event into the stranded-window list. Newest first, bounded.
 *
 * Lives here rather than in either client because both the desktop panel and
 * the read-only Work-tools mirror have to answer the same question the same
 * way — a phone that still claims a window is stranded after the desktop has
 * parked it is worse than a phone that never said so.
 *
 * Returns the SAME array when nothing changed, so a React state setter that
 * compares by identity re-renders nothing.
 */
export function reduceMacDesktopNotParked(
  current: readonly MacDesktopNotParked[],
  event: MacDesktopEventPayload,
  laneId: string,
  now: number,
): readonly MacDesktopNotParked[] {
  if (event.type === "window-not-parked") {
    if (event.laneId !== laneId) return current;
    // One entry per window: a driver retrying the same window reports the
    // newest reason, it does not fill the list with one window's history.
    const previous = current.find((entry) => entry.windowId === event.windowId) ?? null;
    const rest = current.filter((entry) => entry.windowId !== event.windowId);
    return [
      {
        windowId: event.windowId,
        reason: event.reason,
        at: now,
        // A retry keeps the streak's start, so the grace window measures the
        // stuck window rather than the newest poll.
        firstSeenAt: previous?.firstSeenAt ?? now,
      },
      ...rest,
    ].slice(0, MAC_DESKTOP_NOT_PARKED_MAX);
  }
  if (event.type === "windows-changed") {
    if (event.laneId !== laneId) return current;
    // The window landed after all — or stopped existing. `laneId` on the window
    // IS parked-ness: a window listed with no lane is still loose on the human's
    // own screen, while a window the list no longer mentions at all is gone, and
    // a warning about a window that closed is pure noise.
    const loose = new Set(
      event.windows.filter((window) => window.laneId !== laneId).map((window) => window.id),
    );
    const next = current.filter((entry) => loose.has(entry.windowId));
    return next.length === current.length ? current : next;
  }
  // The display is gone, so nothing is waiting to land on it.
  if (event.type === "display-destroyed" && event.laneId === laneId) {
    return current.length ? [] : current;
  }
  return current;
}

// ---------------------------------------------------------------------------
// The seat provider interface
// ---------------------------------------------------------------------------

/**
 * A reply the backend passes through for the service to normalize.
 *
 * The service knows the display's size, the lane's name, and the clock; the
 * backend knows only what its helper said. Rather than have the backend invent
 * fallbacks the service would immediately override, these replies stay raw and
 * the one normalization lives where the state does.
 */
export type DesktopSeatReply = Record<string, unknown>;

/**
 * What a backend has to be able to do to host a lane's screen.
 *
 * One implementation exists: the Mac virtual-display backend in
 * `apps/desktop/src/main/services/macDesktop/`. The interface is here so a
 * later Linux seat backend is a new file rather than a reshape of the service,
 * and it is deliberately thin — lifecycle, windows, observation, input,
 * streaming, and health. Ownership, the lease, idle release, proof, and events
 * belong to the service and are the same whatever hosts the screen.
 *
 * Every method is one backend operation. `createMacVirtualDisplayProvider` in
 * `macDesktop/macDesktopSeatProvider.ts` is the one implementation, and the
 * service reaches its helper through it and nothing else.
 */
export type DesktopSeatProvider = {
  readonly id: "mac-virtual-display";
  health(): Promise<DesktopSeatReply>;
  create(args: { laneId: string; name: string; width: number; height: number; scale: number }): Promise<DesktopSeatReply>;
  destroy(args: { laneId: string }): Promise<DesktopSeatReply>;
  /** Destroys every seat no live lane claims. Runs once per backend start. */
  reconcile(args: { liveLaneIds: string[] }): Promise<void>;
  listWindows(args: { laneId?: string | null }): Promise<MacDesktopWindow[]>;
  park(args: { laneId: string; windowId: number }): Promise<MacDesktopWindow>;
  unpark(args: { windowId: number }): Promise<void>;
  launch(args: { laneId: string; target: string; args: string[] }): Promise<DesktopSeatReply>;
  present(args: { laneId: string; destination: "main" | "display" }): Promise<DesktopSeatReply>;
  observe(args: {
    laneId: string;
    windowId: number | null;
    limit: number;
    map: boolean;
    screenshotPath: string;
    mapPath?: string;
    caption?: string;
  }): Promise<DesktopSeatReply>;
  input(args: {
    laneId: string;
    command: string;
    mode: MacDesktopInputMode;
    payload: Record<string, unknown>;
    timeoutMs?: number;
    /** The holder the service authorized, echoed for the backend's own check. */
    lease?: { holderId: string } | null;
  }): Promise<DesktopSeatReply>;
  screenshot(args: { laneId: string; windowId: number | null; path: string }): Promise<DesktopSeatReply>;
  setLease(args: { laneId: string; holderId: string; expiresAt: string }): Promise<void>;
  clearLease(args: { laneId: string }): Promise<void>;
  /** The backend's own loopback port for this lane's encoder, plus its format. */
  startStream(args: { laneId: string; fps: number }): Promise<DesktopSeatReply>;
  setStreamRate(args: { laneId: string; fps: number }): Promise<void>;
  /**
   * Whether the captured stream draws the system pointer.
   *
   * Off while an agent drives — the agent's own cursor glyph is drawn by the
   * viewer from the action it just took, and a real pointer parked wherever the
   * user left it would be a second, lying one. On the moment a human takes
   * control, because then the pointer in the picture IS the thing they are
   * moving.
   */
  setStreamCursorVisible(args: { laneId: string; visible: boolean }): Promise<void>;
  stopStream(args: { laneId: string }): Promise<void>;
  startRecording(args: { laneId: string; fps: number; filePath: string }): Promise<void>;
  stopRecording(args: { laneId: string }): Promise<DesktopSeatReply>;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A display with no windows and no viewer is released after this. */
export const MAC_DESKTOP_IDLE_RELEASE_MS = 10 * 60_000;

/** A lease with no renewal inside this window lapses. */
export const MAC_DESKTOP_LEASE_TTL_MS = 60_000;

/** Full frame rate while something is happening. */
export const MAC_DESKTOP_ACTIVE_FPS = 30;

/** Low-power rate while nothing is. */
export const MAC_DESKTOP_IDLE_FPS = 3;

/** How long after the last action the stream drops to the idle rate. */
export const MAC_DESKTOP_IDLE_STREAM_AFTER_MS = 5_000;

/** Elements returned by one observation before it reports `truncated`. */
export const MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT = 200;

/**
 * Where observation frames are written, relative to the project root.
 *
 * Segments rather than a joined path because this file is imported by both the
 * runtime service that writes the frames and the Work tools aggregator that
 * serves them, and it must not depend on `node:path`. Both join it themselves.
 * Named once: a reader that disagrees with the writer serves nothing.
 */
export const MAC_DESKTOP_OBSERVATION_CACHE_SEGMENTS: readonly string[] = [
  ".ade",
  "cache",
  "mac-desktop-observations",
];

/** The loopback stream path, mirroring `IOS_VIDEO_STREAM_PATH`. */
export const MAC_DESKTOP_STREAM_PATH = "/mac-desktop-video";

/** Proof records made by this feature. */
export const MAC_DESKTOP_PROOF_BACKEND_NAME = "ade-mac-desktop";

/**
 * Prefix of the synthetic chat session id an automation rule acts under.
 * Minted by the automation runner and recognised by the lease flow, which
 * refuses to show a card to a holder that is not a chat.
 */
export const AUTOMATION_CHAT_SESSION_PREFIX = "automation:";

export function macDesktopDisplayName(laneName: string | null | undefined): string {
  const trimmed = laneName?.trim();
  return trimmed?.length ? `ADE · ${trimmed}` : "ADE lane";
}

export function isMacDesktopHandle(value: unknown): value is string {
  return typeof value === "string" && /^obs-[A-Za-z0-9_-]+:e:\d+$/.test(value);
}

// ---------------------------------------------------------------------------
// The service surface
// ---------------------------------------------------------------------------

/**
 * Every method the runtime service exposes.
 *
 * Written down as a type, rather than left implicit in
 * `ReturnType<typeof createMacDesktopService>`, because four surfaces are built
 * against it at once — the action registry, the JSON-RPC server, the Electron
 * IPC handlers, and the CLI — and a name that only exists inside the service
 * file cannot be checked from any of them until they are all written.
 *
 * `getStatus` answers on every platform. Every other method rejects off macOS
 * with {@link MAC_DESKTOP_MACOS_ONLY_MESSAGE}. `releaseIfOwnedBy` and
 * `destroyForLane` are the two exceptions, because a closing chat and a deleted
 * lane must clean up on any host.
 */
export type MacDesktopServiceApi = {
  getStatus(args?: MacDesktopGetStatusArgs): Promise<MacDesktopStatus>;
  start(args: MacDesktopStartArgs): Promise<MacDesktopStatus>;
  stop(args: MacDesktopStopArgs): Promise<MacDesktopStopResult>;
  getDisplay(args: { laneId: string }): Promise<MacDesktopDisplay | null>;

  listWindows(args?: { laneId?: string | null }): Promise<MacDesktopWindow[]>;
  open(args: MacDesktopOpenArgs): Promise<MacDesktopOpenResult>;
  claimWindow(args: MacDesktopClaimArgs): Promise<MacDesktopWindow>;
  releaseWindow(args: MacDesktopReleaseArgs): Promise<{ released: number }>;

  observe(args: MacDesktopObserveArgs): Promise<MacDesktopObservation>;
  click(args: MacDesktopClickArgs): Promise<MacDesktopInputResult>;
  type(args: MacDesktopTypeArgs): Promise<MacDesktopInputResult>;
  press(args: MacDesktopPressArgs): Promise<MacDesktopInputResult>;
  scroll(args: MacDesktopScrollArgs): Promise<MacDesktopInputResult>;
  drag(args: MacDesktopDragArgs): Promise<MacDesktopInputResult>;
  /** Real-only, always silent. Refused without the lease like any real input. */
  move(args: MacDesktopMoveArgs): Promise<MacDesktopInputResult>;
  wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult>;

  screenshot(args: MacDesktopScreenshotArgs): Promise<MacDesktopScreenshotResult>;
  startRecording(args: MacDesktopRecordStartArgs): Promise<MacDesktopRecordingStatus>;
  stopRecording(args: { laneId: string; chatSessionId?: string | null }): Promise<MacDesktopRecordingStatus>;

  /** The only call that hands out the stream token. */
  startStream(args: MacDesktopStartStreamArgs): Promise<MacDesktopStreamStatus>;
  stopStream(args: { laneId: string }): Promise<MacDesktopStreamStatus>;
  /** Redacted: `url` and `token` are always null here. */
  getStreamStatus(args: { laneId: string }): Promise<MacDesktopStreamStatus>;

  requestInputLease(args: MacDesktopLeaseRequestArgs): Promise<MacDesktopLeaseRequestResult>;
  takeControl(args: MacDesktopTakeoverArgs): Promise<MacDesktopLeaseState>;
  returnControl(args: { laneId: string; controllerId: string }): Promise<MacDesktopLeaseState | null>;
  /** Heartbeat. A lease with no renewal inside its TTL lapses on its own. */
  renewLease(args: { laneId: string; holderId: string }): Promise<MacDesktopLeaseState | null>;

  present(args: MacDesktopPresentArgs): Promise<{ moved: number }>;

  /** Called when an agent turn that used the desktop finishes. */
  noteTurnEnded(args: {
    laneId: string;
    chatSessionId: string;
    turnId: string;
  }): Promise<MacDesktopTimeLapse | null>;

  /** Runs on every platform: a closing chat must drop its lease anywhere. */
  releaseIfOwnedBy(chatSessionId: string | null | undefined): Promise<{ released: boolean }>;
  /** Runs on every platform: the lane teardown step calls it unconditionally. */
  destroyForLane(laneId: string): Promise<{ destroyed: boolean }>;

  /**
   * In-process change signal.
   *
   * The same payloads the runtime event stream carries, delivered to a caller
   * inside this process — the Work tools mirror holds
   * `Pick<MacDesktopServiceApi, "getStatus"> & { subscribe }` so it can re-read
   * lane state on a change without being able to start a display, take a lease,
   * or move a pointer.
   */
  subscribe(listener: (event: MacDesktopEventPayload) => void): () => void;

  dispose(): void;
};
