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

import type { AgentActionTraceEntry, AgentFrame, ComputerUseActionEffect } from "./agentObservation";
import { PROJECT_SECRET_REQUEST_METADATA_KEY } from "../projectSecretRequest";

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
/** The lane has a display, but no window on it to send a key or a scroll to. */
export const MAC_DESKTOP_NO_WINDOW_CODE = "MAC_DESKTOP_NO_WINDOW" as const;
export const MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE = "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE" as const;
export const MAC_DESKTOP_WINDOW_NOT_FOUND_CODE = "MAC_DESKTOP_WINDOW_NOT_FOUND" as const;
export const MAC_DESKTOP_HANDLE_EXPIRED_CODE = "MAC_DESKTOP_HANDLE_EXPIRED" as const;
export const MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE = "MAC_DESKTOP_INPUT_LEASE_REQUIRED" as const;
export const MAC_DESKTOP_USER_HAS_CONTROL_CODE = "MAC_DESKTOP_USER_HAS_CONTROL" as const;
export const MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE = "MAC_DESKTOP_LEASE_HELD_BY_OTHER" as const;
export const MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE = "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT" as const;
export const MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE = "MAC_DESKTOP_RECORDING_NOT_RUNNING" as const;
/**
 * The sync live view's client mistakes, refused by the fan-out before a reader
 * is opened. Both travel as `error.code` on the command result, so a client can
 * tell a bad subscription id from a busy host.
 */
export const MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE = "MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG" as const;
export const MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT_CODE = "MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT" as const;

/**
 * The Windows-only codes.
 *
 * The Windows driver owns these (`apps/desktop/native/ADEDesktopDriverWin`
 * mirrors them in `common.h`), and the service maps them onto its own errors
 * unchanged so the CLI's hint table and the panel's copy key off the same
 * string. They are declared here, not in a separate windows file, for the same
 * reason every other code is: one contract, one file, and the native side
 * already points at this path.
 */
export const WINDOWS_DESKTOP_HELD_CODE = "WINDOWS_DESKTOP_HELD" as const;
export const WINDOWS_DESKTOP_SETUP_REQUIRED_CODE = "WINDOWS_DESKTOP_SETUP_REQUIRED" as const;
export const WINDOWS_DESKTOP_LOCKED_CODE = "WINDOWS_DESKTOP_LOCKED" as const;
export const WINDOWS_DESKTOP_NOT_CONSOLE_SESSION_CODE = "WINDOWS_DESKTOP_NOT_CONSOLE_SESSION" as const;
export const WINDOWS_DESKTOP_SIGN_IN_FAILED_CODE = "WINDOWS_DESKTOP_SIGN_IN_FAILED" as const;
export const WINDOWS_DESKTOP_WRONG_PASSWORD_CODE = "WINDOWS_DESKTOP_WRONG_PASSWORD" as const;
export const WINDOWS_DESKTOP_CANCELLED_CODE = "WINDOWS_DESKTOP_CANCELLED" as const;
/**
 * Service-enforced, not driver-produced: a `shared` seat was asked for without
 * the user's consent. The driver also refuses it, but the service is the
 * boundary that must not let an agent turn the user's own desktop into a lane
 * screen by silence.
 */
export const WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE = "WINDOWS_DESKTOP_CONSENT_REQUIRED" as const;

export type MacDesktopErrorCode =
  | typeof MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE
  | typeof MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE
  | typeof MAC_DESKTOP_PERMISSION_REQUIRED_CODE
  | typeof MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE
  | typeof MAC_DESKTOP_NO_DISPLAY_CODE
  | typeof MAC_DESKTOP_NO_WINDOW_CODE
  | typeof MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE
  | typeof MAC_DESKTOP_WINDOW_NOT_FOUND_CODE
  | typeof MAC_DESKTOP_HANDLE_EXPIRED_CODE
  | typeof MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE
  | typeof MAC_DESKTOP_USER_HAS_CONTROL_CODE
  | typeof MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE
  | typeof MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE
  | typeof MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE
  | typeof MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE
  | typeof MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT_CODE
  | typeof WINDOWS_DESKTOP_HELD_CODE
  | typeof WINDOWS_DESKTOP_SETUP_REQUIRED_CODE
  | typeof WINDOWS_DESKTOP_LOCKED_CODE
  | typeof WINDOWS_DESKTOP_NOT_CONSOLE_SESSION_CODE
  | typeof WINDOWS_DESKTOP_SIGN_IN_FAILED_CODE
  | typeof WINDOWS_DESKTOP_WRONG_PASSWORD_CODE
  | typeof WINDOWS_DESKTOP_CANCELLED_CODE
  | typeof WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE;

/** The one sentence every non-macOS rejection carries. */
export const MAC_DESKTOP_MACOS_ONLY_MESSAGE =
  "A Mac Desktop display is only available on a macOS runtime host.";

/**
 * What a Linux host says instead. Neither seat exists there: it is not a
 * wrong-OS mistake to correct, just not built yet.
 */
export const LANE_SCREEN_LINUX_UNSUPPORTED_MESSAGE =
  "Lane screens are not supported on Linux yet. Use ade browser for web pages and ade app-control for Electron apps.";

/** The one sentence every non-Windows rejection carries. */
export const WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE =
  "A Windows Desktop screen is only available on a Windows runtime host.";

// ---------------------------------------------------------------------------
// Capability and health
// ---------------------------------------------------------------------------

export type MacDesktopPermissionState = "granted" | "denied" | "unknown";

/** The two grants, named once so the driver request and the panel agree. */
export type MacDesktopPermissionKind = "screenRecording" | "accessibility";

