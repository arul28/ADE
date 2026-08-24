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
  IosSimulatorWindowPermissionHint,
  IosSimulatorWindowSource,
  IosSimulatorWindowState,
} from "../../../shared/types";

/** Discovery is polled by the drawer; cap the wall time so a blocked simulator fails fast. */
export const SIMULATOR_SOURCE_DISCOVERY_BUDGET_MS = 4_000;

const SIMULATOR_WINDOW_NAME =
  /(?:^|\s|[(\[\-–])(simulator|iphone|ipad|apple\s*watch|apple\s*tv|vision\s*pro)(?:\s|[)\]\-–]|$)/i;

type MacUtilityResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

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
    const child = spawn(command, args, {
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
export const AUTOMATION_DENIED_PATTERN =
  /-1743|-25211|-10004|not authoriz|not allowed assistive access|is not allowed to send keystrokes/i;

function isAutomationDenied(result: MacUtilityResult): boolean {
  return AUTOMATION_DENIED_PATTERN.test(result.stderr);
}

// desktopCapturer hands back black thumbnails without the Screen Recording
// grant, and macOS gives no error — the drawer just showed an empty live view.
export function screenCaptureAccessStatus(): IosSimulatorPermissionStatus {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen") as IosSimulatorPermissionStatus;
  } catch {
    return "unknown";
  }
}

export function permissionHint(
  kind: IosSimulatorPrivacyPane,
  status: IosSimulatorPermissionStatus,
): IosSimulatorWindowPermissionHint {
  return {
    kind,
    status,
    // macOS never prompts for Screen Recording from an Electron main process;
    // that grant is Settings-only. An undecided Automation grant still prompts
    // on the next Apple event, so retrying is worth offering.
    canRequest: kind === "automation" && status === "not-determined",
    settingsPane: kind,
  };
}

export function windowIssueMessage(issue: IosSimulatorWindowState["issue"]): string | null {
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
  if (process.platform !== "darwin") {
    return {
      appRunning: false,
      visible: null,
      windowCount: null,
      minimizedWindowCount: null,
      capturable: false,
      issue: "unknown",
      message: null,
      permission: null,
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
      permission: permissionHint("screen-recording", screenStatus),
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
      permission: denied ? permissionHint("automation", "denied") : null,
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
      permission: null,
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
    permission: null,
  };
}

type SimulatorWindowFrame = { x: number; y: number; width: number; height: number };

// What ADE last wrote to the Simulator window. Once the live frame stops
// matching it, the user moved or resized the window themselves and owns it
// until the next explicit attach — ADE stops following.
let simulatorAdeSetFrame: SimulatorWindowFrame | null = null;
let simulatorFollowSuspended = false;

export function simulatorHasBeenParked(): boolean {
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
 */
export async function prepareSimulatorWindowForCapture(
  window: BrowserWindow | null,
  options: { attach?: boolean } = {},
): Promise<void> {
  if (process.platform !== "darwin") return;
  const attach = options.attach === true;
  if (attach) {
    simulatorFollowSuspended = false;
    simulatorAdeSetFrame = null;
  }
  // `-g` keeps the Simulator behind ADE; it must never take focus.
  await runMacUtility("open", ["-g", "-a", "Simulator"], 900);
  const measured = await runMacUtility("osascript", ["-e", MEASURE_SIMULATOR_WINDOW_SCRIPT], 900);
  if (measured.code !== 0) return;
  const parts = measured.stdout.trim().split("|");
  if (parts[0] !== "ok") return;
  const [, visibleRaw, minimizedRaw, xRaw, yRaw, widthRaw, heightRaw] = parts;
  const toInt = (value: string | undefined) => Number.parseInt(value ?? "", 10);
  const current: SimulatorWindowFrame = {
    x: toInt(xRaw),
    y: toInt(yRaw),
    width: toInt(widthRaw),
    height: toInt(heightRaw),
  };
  const measuredFrame = Object.values(current).every((value) => Number.isFinite(value))
    ? current
    : null;
  const hidden = visibleRaw !== "true";
  const minimized = minimizedRaw === "true";

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
  // Remember only what ADE actually wrote, so the next call can tell an
  // ADE-parked window apart from one the user has since moved.
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
 * The one place ADE is allowed to take focus for the Simulator: the user
 * pressed Reveal on a hidden or minimized window. Parking must never do this.
 */
export async function revealSimulatorWindow(): Promise<{ ok: boolean; message: string | null }> {
  if (process.platform !== "darwin") {
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
  if (process.platform !== "darwin") return { ok: false };
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
  await prepareSimulatorWindowForCapture(parkingWindow, { attach: !simulatorHasBeenParked() });
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
