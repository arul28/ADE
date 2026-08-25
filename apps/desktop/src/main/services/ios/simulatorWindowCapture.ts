/**
 * macOS window management for the iOS Simulator live view.
 *
 * Capturing the real Simulator.app window is the only way ADE can show a live
 * simulator, and it needs three things macOS does not hand over for free: the
 * Screen Recording grant, the Automation grant, and a window that is visible,
 * un-minimized, and on-screen. Everything that talks to `osascript`,
 * `desktopCapturer`, and the macOS privacy panes for that purpose lives here so
 * the IPC layer keeps only its handler wiring.
 *
 * The module owns a small amount of process-wide state — what ADE last wrote to
 * the Simulator window, and which ADE window it is following — because there is
 * exactly one Simulator.app per machine no matter how many ADE windows ask for
 * it.
 */
import { desktopCapturer, screen, shell, systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import type {
  IosSimulatorPermissionStatus,
  IosSimulatorPrivacyPane,
  IosSimulatorWindowCaptureSessionHint,
  IosSimulatorWindowSource,
  IosSimulatorWindowState,
} from "../../../shared/types";

/**
 * Discovery is polled by the drawer; cap the wall time so a blocked simulator
 * fails fast.
 *
 * The budget has to sit *above* the subprocess ceilings it wraps or it is not a
 * cap, it is a guaranteed timeout. Worst case, in order: the window-state read
 * (900), the attach park (open 900 + measure 900 + apply 1200 + confirm 900,
 * then a 300 settle), the re-attach park (the same 3900 plus a 600 settle) and
 * the closing re-measure (900) — 10.5s of ceilings. At 4s the re-attach could
 * never run and the handler reported "timed out" before the first sweep had a
 * fair chance. The IPC channel allows 60s, so this is comfortably inside its
 * own transport budget.
 *
 * This is a *per-call* cap and the drawer sweeps more than once, so it does not
 * bound what the user waits for on its own — the drawer owns an overall
 * deadline across its sweeps (`WINDOW_SOURCE_TOTAL_DISCOVERY_MS`) and stops
 * asking once one call's worth of budget is all that is left.
 */
export const SIMULATOR_SOURCE_DISCOVERY_BUDGET_MS = 12_000;

const SIMULATOR_WINDOW_NAME =
  /(?:^|\s|[(\[\-–])(simulator|iphone|ipad|apple\s*watch|apple\s*tv|vision\s*pro)(?:\s|[)\]\-–]|$)/i;

type MacUtilityResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type SpawnProcess = typeof spawn;

// Everything this module decides — the window-state parse, the hidden /
// minimized / no-window classification, the permission verdict, the park — is a
// reaction to one `osascript` run, and the platform gate short-circuits all of
// it off macOS. Without a seam for both, none of it was reachable from a test
// and a unit run on a developer's Mac would really have launched Simulator.app.
// Mirrors `__testSetIosSimulatorProcessHooks` in `iosSimulatorService`.
let spawnProcess: SpawnProcess = spawn;
let hostPlatform: NodeJS.Platform = process.platform;

export function __testSetSimulatorWindowCaptureHooks(hooks: {
  spawn?: SpawnProcess;
  platform?: NodeJS.Platform;
}): () => void {
  const previous = { spawnProcess, hostPlatform };
  if (hooks.spawn) spawnProcess = hooks.spawn;
  if (hooks.platform) hostPlatform = hooks.platform;
  return () => {
    spawnProcess = previous.spawnProcess;
    hostPlatform = previous.hostPlatform;
  };
}

// Every simulator window helper runs through here. The old variant discarded
// stdio entirely, so a denied Automation grant — the single most common cause
// of a blank live view — produced no signal anywhere: the park silently
// no-opped and the window state fell through to `issue: "unknown"`.
async function runMacUtility(
  command: string,
  args: string[],
  timeoutMs = 900,
): Promise<MacUtilityResult> {
  return new Promise<MacUtilityResult>((resolve) => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extraStderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      resolve({ code, stdout, stderr: `${stderr}${extraStderr}`, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 250);
      finish(null, `${command} timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(null, error.message));
    child.once("exit", (code) => finish(code));
  });
}

// osascript reports a refused Automation (Apple events) grant as -1743, and a
// missing Accessibility grant as -1719/-25211. Either way ADE cannot drive the
// Simulator window, and the fix is the same Settings pane.
const AUTOMATION_DENIED_PATTERN =
  /-1743|-25211|-10004|not authoriz|not allowed assistive access|is not allowed to send keystrokes/i;

function isAutomationDenied(result: MacUtilityResult): boolean {
  return AUTOMATION_DENIED_PATTERN.test(result.stderr);
}

// desktopCapturer hands back black thumbnails without the Screen Recording
// grant, and macOS gives no error — the drawer just showed an empty live view.
function screenCaptureAccessStatus(): IosSimulatorPermissionStatus {
  if (hostPlatform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen") as IosSimulatorPermissionStatus;
  } catch {
    return "unknown";
  }
}

function windowIssueMessage(issue: IosSimulatorWindowState["issue"]): string | null {
  switch (issue) {
    case "not-running":
      return "The simulator is not running. Launch it from ADE again.";
    case "hidden":
      return "The simulator is hidden. Show it to refresh the live view.";
    case "minimized":
      return "The simulator is minimized. Restore it to refresh the live view.";
    case "no-window":
      return "The simulator is running, but ADE cannot find a visible simulator window.";
    case "screen-recording-permission":
      return "Screen Recording is off for ADE. Turn it on to see the live view.";
    case "automation-denied":
      return "Automation is off for ADE. Turn it on so ADE can manage the simulator window.";
    default:
      return null;
  }
}

export async function getSimulatorWindowState(): Promise<IosSimulatorWindowState> {
  if (hostPlatform !== "darwin") {
    return {
      appRunning: false,
      visible: null,
      windowCount: null,
      minimizedWindowCount: null,
      capturable: false,
      issue: "unknown",
      message: null,
    };
  }
  // Check the cheap blocker before spending a subprocess — but only a decided
  // refusal blocks. A probe that throws, or a macOS that answers "unknown",
  // says nothing about whether capture works: report that as no blocker and let
  // the empty-thumbnail path speak if capture really is denied. Treating an
  // unknown probe as a refusal used to hide a perfectly capturable simulator
  // behind a permission card the user could do nothing about.
  const screenStatus = screenCaptureAccessStatus();
  if (screenStatus === "denied" || screenStatus === "restricted") {
    const issue = "screen-recording-permission" as const;
    return {
      appRunning: false,
      visible: null,
      windowCount: null,
      minimizedWindowCount: null,
      capturable: false,
      issue,
      message: windowIssueMessage(issue),
    };
  }
  const script = [
    'tell application "System Events"',
    '  if not (exists process "Simulator") then return "not-running|false|0|0"',
    '  tell process "Simulator"',
    '    set processVisible to visible',
    '    set windowCount to count windows',
    '    set minimizedCount to 0',
    '    repeat with simulatorWindow in windows',
    '      try',
    '        if value of attribute "AXMinimized" of simulatorWindow then set minimizedCount to minimizedCount + 1',
    '      end try',
    '    end repeat',
    '    return (processVisible as text) & "|" & (windowCount as text) & "|" & (minimizedCount as text)',
    '  end tell',
    'end tell',
  ].join("\n");
  const result = await runMacUtility("osascript", ["-e", script], 900);
  if (result.code !== 0) {
    const denied = isAutomationDenied(result);
    const issue = denied ? "automation-denied" as const : "unknown" as const;
    return {
      appRunning: true,
      visible: null,
      windowCount: null,
      minimizedWindowCount: null,
      capturable: denied ? false : null,
      issue,
      message: windowIssueMessage(issue),
    };
  }
  const raw = result.stdout.trim();
  if (raw.startsWith("not-running")) {
    const issue = "not-running" as const;
    return {
      appRunning: false,
      visible: false,
      windowCount: 0,
      minimizedWindowCount: 0,
      capturable: false,
      issue,
      message: windowIssueMessage(issue),
    };
  }
  const [visibleRaw, windowCountRaw, minimizedCountRaw] = raw.split("|");
  const visible = visibleRaw === "true";
  const windowCount = Number.parseInt(windowCountRaw ?? "", 10);
  const minimizedWindowCount = Number.parseInt(minimizedCountRaw ?? "", 10);
  const hasWindows = Number.isFinite(windowCount) && windowCount > 0;
  const allWindowsMinimized = hasWindows && Number.isFinite(minimizedWindowCount) && minimizedWindowCount >= windowCount;
  const issue: IosSimulatorWindowState["issue"] = !visible
    ? "hidden"
    : !hasWindows
      ? "no-window"
      : allWindowsMinimized
        ? "minimized"
        : null;
  return {
    appRunning: true,
    visible,
    windowCount: Number.isFinite(windowCount) ? windowCount : null,
    minimizedWindowCount: Number.isFinite(minimizedWindowCount) ? minimizedWindowCount : null,
    capturable: issue === null,
    issue,
    message: windowIssueMessage(issue),
  };
}

type SimulatorWindowFrame = { x: number; y: number; width: number; height: number };

// What ADE last wrote to the Simulator window. Once the live frame stops
// matching it, the user moved or resized the window themselves and owns it
// until the next explicit attach — ADE stops following.
let simulatorAdeSetFrame: SimulatorWindowFrame | null = null;
let simulatorFollowSuspended = false;

function simulatorHasBeenParked(): boolean {
  return simulatorAdeSetFrame !== null;
}

function framesMatch(a: SimulatorWindowFrame, b: SimulatorWindowFrame): boolean {
  return Math.abs(a.x - b.x) <= 2
    && Math.abs(a.y - b.y) <= 2
    && Math.abs(a.width - b.width) <= 2
    && Math.abs(a.height - b.height) <= 2;
}

const MEASURE_SIMULATOR_WINDOW_SCRIPT = [
  'tell application "System Events"',
  '  if not (exists process "Simulator") then return "missing"',
  '  tell process "Simulator"',
  '    if (count windows) is 0 then return "nowindow"',
  '    set targetWindow to window 1',
  '    set isMinimized to false',
  '    try',
  '      set isMinimized to (value of attribute "AXMinimized" of targetWindow)',
  '    end try',
  '    set p to position of targetWindow',
  '    set s to size of targetWindow',
  '    return "ok|" & (visible as text) & "|" & (isMinimized as text) & "|" & (item 1 of p as text) & "|" & (item 2 of p as text) & "|" & (item 1 of s as text) & "|" & (item 2 of s as text)',
  '  end tell',
  'end tell',
].join("\n");

type SimulatorWindowMeasurement = {
  /** Null when the window reported a non-numeric position or size. */
  frame: SimulatorWindowFrame | null;
  hidden: boolean;
  minimized: boolean;
};

/** One `osascript` read of window 1. Null means "no window to measure". */
async function measureSimulatorWindow(): Promise<SimulatorWindowMeasurement | null> {
  const measured = await runMacUtility("osascript", ["-e", MEASURE_SIMULATOR_WINDOW_SCRIPT], 900);
  if (measured.code !== 0) return null;
  const parts = measured.stdout.trim().split("|");
  if (parts[0] !== "ok") return null;
  const [, visibleRaw, minimizedRaw, xRaw, yRaw, widthRaw, heightRaw] = parts;
  const toInt = (value: string | undefined) => Number.parseInt(value ?? "", 10);
  const current: SimulatorWindowFrame = {
    x: toInt(xRaw),
    y: toInt(yRaw),
    width: toInt(widthRaw),
    height: toInt(heightRaw),
  };
  return {
    frame: Object.values(current).every((value) => Number.isFinite(value)) ? current : null,
    hidden: visibleRaw !== "true",
    minimized: minimizedRaw === "true",
  };
}

function simulatorWorkArea(adeBounds: SimulatorWindowFrame | null) {
  try {
    const display = adeBounds
      ? screen.getDisplayMatching(adeBounds)
      : screen.getPrimaryDisplay();
    return display.workArea;
  } catch {
    return null;
  }
}

/**
 * Parks the real Simulator window so window capture can reach it.
 *
 * `attach` is the one-time placement performed when a capture session starts:
 * it positions AND sizes the window beside ADE. Every later call is a polite
 * nudge — it un-hides/un-minimizes a window that cannot be captured and, while
 * the user has not taken the window over, keeps its position following ADE.
 * It never resizes a window the user chose and never focuses ADE.
 *
 * `allowLaunch` — defaulting to `attach` — is what separates a capture caller
 * from the background window-move follow. Only a caller that is actually
 * starting or repairing capture may start Simulator.app; the follow must never
 * resurrect a Simulator the user deliberately quit.
 */
async function prepareSimulatorWindowForCapture(
  window: BrowserWindow | null,
  options: { attach?: boolean; allowLaunch?: boolean } = {},
): Promise<void> {
  if (hostPlatform !== "darwin") return;
  const attach = options.attach === true;
  const allowLaunch = options.allowLaunch ?? attach;
  if (attach) {
    simulatorFollowSuspended = false;
    simulatorAdeSetFrame = null;
  }
  // `-g` keeps the Simulator behind ADE; it must never take focus.
  if (allowLaunch) await runMacUtility("open", ["-g", "-a", "Simulator"], 900);
  const measurement = await measureSimulatorWindow();
  if (!measurement) return;
  const { frame: measuredFrame, hidden, minimized } = measurement;

  if (!attach && measuredFrame && simulatorAdeSetFrame && !framesMatch(measuredFrame, simulatorAdeSetFrame)) {
    simulatorFollowSuspended = true;
  }

  const adeBounds = window && !window.isDestroyed() ? window.getBounds() : null;
  const workArea = simulatorWorkArea(adeBounds);
  // "Out of bounds" means the window cannot serve as a capture target: it is
  // degenerate, larger than the screen, or pushed far enough off-screen that
  // most of it is gone. A merely unusual size the user chose is left alone.
  const sizeOutOfBounds = Boolean(
    measuredFrame
    && (measuredFrame.width < 200
      || measuredFrame.height < 320
      || (workArea && (measuredFrame.width > workArea.width || measuredFrame.height > workArea.height))),
  );
  const offScreen = Boolean(
    measuredFrame
    && workArea
    && (measuredFrame.x + measuredFrame.width < workArea.x + 120
      || measuredFrame.x > workArea.x + workArea.width - 120
      || measuredFrame.y + measuredFrame.height < workArea.y + 120
      || measuredFrame.y > workArea.y + workArea.height - 120),
  );

  const targetWidth = adeBounds ? Math.max(300, Math.min(440, Math.round(adeBounds.width * 0.34))) : null;
  const targetHeight = adeBounds ? Math.max(520, Math.min(860, adeBounds.height - 120)) : null;
  // Park under ADE but away from the drawer: capture needs the window
  // unminimized, and keeping it under the left side avoids capturing the
  // user's cursor while they interact with the simulator surface on the right.
  const targetX = adeBounds ? Math.round(adeBounds.x + Math.max(64, Math.min(140, adeBounds.width * 0.08))) : null;
  const targetY = adeBounds ? Math.round(adeBounds.y + 72) : null;

  const shouldMove = Boolean(
    targetX !== null && targetY !== null && (attach || offScreen || !simulatorFollowSuspended),
  );
  const shouldResize = Boolean(
    targetWidth !== null && targetHeight !== null && (attach || sizeOutOfBounds),
  );

  const lines: string[] = [];
  if (hidden) lines.push('    set visible to true');
  if (minimized) {
    lines.push('    try');
    lines.push('      set value of attribute "AXMinimized" of window 1 to false');
    lines.push('    end try');
  }
  if (shouldMove) {
    lines.push('    try');
    lines.push(`      set position of window 1 to {${targetX}, ${targetY}}`);
    lines.push('    end try');
  }
  if (shouldResize) {
    lines.push('    try');
    lines.push(`      set size of window 1 to {${targetWidth}, ${targetHeight}}`);
    lines.push('    end try');
  }
  if (!lines.length) return;

  const applyScript = [
    'tell application "System Events"',
    '  if exists process "Simulator" then',
    '    tell process "Simulator"',
    ...lines,
    '    end tell',
    '  end if',
    'end tell',
  ].join("\n");
  const applied = await runMacUtility("osascript", ["-e", applyScript], 1_200);
  if (applied.code !== 0) return;
  // Record what the window actually BECAME, not what ADE asked for.
  // Simulator.app constrains its window to the device's aspect ratio, so the
  // size that lands is almost never the size requested. Recording the request
  // made the very next comparison miss by more than the 2px tolerance, which
  // reads as "the user took the window over" — so the follow suspended itself
  // permanently on its own first park and the documented follow-ADE behaviour
  // never ran once.
  if (shouldMove || shouldResize) {
    const confirmed = await measureSimulatorWindow();
    if (confirmed?.frame) {
      simulatorAdeSetFrame = confirmed.frame;
      return;
    }
  }
  // Confirmation failed (or nothing was moved): fall back to the intent, which
  // is still closer to the truth than the pre-park frame.
  if (measuredFrame) {
    simulatorAdeSetFrame = {
      x: shouldMove && targetX !== null ? targetX : measuredFrame.x,
      y: shouldMove && targetY !== null ? targetY : measuredFrame.y,
      width: shouldResize && targetWidth !== null ? targetWidth : measuredFrame.width,
      height: shouldResize && targetHeight !== null ? targetHeight : measuredFrame.height,
    };
  }
}

let simulatorParkingWindow: BrowserWindow | null = null;
let simulatorParkingTimer: NodeJS.Timeout | null = null;
let cleanupSimulatorParkingFollow: (() => void) | null = null;

/**
 * The two teardown signals a holder is dropped on, and their removal.
 *
 * Declared as overloads rather than a union so a real Electron `WebContents`
 * — whose `on`/`off` are themselves overloaded per event — satisfies it.
 */
type SimulatorParkingHolderSubscription = {
  (event: "destroyed", listener: () => void): unknown;
  (event: "did-navigate", listener: () => void): unknown;
};

/**
 * The renderer side of a holder: the `webContents` that asked for it.
 *
 * Structural rather than `WebContents` so a unit test can hand over a plain
 * object — the only members the refcount needs are the identity, the two
 * teardown signals, and a way to stop listening for them.
 */
export type SimulatorParkingHolderSender = {
  id: number;
  on: SimulatorParkingHolderSubscription;
  off: SimulatorParkingHolderSubscription;
};

// How many live capture surfaces depend on the follow, keyed by the renderer
// that took them. Two are reachable at once inside one window — a chat pane's
// drawer and the Work sidebar's iOS tab — and the first of them to close must
// not drop the claim out from under the other.
//
// Keyed, not a bare count, because the only decrements are an explicit release
// and the ADE window's `closed` event. A renderer reload emits neither: it
// destroys the React tree without running any cleanup and the BrowserWindow
// never closes. A count-only refcount therefore stayed >= 1 forever, every
// later real release answered false, and every ADE window move kept
// repositioning the user's Simulator with no drawer open at all.
const simulatorParkingHolders = new Map<number, number>();
// webContents ids already wired to their teardown signals, mapped to the
// unsubscribe that removes them. A second holder from the same renderer must
// not arm a second pair of listeners, and — because the same long-lived
// renderer opens and closes the drawer over and over — every pair armed here
// has to come back off, or a dozen drawer cycles trip Node's max-listeners
// warning on the one webContents that never goes away.
const simulatorParkingHolderWatched = new Map<number, () => void>();

function unwatchSimulatorParkingHolder(senderId: number): void {
  const unsubscribe = simulatorParkingHolderWatched.get(senderId);
  if (!unsubscribe) return;
  simulatorParkingHolderWatched.delete(senderId);
  unsubscribe();
}

function unwatchAllSimulatorParkingHolders(): void {
  for (const senderId of [...simulatorParkingHolderWatched.keys()]) {
    unwatchSimulatorParkingHolder(senderId);
  }
}

function totalSimulatorParkingHolders(): number {
  let total = 0;
  for (const count of simulatorParkingHolders.values()) total += count;
  return total;
}

function scheduleSimulatorParking(window: BrowserWindow) {
  // Nothing to follow until a capture session has parked the window once, and
  // nothing to follow once the user has taken it over.
  if (!simulatorHasBeenParked() || simulatorFollowSuspended) return;
  if (simulatorParkingTimer) clearTimeout(simulatorParkingTimer);
  simulatorParkingTimer = setTimeout(() => {
    simulatorParkingTimer = null;
    if (window.isDestroyed()) return;
    void prepareSimulatorWindowForCapture(window).catch(() => {});
  }, 250);
}

export function followSimulatorWindowUnderAde(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) return;
  if (simulatorParkingWindow === window) {
    return;
  }
  cleanupSimulatorParkingFollow?.();
  simulatorParkingWindow = window;
  const onBoundsChanged = () => scheduleSimulatorParking(window);
  const onClosed = () => {
    cleanupSimulatorParkingFollow?.();
  };
  window.on("move", onBoundsChanged);
  window.on("resize", onBoundsChanged);
  window.once("closed", onClosed);
  cleanupSimulatorParkingFollow = () => {
    if (simulatorParkingTimer) {
      clearTimeout(simulatorParkingTimer);
      simulatorParkingTimer = null;
    }
    if (!window.isDestroyed()) {
      window.off("move", onBoundsChanged);
      window.off("resize", onBoundsChanged);
      window.off("closed", onClosed);
    }
    if (simulatorParkingWindow === window) simulatorParkingWindow = null;
    // The claim is gone, so its holders are too: a closed window must not leave
    // a positive count that the next claimant would have to release its way out
    // of. The listeners come off with them — forgetting the watch entry without
    // unsubscribing left the real webContents carrying one more pair on every
    // drawer cycle.
    simulatorParkingHolders.clear();
    unwatchAllSimulatorParkingHolders();
    simulatorAdeSetFrame = null;
    simulatorFollowSuspended = false;
    cleanupSimulatorParkingFollow = null;
  };
}

export function activeSimulatorParkingWindow(): BrowserWindow | null {
  if (!simulatorParkingWindow || simulatorParkingWindow.isDestroyed()) return null;
  return simulatorParkingWindow;
}

/** Drops the follow listeners and forgets the parked frame. Safe to call unparked. */
export function releaseSimulatorParkingFollow(): void {
  cleanupSimulatorParkingFollow?.();
}

/**
 * Runs a shutdown and drops the follow only once it has actually happened.
 *
 * `shutdown` enforces the single-owner rule and refuses a foreign caller by
 * throwing, and the service documents that check as running "before any
 * teardown so a refused shutdown leaves the stream and companion of the owning
 * chat untouched". Releasing first broke that promise from the outside: the
 * refusal travelled back to the caller with the owner's window-parking follow
 * already torn down.
 */
export async function releaseSimulatorParkingFollowAfter<T>(run: () => Promise<T>): Promise<T> {
  const result = await run();
  releaseSimulatorParkingFollow();
  return result;
}

/**
 * Registers one capture surface as depending on the current claim.
 *
 * Only the window that owns the claim can hold it: a window that lost the race
 * never parked anything, so it has nothing to release later either.
 *
 * Returns whether the holder was actually counted, and the answer travels all
 * the way back to the caller. A surface that assumed it had been counted would
 * later issue a release that decrements a holder it never took — someone
 * else's — and tear down a follow that is still in use.
 *
 * The holder is booked against `sender`, the renderer that asked, so a reload
 * of that renderer takes its holders with it.
 */
export function retainSimulatorParkingFollow(
  window: BrowserWindow | null,
  sender: SimulatorParkingHolderSender | null,
): boolean {
  if (!window || !sender || activeSimulatorParkingWindow() !== window) return false;
  simulatorParkingHolders.set(sender.id, (simulatorParkingHolders.get(sender.id) ?? 0) + 1);
  if (!simulatorParkingHolderWatched.has(sender.id)) {
    const onDestroyed = () => dropSimulatorParkingHoldersFor(sender.id);
    // A reload throws away the React tree — and the drawer's release with it —
    // without destroying the webContents: the object, its id and its listeners
    // all survive a navigation, which is exactly why ADE binds this window's
    // navigation logging once at creation. `destroyed` therefore never fires
    // for a reload, and watching only for it left the pre-reload holder booked
    // under the same sender id forever. The new document retains again, so the
    // count only ever climbed and the follow stayed pinned for the life of the
    // process.
    //
    // `did-navigate`, not `did-start-navigation`: the latter fires for
    // navigations that never commit, and ADE cancels exactly those — the window
    // preventDefaults every main-frame `will-navigate` that is not the renderer
    // URL, and a file dropped outside a drop zone is enough to trigger one.
    // Dropping the holders there tore the follow down under a document that was
    // still live and never re-retained. `did-navigate` fires only on a commit,
    // is main-frame-only, and excludes in-page navigations, so no isMainFrame /
    // isSameDocument filtering is needed. It still precedes the new document's
    // scripts, so the drop lands before the reloaded drawer re-retains.
    const onNavigated = () => dropSimulatorParkingHoldersFor(sender.id);
    sender.on("destroyed", onDestroyed);
    sender.on("did-navigate", onNavigated);
    simulatorParkingHolderWatched.set(sender.id, () => {
      sender.off("destroyed", onDestroyed);
      sender.off("did-navigate", onNavigated);
    });
  }
  return true;
}

/** Forgets every holder a renderer took, and drops the follow if it was the last. */
function dropSimulatorParkingHoldersFor(senderId: number): void {
  unwatchSimulatorParkingHolder(senderId);
  if (!simulatorParkingHolders.delete(senderId)) return;
  if (totalSimulatorParkingHolders() > 0) return;
  releaseSimulatorParkingFollow();
}

/**
 * Drops one holder and, at zero, the follow itself.
 *
 * Release is scoped to the claimant: a second window's drawer closing must not
 * tear down a follow it never owned. Within the claimant, the last holder out
 * turns off the lights — an earlier one leaving keeps the parked frame, so the
 * surviving surface is not re-attached (which would re-position *and* re-size
 * the Simulator window the user had since sized themselves).
 *
 * Returns whether the follow was actually dropped. Never goes negative: a
 * double release from one surface finds no claim to release the second time.
 * Scoped to `sender` as well as the window, so one renderer can only ever give
 * back what it took.
 */
export function releaseSimulatorParkingHolder(
  window: BrowserWindow | null,
  sender: SimulatorParkingHolderSender | null,
): boolean {
  if (!window || !sender || activeSimulatorParkingWindow() !== window) return false;
  const held = simulatorParkingHolders.get(sender.id) ?? 0;
  if (held > 1) simulatorParkingHolders.set(sender.id, held - 1);
  else if (held === 1) simulatorParkingHolders.delete(sender.id);
  if (totalSimulatorParkingHolders() > 0) return false;
  releaseSimulatorParkingFollow();
  return true;
}

/**
 * The one place ADE is allowed to take focus for the Simulator: the user
 * pressed Reveal on a hidden or minimized window. Parking must never do this.
 */
export async function revealSimulatorWindow(): Promise<{ ok: boolean; message: string | null }> {
  if (hostPlatform !== "darwin") {
    return { ok: false, message: "The iOS Simulator is only available on macOS." };
  }
  const script = [
    'tell application "System Events"',
    '  if not (exists process "Simulator") then return "missing"',
    '  tell process "Simulator"',
    '    set visible to true',
    '    repeat with simulatorWindow in windows',
    '      try',
    '        set value of attribute "AXMinimized" of simulatorWindow to false',
    '      end try',
    '    end repeat',
    '  end tell',
    'end tell',
    'tell application "Simulator" to activate',
    'return "ok"',
  ].join("\n");
  const result = await runMacUtility("osascript", ["-e", script], 1_200);
  if (result.code !== 0) {
    const denied = isAutomationDenied(result);
    return {
      ok: false,
      message: windowIssueMessage(denied ? "automation-denied" : "unknown")
        ?? "ADE could not bring the simulator window forward.",
    };
  }
  if (result.stdout.trim() === "missing") {
    return { ok: false, message: windowIssueMessage("not-running") };
  }
  // The user just chose where they want this window. Stop auto-following it
  // under ADE until the next capture session attaches.
  simulatorFollowSuspended = true;
  return { ok: true, message: null };
}

/** Opens the macOS privacy pane the blocked capability lives in. */
export async function openSimulatorPrivacyPane(pane: IosSimulatorPrivacyPane): Promise<{ ok: boolean }> {
  if (hostPlatform !== "darwin") return { ok: false };
  const anchor = pane === "automation" ? "Privacy_Automation" : "Privacy_ScreenCapture";
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  return { ok: true };
}

/**
 * Reads the caller's runtime session off an IPC payload.
 *
 * Electron main's own simulator service never sees a launch the brain daemon
 * owns, so its `activeSession` is always null. The hint only answers "is a
 * session running, and on which device" — it decides whether to park and
 * settle at all. Scoring the discovered sources against that device happens
 * renderer-side, in `pickSimulatorWindowSource`.
 */
export function readSimulatorSessionHint(arg: unknown): IosSimulatorWindowCaptureSessionHint | null {
  const session = (arg as { session?: unknown } | null)?.session;
  if (!session || typeof session !== "object") return null;
  const deviceUdid = (session as { deviceUdid?: unknown }).deviceUdid;
  if (typeof deviceUdid !== "string" || !deviceUdid.trim()) return null;
  const deviceName = (session as { deviceName?: unknown }).deviceName;
  return {
    deviceUdid: deviceUdid.trim(),
    deviceName: typeof deviceName === "string" && deviceName.trim() ? deviceName.trim() : null,
  };
}

/** Pure sweep of capturable Simulator windows. Mutates nothing. */
export async function listSimulatorWindowSources(): Promise<IosSimulatorWindowSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 320, height: 320 },
  });
  return sources
    .filter((source) => SIMULATOR_WINDOW_NAME.test(source.name))
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function settleWithin(ms: number, remainingMs: () => number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, remainingMs()))));
}

/**
 * Places the Simulator window where capture can reach it, then waits for the
 * window server to catch up. Mutating — separated from the listing above so a
 * caller that only wants to look never moves the user's window.
 *
 * Parks on the first attach of a capture session, and afterwards only when the
 * window is genuinely not capturable. A capturable window the user placed
 * themselves is left exactly where it is.
 */
export async function ensureSimulatorWindowCapturable(
  parkingWindow: BrowserWindow | null,
  options: { windowState: IosSimulatorWindowState; remainingMs: () => number },
): Promise<void> {
  if (simulatorHasBeenParked() && options.windowState.capturable === true) return;
  // A capture caller may start Simulator.app; the background follow may not.
  await prepareSimulatorWindowForCapture(parkingWindow, {
    attach: !simulatorHasBeenParked(),
    allowLaunch: true,
  });
  await settleWithin(300, options.remainingMs);
}

/** Last-resort re-park after a sweep found nothing, then a longer settle. */
export async function reattachSimulatorWindowForCapture(
  parkingWindow: BrowserWindow | null,
  options: { remainingMs: () => number },
): Promise<void> {
  await prepareSimulatorWindowForCapture(parkingWindow, { attach: true });
  await settleWithin(600, options.remainingMs);
}

/**
 * The one-time placement that starts a capture session: positions AND sizes the
 * Simulator window beside ADE. This is the only attach spelling callers outside
 * this module get — `prepareSimulatorWindowForCapture` also serves the polite
 * follow-up nudges, and every external caller has always wanted the attach.
 */
export function attachSimulatorWindowForCapture(
  window: BrowserWindow | null,
): Promise<void> {
  return prepareSimulatorWindowForCapture(window, { attach: true });
}