export type MacDesktopPermissions = {
  /** ScreenCaptureKit needs this before any frame exists. */
  screenRecording: MacDesktopPermissionState;
  /** The Accessibility API needs this before any element action works. */
  accessibility: MacDesktopPermissionState;
};

/**
 * How the running app was signed, for the one sentence a grant needs.
 *
 * macOS remembers a Screen Recording grant against the signing identity. An
 * ad-hoc build has no stable identity, so the grant is forgotten on every
 * rebuild — worth telling the user, because "grant it again" is the whole fix.
 * `unknown` is the honest answer when the marker cannot be read; it hides the
 * note rather than inventing a warning.
 */
export type MacDesktopSigningState = "adhoc" | "identity" | "unknown";

/**
 * Helper health, in the same shape as `CaptureGestureHealth` so the same
 * settings-style recovery verbs reach the UI.
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
  /**
   * Windows only: which seat this lane's screen is. `private` is a separate
   * Windows session of the user's account with its own pointer and keyboard;
   * `shared` is the user's main desktop. Null or absent on a Mac.
   */
  seatMode?: WindowsDesktopSeatMode | null;
};

export type MacDesktopLaneSummary = {
  laneId: string;
  laneName: string | null;
  /** Null in `offscreen-region` mode. See `MacDesktopDisplay.displayId`. */
  displayId: number | null;
  windowCount: number;
  streaming: boolean;
  /** Windows only: the lane's seat. Absent on a Mac. */
  seatMode?: WindowsDesktopSeatMode | null;
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
  /**
   * The owning app's icon, base64 PNG (32x32), for lists that name apps.
   *
   * Sent on the FIRST window of each bundle id in a reply and null on the
   * rest, so a Mac with forty windows across eight apps carries eight icons
   * and not forty; a reader joins it across an app's rows by bundle id
   * (`macDesktopClaimAppIcons`). Absent entirely from an older driver.
   */
  iconPng?: string | null;
};

export type MacDesktopOpenArgs = MacDesktopTrustedHolderArgs & {
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
  /**
   * Windows: the launched process exited without a window, because it handed
   * the request to an instance that was already running. Absent from an older
   * driver and from the Mac driver.
   */
  handedOff?: boolean;
  /** One plain sentence explaining `handedOff`, or null. */
  message?: string | null;
  /** Windows private seat: the lane-private browser profile the driver added. */
  profileDir?: string | null;
  /** Windows: the executable the target resolved to (App Paths), or null. */
  resolvedPath?: string | null;
};

/** `ade screen focus|minimize|close --window <id>`. Windows hosts only. */
export type MacDesktopWindowAction = "focus" | "minimize" | "close";

export type MacDesktopWindowActionArgs = MacDesktopTrustedHolderArgs & {
  laneId: string;
  windowId: number;
  chatSessionId?: string | null;
};

export type MacDesktopWindowActionResult = {
  laneId: string;
  windowId: number;
  action: MacDesktopWindowAction;
  /** `close` only: false when the window is still there (a save prompt, say). */
  closed?: boolean;
  /** The lane's windows after the action. */
  windows: MacDesktopWindow[];
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

/**
 * Quits apps the lane opened, when the user asks: the ones it still holds and
 * the ones it opened and then released to the user. `stop` and the idle close
 * never quit a released app; this does.
 */
export type MacDesktopQuitAppArgs = {
  laneId: string;
  /** An app name, bundle id or pid. Omit to quit every app the lane opened. */
  app?: string | null;
};

export type MacDesktopQuitAppResult = {
  quit: Array<{ pid: number; appName: string; bundleId: string | null; released: boolean }>;
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
  /** True when `elements` is not the whole tree; `truncatedReason` says why. */
  truncated: boolean;
  /**
   * Why the walk stopped short. `timeout` and `stalled` mean part of the
   * display was never read — an app stopped answering accessibility, or the
   * walk ran out of time — so the element an agent wants may be missing for a
   * reason `--limit` cannot fix. Absent from an older driver.
   */
  truncatedReason?: MacDesktopWalkStop | null;
  /** Apps that did not answer accessibility during this observation. */
  stalledApps?: string[];
  /** One line describing what produced this frame, e.g. "click · Sign in". */
  caption: string | null;
  /** The host that captured it, so text output can name the right screen. */
  platform?: NodeJS.Platform;
  /** Windows only: the seat this lane's screen is. */
  seatMode?: WindowsDesktopSeatMode | null;
};

/** `WalkStop` in the driver, by its wire spelling. */
export type MacDesktopWalkStop = "timeout" | "stalled" | "node_cap" | "limit";

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
 * one element in one process and moves no pointer. `background` delivers
 * pointer events (a click at a point, a right or double click, a scroll, a
 * drag) to the process that owns the lane window under the point and nowhere
 * else, so it moves no pointer either and needs no lease; it is what a point
 * target gets on a Mac. `real` posts a `CGEvent` through the window server,
 * which moves the user's one pointer, so it is the one capability behind the
 * lease. A hover is real-only.
 */
export const MAC_DESKTOP_INPUT_MODES = ["accessibility", "background", "real"] as const;

export type MacDesktopInputMode = (typeof MAC_DESKTOP_INPUT_MODES)[number];

export function isMacDesktopInputMode(value: unknown): value is MacDesktopInputMode {
  return typeof value === "string" && (MAC_DESKTOP_INPUT_MODES as readonly string[]).includes(value);
}

/** One way of naming what to act on, in the order the service resolves them. */
export type MacDesktopTarget = {
  /** A handle from the most recent observation. */
  handle?: string | null;
  /** Case-insensitive match against an element's title, label, or value. */
  text?: string | null;
  /** Global screen point. Delivered as `background` input on a Mac, `real` elsewhere. */
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
export type MacDesktopControllerArgs = MacDesktopTrustedHolderArgs & {
  controllerId?: string | null;
};

/**
 * The lease holder a trusted caller with no chat acts as: an `ade` process
 * with an elevated role (`ade --role cto screen …`) and no chat, run, step or
 * attempt. The RPC layer sets it ({@link MAC_DESKTOP_USER_CLI_HOLDER_ID}) and
 * strips `holderId` from every agent caller, bound or not, and the sync input
 * path strips it too, so an agent cannot wear it. It is one stable holder, so
 * the per-host shared-seat lease still serialises it against other lanes and a
 * person who took control in the pane still wins. A caller with no chat and no
 * holder stays the anonymous holder, which the shared seat refuses.
 */
export type MacDesktopTrustedHolderArgs = {
  holderId?: string | null;
};

/** The holder id the RPC layer gives a trusted `ade` caller with no chat. */
export const MAC_DESKTOP_USER_CLI_HOLDER_ID = "ade-cli-user";

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

/**
 * Windows types real text one character per `SendInput`, with a pause after
 * each (a WinUI editor drops batched characters), so a long `type` takes real
 * time. The driver refuses more than this many characters in one call.
 */
export const WINDOWS_DESKTOP_MAX_TYPED_CHARS = 4_000;
/** The driver budget for one Windows `type`: base plus a per-character cost, capped. */
export const WINDOWS_DESKTOP_TYPE_BASE_TIMEOUT_MS = 20_000;
export const WINDOWS_DESKTOP_TYPE_PER_CHAR_MS = 25;
export const WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS =
  WINDOWS_DESKTOP_TYPE_BASE_TIMEOUT_MS + WINDOWS_DESKTOP_MAX_TYPED_CHARS * WINDOWS_DESKTOP_TYPE_PER_CHAR_MS;

export function windowsDesktopTypeTimeoutMs(textLength: number): number {
  return Math.min(
    WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS,
    WINDOWS_DESKTOP_TYPE_BASE_TIMEOUT_MS + Math.max(0, textLength) * WINDOWS_DESKTOP_TYPE_PER_CHAR_MS,
  );
}

export type MacDesktopTypeArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  text: string;
  /** Replace the focused element's value instead of appending to it. */
  clear?: boolean | null;
  /** Press Return after the text, to submit a search or a form. */
  submit?: boolean | null;
  mode?: MacDesktopInputMode | null;
  target?: MacDesktopTarget | null;
  chatSessionId?: string | null;
};

/**
 * Modifier names on the wire. On a Windows host `cmd` is sent as Ctrl and
 * `option` as Alt (the driver maps them), and `win` is the Windows key; a Mac
 * host refuses `win`.
 */
export type MacDesktopModifier = "cmd" | "shift" | "option" | "control" | "win";

export const MAC_DESKTOP_MODIFIERS: readonly MacDesktopModifier[] = ["cmd", "shift", "option", "control", "win"];

export type MacDesktopPressArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  /** A key name (`return`, `tab`, `escape`, `f5`) or a single character. */
  key: string;
  modifiers?: MacDesktopModifier[] | null;
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
  /**
   * `real` for a drop onto another app or the Dock. Otherwise a drag is a
   * pointer action: `background` on a Mac seat, `real` on a Windows seat.
   */
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

/**
 * Ending a takeover, not an event.
 *
 * While a person drives, their viewer locks its pointer and the driver keeps
 * the one system cursor on the lane's display. This is what puts the cursor
 * back where the takeover found it.
 */
export type MacDesktopReleaseCursorArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  chatSessionId?: string | null;
};

/**
 * The panic release. Escape, a closing pane, a lost connection.
 *
 * Distinct from {@link MacDesktopReleaseCursorArgs}, which only undoes a
 * deliberate cursor hold and does nothing when no hold was started — which is
 * every desktop takeover, because absolute pointing holds nothing. This one
 * always acts: it lifts a mouse button the viewer pressed but never released,
 * and it puts the one system cursor back on the person's own screen.
 *
 * `button` is set only when a press is genuinely outstanding. A mouse-up with
 * no matching down is ignored by AppKit, but sending one anyway would make the
 * driver's logs lie about what the viewer did.
 *
 * `homeX` / `homeY` are the viewer's own pointer in SCREEN coordinates, taken
 * from the last pointer event over the pane. The driver warps there rather
 * than guessing, because only the viewing window knows where its person is.
 */
export type MacDesktopReleaseInputArgs = MacDesktopControllerArgs & MacDesktopSilentArgs & {
  laneId: string;
  chatSessionId?: string | null;
  button?: "left" | "right" | null;
  homeX?: number | null;
  homeY?: number | null;
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
  /**
   * Whether the accessibility tree changed between the observation the target
   * was resolved against and the one taken after the action.
   */
  effect: ComputerUseActionEffect;
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
  /**
   * True when this screen does not use the lease at all: a Windows private
   * seat is a separate session with its own pointer and keyboard.
   */
  notRequired?: boolean;
  /** One sentence for the caller, when there is something to say. */
  message?: string | null;
};

/** Windows: an agent asks the user, in its chat, to use the main desktop. */
export type WindowsDesktopRequestSharedArgs = {
  laneId: string;
  chatSessionId?: string | null;
  /** What the agent wants to do there; shown on the ask card. */
  reason?: string | null;
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
  /**
   * The chats currently recorded as viewers of this stream, as ids and nothing
   * else.
   *
   * Redaction-safe on purpose: no token and no URL, because this rides on
   * `getStreamStatus`, which is on the agent action allowlist. The floating
   * preview reads it to decide whether the chat you are looking at is actually
   * watching (or holding the lease of) the lane's desktop.
   */
  viewerChatSessionIds: string[];
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
  /**
   * A viewer's Reconnect. A running stream is still handed back unchanged,
   * unless it has sent nothing for `MAC_DESKTOP_STREAM_STALE_MS`: then it is
   * stopped and a new one started, because handing back a dead run is what
   * made Reconnect do nothing.
   */
  fresh?: boolean | null;
};

export type MacDesktopStopStreamArgs = {
  laneId: string;
  /** With `localViewer`: the chat whose viewer stopped watching. */
  chatSessionId?: string | null;
  /**
   * A viewer on a desktop stopped watching. Only its own chat is dropped, and
   * the capture stops only when no chat and no phone or web viewer is left.
   * Without it the stop is an explicit one (an agent's `stream-stop`) and
   * ends the capture for everyone.
   */
  localViewer?: boolean;
};

// ---------------------------------------------------------------------------
// Recording, proof, and the turn time-lapse
// ---------------------------------------------------------------------------

export type MacDesktopRecordingStatus = {
  laneId: string;
  running: boolean;
  startedAt: string | null;
  /**
   * Host-absolute path. Present once the recording stops — and, when a stop
   * fails, the path the helper was told to write, so a partial recording is
   * named rather than invisible.
   */
  filePath: string | null;
  durationMs: number | null;
  /** Set when `record start` was given one; it opts the file into proof. */
  caption: string | null;
  /**
   * Why the last stop failed, when it did. `running` goes false either way, so
   * `status` and a second `stop` agree instead of disagreeing about whether a
   * recording is live.
   */
  lastError?: string | null;
  /**
   * The proof record a captioned recording was filed as. Set by `stop`, and
   * null when there was no caption or the filing failed.
   */
  proofArtifactId?: string | null;
  /** Size of the finished file, when the host could read it. */
  bytes?: number | null;
  /**
   * The chat that started the recording. The proof is filed under it,
   * whichever chat stops it, and it is what makes the ten-minute cap apply.
   */
  chatSessionId?: string | null;
  /** Real time the video covers. `durationMs` is the video's own length. */
  wallDurationMs?: number | null;
  /** Still time the driver left out of the video: `wallDurationMs - durationMs`. */
  idleCutMs?: number | null;
  /** Wall-clock cap, or null for none. The recording stops itself at it. */
  maxDurationMs?: number | null;
  /** Why it stopped. `cap` means the cap above ran out. */
  stopReason?: MacDesktopRecordingStopReason | null;
  /** True between the stop and the demo being filed: the demo is being made. */
  makingDemo?: boolean;
  /** Set on a recording started with `plain`. */
  plain?: boolean;
  /**
   * Set when the stop filed the recording as it was recorded instead of as a
   * demo, in the proof's own words ("Filed as recorded: the ADE desktop app
   * was not connected to make the demo."). Null for a demo.
   */
  demoNote?: string | null;
};

export type MacDesktopRecordingStopReason = "requested" | "cap" | "idle" | "disk";

/**
 * The caption the pane gives what a person captures from it.
 *
 * A caption is what files a capture as proof, and an agent must still write
 * its own. A person pressing Record or Save screenshot has already said what
 * they want, so the pane names the capture plainly instead of asking.
 */
export function macDesktopPaneCaption(
  kind: "recording" | "screenshot",
  laneName: string | null | undefined,
  /** The host's product name (`desktopProductName(status.platform)`). */
  productName: string,
): string {
  const lane = laneName?.trim();
  const base = `${productName} ${kind}`;
  return lane ? `${base} · ${lane}` : base;
}

export type MacDesktopRecordStartArgs = {
  laneId: string;
  /** A caption opts the finished recording into the proof drawer. */
  caption?: string | null;
  fps?: number | null;
  chatSessionId?: string | null;
  /**
   * The recording as it was recorded: no cuts, speed-ups, zoom, pointer or
   * captions (`record start --plain`). Still sized under 10 MB.
   */
  plain?: boolean | null;
  /** Older name for `plain`. */
  keepIdle?: boolean | null;
  /** Wall-clock cap in seconds, at most five minutes (the default). */
  maxSeconds?: number | null;
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
  /**
   * Files the capture as proof under this caption. The CLI's `screenshot`
   * never sends one; `mac-desktop proof` files through its own step.
   */
  caption?: string | null;
};

export type MacDesktopScreenshotResult = {
  laneId: string;
  filePath: string;
  width: number;
  height: number;
  capturedAt: string;
  /** The proof record, when a caption filed one. */
  proofArtifactId?: string | null;
  /** Size of the image, when the host could read it. */
  bytes?: number | null;
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
  /**
   * The app macOS will accuse in the permission UI: `ADE`, `ADE Alpha` or
   * `ADE Beta`. The helper is owned by the packaged app, so the grant is made
   * against its name, not ADE's bundle id.
   */
  responsibleAppName: string;
  /** How this build was signed; drives the "macOS forgets this grant" note. */
  signing: MacDesktopSigningState;
  /**
   * The Windows-side facts, or null on a Mac/Linux host (and on a Windows host
   * that has not brought its helper up yet). Additive so the Mac surfaces never
   * read it; the Windows cards are the only readers.
   */
  windowsDesktop?: WindowsDesktopStatus | null;
  /**
   * What an agent needs to read first: which product and seat this is, whether
   * real input needs the lease, and the exact next command when something
   * blocks. Built by {@link describeDesktopSeat}; absent from an older runtime,
   * whose readers call that function themselves.
   */
  seat?: DesktopSeatSummary | null;
};

/** The host-aware summary at the top of `ade screen status`. */
export type DesktopSeatSummary = {
  /** "Mac Desktop" or "Windows Desktop". */
  product: string;
  /** `private`/`shared` on Windows, `virtual-display` on a Mac, null with no screen. */
  seat: WindowsDesktopSeatMode | "virtual-display" | "offscreen-region" | null;
  /** One sentence saying what the seat is, and whose screen it is. */
  seatDescription: string | null;
  /** True when real pointer/keyboard input on this lane's screen needs the lease. */
  realInputNeedsLease: boolean;
  /** The real-input rule for this seat, as one sentence, or null with no screen. */
  realInputSentence: string | null;
  /** Windows: whether the private seat can start now, and why not. */
  privateAvailable: boolean | null;
  privateUnavailable: string | null;
  /** Windows: the lane holding the private seat when it is not this one. */
  heldBy: string | null;
  /** Windows: the one-time setup has been done on this PC. */
  setupDone: boolean | null;
  /** Windows: a Windows password is saved for private sign-in. */
  passwordSaved: boolean | null;
  locked: boolean | null;
  /** The exact next command or ask, or null when nothing blocks. */
  nextStep: string | null;
};

/**
 * Which kind of lane screen a host and display describe: a Mac virtual display,
 * the private Windows child session, or the user's shared Windows desktop.
 */
export type DesktopSeatKind = "mac" | "windows-private" | "windows-shared";

// The seat logic (`describeDesktopSeat`, `desktopSeatKind`, the product name,
// the seat sentences and the next-step table) lives in `../desktopSeat`, and is
// re-exported here so every existing import keeps working.
export {
  WINDOWS_DESKTOP_NEXT_STEP,
  WINDOWS_DESKTOP_PRIVATE_SEAT_DESCRIPTION,
  WINDOWS_DESKTOP_SHARED_SEAT_DESCRIPTION,
  describeDesktopSeat,
  desktopProductName,
  desktopSeatKind,
  windowsDesktopPrivateUnavailableMessage,
} from "../desktopSeat";

export type MacDesktopGetStatusArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type MacDesktopRecheckPermissionsArgs = {
  /**
   * Restart the helper child before re-probing. A fresh process is the only
   * reliable way to see a Screen Recording grant macOS made after this one
   * started. Defaults to true; a caller may pass false to re-read only.
   */
  restartDriver?: boolean;
};

export type MacDesktopRequestPermissionArgs = {
  which: MacDesktopPermissionKind;
};

export type MacDesktopStartArgs = {
  laneId: string;
  /** Falls back to the configured default. */
  resolution?: MacDesktopResolutionPreset | null;
  /** Used for the display name shown in Mission Control. */
  laneName?: string | null;
  chatSessionId?: string | null;
  /**
   * Windows only. Defaults to `private` when the host supports it, and never
   * silently falls back to `shared`: Mode B needs the user's consent below.
   */
  seatMode?: WindowsDesktopSeatMode | null;
  /**
   * Windows only. The Mode B consent, required before a `shared` seat is
   * created. Rides the request, never a stored flag, so consent is per-create.
   */
  sharedDesktopConsent?: boolean | null;
};

export type MacDesktopStopArgs = {
  laneId: string;
  chatSessionId?: string | null;
};

/**
 * An app the lane opened that did not quit when its display was stopped, even
 * after the force quit that follows a short grace period, and whose windows
 * moved to the user's main screen instead. A driver that force-quits never
 * expects one; an older driver reported apps that asked to save.
 */
export type MacDesktopAppLeftOpen = {
  pid: number;
  appName: string;
  /** "TextEdit did not quit, even when forced. It moved to your screen." */
  message: string;
};

export type MacDesktopStopResult = {
  stopped: boolean;
  /** Claimed windows moved back to the main display on the way out. */
  releasedWindows: number;
  /** Apps the lane opened that quit. Absent from an older driver. */
  quitApps?: string[];
  /** Apps the lane opened that did not quit and moved to the main screen. */
  appsLeftOpen?: MacDesktopAppLeftOpen[];
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
  | {
    type: "display-destroyed";
    laneId: string;
    reason: "stopped" | "idle" | "lane_removed" | "driver_lost";
    /** Apps the lane opened that did not quit and moved to the main screen. */
    appsLeftOpen?: MacDesktopAppLeftOpen[];
  }
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
  | { type: "driver-health"; health: MacDesktopDriverHealth }
  /**
   * Windows only: the host's setup/held/locked/seated facts changed. The one
   * event the driver pushes on its own; the pane re-renders from `status`.
   * Spelling on the wire: `{"event":"windows-state-changed","status":{…}}`.
   */
  | { type: "windows-desktop-changed"; status: WindowsDesktopStatus };

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
  // Never the raw code: a user cannot act on "window_not_movable".
  return "couldn't move to the lane screen";
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
 * Which backend hosts a lane's screen.
 *
 * The union exists so the service, the Work-tools mirror, and the CLI can name
 * a seat without knowing which driver is behind it. `mac-virtual-display` is
 * the one implementation that predates Windows; the two Windows values are the
 * private child session and the shared console desktop, and the driver reports
 * which it is on every `display.create` reply.
 */
export type DesktopSeatProviderId =
  | "mac-virtual-display"
  | "windows-child-session"
  | "windows-shared-desktop";

/** Which Windows seat a lane asked for. */
export type WindowsDesktopSeatMode = "private" | "shared";

/**
 * The Windows-side facts a pane needs, none of which macOS has.
 *
 * The field names mirror the native `windows.status` reply exactly (the
 * driver's `common.h` is the other half of this contract); absent fields are
 * normalized once, in `asWindowsDesktopStatus`. `getStatus` answers it on every
 * platform, so a Mac or Linux host reports `null` here rather than a zeroed
 * object.
 */
export type WindowsDesktopStatus = {
  /**
   * The host's coarse state. The driver emits it; the two derived fields below
   * (`privateAvailable`, `privateUnavailableReason`) are what the cards read.
   * Unknown values normalize to `"unknown"` rather than being dropped.
   */
  state: WindowsDesktopHostState;
  locked: boolean;
  childSessionsEnabled: boolean;
  remoteDesktopAllowed: boolean;
  /** A credential saved by the local user in Windows Credential Manager. */
  passwordSaved: boolean;
  /**
   * Windows' own sign-in window is open on the PC and waits for the person to
   * type the password. Absent from an older driver; the `signing_in` state is
   * the fallback there.
   */
  signInWaiting?: boolean;
  /** The physical console's session id, or null when it cannot be read. */
  consoleSessionId: number | null;
  /** The session the driver host runs in, or null when no host is running. */
  driverSessionId: number | null;
  /** False when the brain is not in the console session, so A cannot start. */
  hostIsConsoleSession: boolean;
  /** The private child session's id, when one is connected. */
  childSessionId: number | null;
  /** Windows edition string, for the "Home can only share" note. */
  edition: string | null;
  /** The lane holding the private screen, when it is not the requesting one. */
  heldByLaneId: string | null;
  heldByLaneName: string | null;
  /** The seat the requesting lane holds, or null when it holds none. */
  seatMode: WindowsDesktopSeatMode | null;
  /** Derived from `state`: whether the private seat can start right now. */
  privateAvailable: boolean;
  /** Derived from `state`; why private is unavailable, for the cards. */
  privateUnavailableReason: WindowsDesktopPrivateUnavailableReason | null;
  /**
   * Where an interactive sign-in stands, from the driver. Absent from an older
   * driver and null when idle; unknown values normalize to null.
   */
  phase?: WindowsDesktopPhase | null;
  /**
   * The interactive operation the service is running right now, if any. Set by
   * the service (not the driver), so a pane that was closed and reopened
   * mid-operation shows the same progress instead of offering it again.
   */
  operation?: WindowsDesktopOperation | null;
  /** How the most recent interactive operation ended, until the next begins. */
  lastOperation?: WindowsDesktopOperationResult | null;
};

/** The driver's interactive sign-in phases. */
export type WindowsDesktopPhase = "prompt_open" | "verifying" | "starting" | "cleaning_up";

export type WindowsDesktopOperationKind =
  | "setup"
  | "save_password"
  | "forget_password"
  | "start_private";

export type WindowsDesktopOperation = {
  kind: WindowsDesktopOperationKind;
  /** The lane it is for; null for the host-wide setup steps. */
  laneId: string | null;
  startedAt: string;
};

export type WindowsDesktopOperationResult = WindowsDesktopOperation & {
  outcome: "succeeded" | "failed";
  endedAt: string;
  /** The error's `CODE: message` text, when it failed. */
  error: string | null;
};

/** The host states the driver names. Unknown values normalize to `unknown`. */
export type WindowsDesktopHostState =
  | "unavailable"
  | "setup_required"
  | "not_console_session"
  | "ready"
  | "signing_in"
  | "locked"
  | "held"
  | "shared"
  | "unknown";

export type WindowsDesktopPrivateUnavailableReason =
  | "unsupported_platform"
  | "not_console_session"
  | "setup_required"
  | "held"
  | "locked";

/** The setup step an agent cannot run: it needs the user's admin prompt. */
export type WindowsDesktopSetupArgs = {
  /**
   * Passed true after approval from a trusted CTO client on any device.
   * The helper refuses Windows admin/Remote Desktop changes otherwise;
   * native UAC and password entry still occur on the Windows host.
   */
  allowPrompt: boolean;
  /** Opens a native password dialog and verifies a private sign-in before saving. */
  savePassword?: boolean;
  /** Removes only ADE's saved Windows Desktop credential. */
  forgetPassword?: boolean;
};

export type WindowsDesktopSetupResult = {
  /** Setup needs an interactive admin prompt the helper has not raised yet. */
  requiresAdmin: boolean;
  status: WindowsDesktopStatus;
};

/**
 * The user-approved takeover of the private screen.
 *
 * The helper never force-claims (decided with the owner): a held private screen
 * is refused with {@link WINDOWS_DESKTOP_HELD_CODE}, and only this call — made
 * from the pane's Take over button or the thread's ask card — signs the old
 * holder out (a clean slate) and starts a fresh private seat for the new lane.
 */
export type WindowsDesktopTakeoverArgs = {
  laneId: string;
  chatSessionId?: string | null;
};

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
  readonly id: DesktopSeatProviderId;
  health(): Promise<DesktopSeatReply>;
  create(args: {
    laneId: string;
    name: string;
    width: number;
    height: number;
    scale: number;
    /** Windows only: which seat to create. Ignored by the Mac backend. */
    seatMode?: WindowsDesktopSeatMode;
    /**
     * Windows only: the Mode B consent. The driver refuses a shared create
     * without it, so an agent cannot turn the user's own desktop into a lane
     * screen by silence.
     */
    sharedDesktopConsent?: boolean;
  }): Promise<DesktopSeatReply>;
  destroy(args: { laneId: string }): Promise<DesktopSeatReply>;
  /** Destroys every seat no live lane claims. Runs once per backend start. */
  reconcile(args: { liveLaneIds: string[] }): Promise<void>;
  /**
   * Turns the helper's permission probe on while a viewer is watching. The
   * probe is refcounted with the "a display exists" condition; off with
   * neither is what keeps an idle helper idle.
   */
  watchPermissions(args: { watch: boolean }): Promise<void>;
  /**
   * Asks macOS to show its grant prompt. The helper answers with the fresh
   * permission snapshot and honors the ask only when `allowPrompt` is true,
   * which the service passes only for a local user's explicit click.
   */
  requestPermission(args: {
    which: MacDesktopPermissionKind;
    allowPrompt: boolean;
  }): Promise<DesktopSeatReply>;
  listWindows(args: { laneId?: string | null }): Promise<MacDesktopWindow[]>;
  park(args: { laneId: string; windowId: number }): Promise<MacDesktopWindow>;
  /**
   * Releases one window. A window of an app the lane launched hands the whole
   * app instance to the user: `releasedWindowIds` names every window that left
   * the lane, and `handedOverPid` the instance the lane no longer watches or
   * quits on stop. With `laneId`, the driver refuses a window another lane
   * holds.
   */
  unpark(args: { windowId: number; laneId?: string }): Promise<{ releasedWindowIds: number[]; handedOverPid: number | null; handedOverPids?: number[] }>;
  launch(args: { laneId: string; target: string; args: string[] }): Promise<DesktopSeatReply>;
  /** `app.quit`: apps the lane opened, released ones included. */
  quitApp(args: { laneId: string; app?: string | null }): Promise<DesktopSeatReply>;
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
  /** `keepIdle` true keeps still stretches; absent or false cuts them. */
  startRecording(args: { laneId: string; fps: number; filePath: string; keepIdle?: boolean }): Promise<void>;
  stopRecording(args: { laneId: string }): Promise<DesktopSeatReply>;
  /**
   * Windows only: the host's setup, held, locked and edition facts.
   *
   * Absent on the Mac backend, and the service only calls it when its seat is
   * the Windows one. Kept on this interface rather than a second provider type
   * so the service holds exactly one provider reference.
   */
  windowsStatus?(): Promise<WindowsDesktopStatus>;
  /** Windows only: the wizard's one admin step, prompt honored only on approval. */
  setupWindows?(args: WindowsDesktopSetupArgs): Promise<WindowsDesktopSetupResult>;
  /**
   * Windows only: `window.focus` / `window.minimize` / `window.close` on one of
   * the lane's windows. Absent on the Mac backend, whose helper has no such op.
   */
  windowAction?(args: { laneId: string; windowId: number; action: MacDesktopWindowAction }): Promise<DesktopSeatReply>;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A display with no windows and no viewer is released after this. */
export const MAC_DESKTOP_IDLE_RELEASE_MS = 10 * 60_000;

/** A lease with no renewal inside this window lapses. */
/**
 * Everything a human takeover may post straight to the driver.
 *
 * Two of these are not events.
 *
 * `releaseCursor` undoes a deliberate cursor hold: while a viewer drives with
 * a locked pointer, the driver keeps the one system cursor on the lane's
 * display instead of warping it home after every event, and this puts it
 * back. It does nothing when no hold was started.
 *
 * `releaseInput` is the panic release behind Escape, and it always acts. It
 * lifts a mouse button the viewer pressed but never released, and warps the
 * cursor to the viewer's own pointer. A desktop takeover holds no cursor, so
 * `releaseCursor` alone left that path with no way out at all.
 */
export const MAC_DESKTOP_REAL_INPUT_COMMANDS = [
  "move", "click", "drag", "scroll", "press", "type", "releaseCursor", "releaseInput",
] as const;

export type MacDesktopRealInputCommand = (typeof MAC_DESKTOP_REAL_INPUT_COMMANDS)[number];

export const MAC_DESKTOP_LEASE_TTL_MS = 60_000;

/** Full frame rate while something is happening. */
export const MAC_DESKTOP_ACTIVE_FPS = 60;

/** Low-power rate while nothing is. */
export const MAC_DESKTOP_IDLE_FPS = 10;

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

/** "ADE · <lane>", or "<prefix> · <lane>" for a host that names its screen differently. */
export function macDesktopDisplayName(laneName: string | null | undefined, prefix = "ADE"): string {
  const trimmed = laneName?.trim();
  return trimmed?.length ? `${prefix} · ${trimmed}` : `${prefix} lane`;
}

/** True for either Windows seat, so one predicate answers "is this Windows?". */
export function isWindowsDesktopSeatProvider(id: DesktopSeatProviderId): boolean {
  return id === "windows-child-session" || id === "windows-shared-desktop";
}

/** The Work tool id a Windows-hosted chat shows, and a Mac-hosted chat hides. */
export const WINDOWS_DESKTOP_WORK_TOOL_ID = "windows-desktop" as const;

/**
 * The one sentence the Mode B consent card carries, and the same one the chat
 * ask card shows. Kept here so the pane and the thread cannot drift.
 */
export const WINDOWS_DESKTOP_SHARED_CONSENT_MESSAGE =
  "The agent works on your main Windows desktop, in windows it opens there. It takes over the window you are using while it acts.";

/** `providerMetadata` key on the shared-seat consent card. */
export const WINDOWS_DESKTOP_SHARED_CONSENT_METADATA_KEY = "windowsDesktopSharedConsent" as const;
/** `providerMetadata` key on the real-input lease card. */
export const MAC_DESKTOP_INPUT_LEASE_METADATA_KEY = "macDesktopInputLease" as const;

/**
 * True for a pending-input card only the user may answer: the shared-seat
 * consent, the real-input lease, and the private secret card. The answer IS
 * the permission (or the secret), so an agent caller (session-bound, unbound,
 * or the CTO's tools) is refused.
 */
export function isUserOnlyConsentCard(providerMetadata: Record<string, unknown> | null | undefined): boolean {
  return providerMetadata?.[WINDOWS_DESKTOP_SHARED_CONSENT_METADATA_KEY] === true
    || providerMetadata?.[MAC_DESKTOP_INPUT_LEASE_METADATA_KEY] === true
    || isNonNullRecord(providerMetadata?.[PROJECT_SECRET_REQUEST_METADATA_KEY]);
}

function isNonNullRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** What an agent is told when it tries to answer one of those cards. */
export const USER_ONLY_CONSENT_CARD_REFUSAL =
  "This card asks the user directly (for a permission or a secret), so only the user can answer it. Wait for the user to answer it in the chat.";

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
  /**
   * Re-probes the grants, restarting the helper first so a grant macOS made
   * after it started is visible. The panel's "Check again" calls this.
   */
  recheckPermissions(args?: MacDesktopRecheckPermissionsArgs): Promise<MacDesktopPermissions>;
  /**
   * Asks macOS to show its permission prompt. Honored only when the service
   * itself passed `allowPrompt`, which it does only for a local renderer's
   * explicit click — never for an agent action or a remote client.
   */
  requestPermission(args: MacDesktopRequestPermissionArgs): Promise<MacDesktopPermissions>;
  /**
   * Windows only: the wizard's one admin step (child sessions + local Remote
   * Desktop). Rejects on any other host. `allowPrompt` is honored only when the
   * service itself passed it for a local user's explicit click.
   */
  setupWindowsDesktop(args: WindowsDesktopSetupArgs): Promise<WindowsDesktopSetupResult>;
  /**
   * Windows only: the user approved taking the private screen from whichever
   * lane holds it. Signs the old holder out (a clean slate) and starts a fresh
   * private seat for this lane. Never called by an agent's own action.
   */
  takeoverWindowsDesktop(args: WindowsDesktopTakeoverArgs): Promise<MacDesktopStatus>;
  start(args: MacDesktopStartArgs): Promise<MacDesktopStatus>;
  stop(args: MacDesktopStopArgs): Promise<MacDesktopStopResult>;
  getDisplay(args: { laneId: string }): Promise<MacDesktopDisplay | null>;

  listWindows(args?: { laneId?: string | null }): Promise<MacDesktopWindow[]>;
  open(args: MacDesktopOpenArgs): Promise<MacDesktopOpenResult>;
  claimWindow(args: MacDesktopClaimArgs): Promise<MacDesktopWindow>;
  releaseWindow(args: MacDesktopReleaseArgs): Promise<{ released: number }>;
  /** Quits apps the lane opened, released ones included. Only on the user's request. */
  quitApp(args: MacDesktopQuitAppArgs): Promise<MacDesktopQuitAppResult>;
  /**
   * Windows only: raise, minimize or close one of this lane's own windows.
   * A Mac host refuses with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.
   */
  focusWindow(args: MacDesktopWindowActionArgs): Promise<MacDesktopWindowActionResult>;
  minimizeWindow(args: MacDesktopWindowActionArgs): Promise<MacDesktopWindowActionResult>;
  closeWindow(args: MacDesktopWindowActionArgs): Promise<MacDesktopWindowActionResult>;
  /**
   * Windows only, agent-callable: asks the user with a card in the calling
   * chat to let this lane use the main desktop, and starts the shared seat
   * when they allow it. The consent is the user's answer, never the agent's
   * argument. A chat the user already allowed is not asked again.
   */
  requestSharedDesktop(args: WindowsDesktopRequestSharedArgs): Promise<MacDesktopStatus>;

  observe(args: MacDesktopObserveArgs): Promise<MacDesktopObservation>;
  click(args: MacDesktopClickArgs): Promise<MacDesktopInputResult>;
  type(args: MacDesktopTypeArgs): Promise<MacDesktopInputResult>;
  press(args: MacDesktopPressArgs): Promise<MacDesktopInputResult>;
  scroll(args: MacDesktopScrollArgs): Promise<MacDesktopInputResult>;
  drag(args: MacDesktopDragArgs): Promise<MacDesktopInputResult>;
  /**
   * The panic release behind Escape: lift a button the viewer never released,
   * and put the one system cursor back on the viewer's own screen. Real-only
   * and always silent, and refused without the lease like any real input.
   */
  releaseInput(args: MacDesktopReleaseInputArgs): Promise<MacDesktopInputResult>;
  /** Real-only, always silent. Refused without the lease like any real input. */
  move(args: MacDesktopMoveArgs): Promise<MacDesktopInputResult>;
  wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult>;

  screenshot(args: MacDesktopScreenshotArgs): Promise<MacDesktopScreenshotResult>;
  startRecording(args: MacDesktopRecordStartArgs): Promise<MacDesktopRecordingStatus>;
  stopRecording(args: { laneId: string; chatSessionId?: string | null }): Promise<MacDesktopRecordingStatus>;

  /** The only call that hands out the stream token. */
  startStream(args: MacDesktopStartStreamArgs): Promise<MacDesktopStreamStatus>;
  stopStream(args: MacDesktopStopStreamArgs): Promise<MacDesktopStreamStatus>;
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
