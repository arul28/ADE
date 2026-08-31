import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { ComputerUseArtifactKind } from "../../../shared/types";
import { commandExists } from "../ai/utils";

export type LocalComputerUseCapabilityState = "present" | "missing" | "blocked_by_capability";

export type LocalComputerUseCapability = {
  state: LocalComputerUseCapabilityState;
  available: boolean;
  command: string | null;
  detail: string;
};

export type LocalComputerUseCapabilities = {
  platform: NodeJS.Platform;
  overallState: LocalComputerUseCapabilityState;
  screenshot: LocalComputerUseCapability;
  videoRecording: LocalComputerUseCapability;
  appLaunch: LocalComputerUseCapability;
  guiInteraction: LocalComputerUseCapability;
  environmentInfo: LocalComputerUseCapability;
  proofRequirements: Record<
    "screenshot" | "browser_verification" | "browser_trace" | "video_recording" | "console_logs",
    LocalComputerUseCapability
  >;
};

const NATIVE_COMPUTER_USE_BLOCKED_DETAIL =
  "Native screenshot, video, and OS GUI control are currently implemented for macOS only. Electron Control and proof-file ingestion remain available on supported desktop platforms.";

function present(command: string, detail: string): LocalComputerUseCapability {
  return { state: "present", available: true, command, detail };
}

function missing(command: string, detail: string): LocalComputerUseCapability {
  return { state: "missing", available: false, command, detail };
}

function blocked(detail: string): LocalComputerUseCapability {
  return { state: "blocked_by_capability", available: false, command: null, detail };
}

const SCREEN_RECORDING_DENIED_SCREENSHOT_DETAIL =
  "macOS Screen Recording permission is not granted, so screencapture cannot read the display. Grant Screen Recording to the app running ADE in System Settings > Privacy & Security > Screen Recording, then restart it.";
const SCREEN_RECORDING_DENIED_VIDEO_DETAIL =
  "macOS Screen Recording permission is not granted, so screencapture cannot record the display. Grant Screen Recording to the app running ADE in System Settings > Privacy & Security > Screen Recording, then restart it.";

/** Stderr macOS emits when the capture ran but TCC withheld the display. */
const SCREEN_RECORDING_DENIED_STDERR = /could not create image from display/i;

/**
 * Presence of the `screencapture` binary says nothing: it ships with every
 * macOS install, so a binary check reports "present" on a machine where the
 * very next capture dies with "could not create image from display". The only
 * honest probe is to actually take a capture, so this runs the cheapest one
 * there is — a 1x1 rectangle into the OS temp dir, deleted immediately.
 *
 * Denial shows up as a non-zero exit; the stderr signature and a zero-byte
 * output file are belt-and-braces for macOS versions that exit 0 after
 * writing nothing.
 */
function probeScreenCapturePermission(): boolean {
  const probePath = path.join(os.tmpdir(), `ade-screencapture-probe-${randomUUID().slice(0, 8)}.png`);
  try {
    const result = spawnSync("screencapture", ["-x", "-t", "png", "-R", "0,0,1,1", probePath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) return false;
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (SCREEN_RECORDING_DENIED_STDERR.test(stderr)) return false;
    const stat = fs.statSync(probePath, { throwIfNoEntry: false });
    return Boolean(stat && stat.size > 0);
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // Best effort: a leftover 1x1 png in the temp dir is not worth a throw.
    }
  }
}

let screenCapturePermissionProbe: () => boolean = probeScreenCapturePermission;
let screenCapturePermissionCache: boolean | null = null;

/**
 * One probe per process. `getBackendStatus()` is called often enough that a
 * spawn per call would be a real cost, and repeatedly poking TCC is worse than
 * pointless. A permission grant requires restarting the granted app anyway, so
 * the answer cannot usefully change inside one process lifetime.
 */
function isScreenCapturePermitted(): boolean {
  if (screenCapturePermissionCache === null) {
    screenCapturePermissionCache = screenCapturePermissionProbe();
  }
  return screenCapturePermissionCache;
}

/** Test-only seam: override the memoized probe (pass null to restore the real one). */
export function __setScreenCapturePermissionProbeForTests(probe: (() => boolean) | null): void {
  screenCapturePermissionProbe = probe ?? probeScreenCapturePermission;
  screenCapturePermissionCache = null;
}

export function getLocalComputerUseCapabilities(
  platform: NodeJS.Platform = process.platform,
  commandAvailable: (command: string) => boolean = commandExists,
  screenCapturePermitted: () => boolean = isScreenCapturePermitted,
): LocalComputerUseCapabilities {
  if (platform !== "darwin") {
    const blockedCapability = blocked(NATIVE_COMPUTER_USE_BLOCKED_DETAIL);
    return {
      platform,
      overallState: "blocked_by_capability",
      screenshot: blockedCapability,
      videoRecording: blockedCapability,
      appLaunch: blockedCapability,
      guiInteraction: blockedCapability,
      environmentInfo: blockedCapability,
      proofRequirements: {
        screenshot: blockedCapability,
        browser_verification: blockedCapability,
        browser_trace: blockedCapability,
        video_recording: blockedCapability,
        console_logs: blockedCapability,
      },
    };
  }

  // The binary is always there on macOS; the Screen Recording grant is what
  // actually decides whether a capture produces an image, so only probe once
  // the binary check has passed.
  const screenCaptureInstalled = commandAvailable("screencapture");
  const screenCaptureAllowed = screenCaptureInstalled ? screenCapturePermitted() : false;

  const screenshot = !screenCaptureInstalled
    ? missing("screencapture", "macOS screencapture is required for screenshots.")
    : screenCaptureAllowed
      ? present("screencapture", "macOS screencapture is available for screenshots.")
      : missing("screencapture", SCREEN_RECORDING_DENIED_SCREENSHOT_DETAIL);
  const videoRecording = !screenCaptureInstalled
    ? missing("screencapture", "macOS screencapture is required for local video capture.")
    : screenCaptureAllowed
      ? present("screencapture", "macOS screencapture can record screen video with the -v flag.")
      : missing("screencapture", SCREEN_RECORDING_DENIED_VIDEO_DETAIL);
  const appLaunch = commandAvailable("open")
    ? present("open", "macOS open is available for launching and focusing apps.")
    : missing("open", "macOS open is required for launching apps.");
  const guiInteraction = commandAvailable("swift")
    ? present("swift", "Swift CLI is available for native click automation; osascript can handle key input.")
    : commandAvailable("osascript")
      ? present("osascript", "AppleScript is available for text entry and keypress automation.")
      : missing("swift", "Either Swift CLI or osascript is required for GUI interaction.");
  const environmentInfo = commandAvailable("osascript")
    ? present("osascript", "AppleScript is available for frontmost-app environment inspection.")
    : missing("osascript", "AppleScript is required for local environment inspection.");

  const allStates = [screenshot, videoRecording, appLaunch, guiInteraction, environmentInfo].map((entry) => entry.state);
  const overallState: LocalComputerUseCapabilityState = allStates.every((state) => state === "present")
    ? "present"
    : allStates.some((state) => state === "blocked_by_capability")
      ? "blocked_by_capability"
      : "missing";

  return {
    platform,
    overallState,
    screenshot,
    videoRecording,
    appLaunch,
    guiInteraction,
    environmentInfo,
    proofRequirements: {
      screenshot,
      browser_verification: screenshot.available && guiInteraction.available
        ? present(screenshot.command ?? guiInteraction.command ?? "screencapture", "Browser verification can use screenshots plus local GUI interaction.")
        : guiInteraction.state === "blocked_by_capability" || screenshot.state === "blocked_by_capability"
          ? blocked(NATIVE_COMPUTER_USE_BLOCKED_DETAIL)
          : missing(guiInteraction.command ?? screenshot.command ?? "screencapture", "Browser verification needs screenshot capture and local GUI interaction."),
      browser_trace: screenshot.available
        ? present(screenshot.command ?? "screencapture", "Browser trace collection can attach local screenshot-backed evidence or trace files.")
        : screenshot.state === "blocked_by_capability"
          ? blocked(NATIVE_COMPUTER_USE_BLOCKED_DETAIL)
          : missing(screenshot.command ?? "screencapture", "Browser trace evidence requires local capture support."),
      video_recording: videoRecording,
      console_logs: environmentInfo,
    },
  };
}

export function getCapabilityForRequirement(
  requirement: ComputerUseArtifactKind | string,
): LocalComputerUseCapability | null {
  const capabilities = getLocalComputerUseCapabilities();
  switch (requirement) {
    case "screenshot":
      return capabilities.proofRequirements.screenshot;
    case "browser_verification":
      return capabilities.proofRequirements.browser_verification;
    case "browser_trace":
      return capabilities.proofRequirements.browser_trace;
    case "video_recording":
      return capabilities.proofRequirements.video_recording;
    case "console_logs":
      return capabilities.proofRequirements.console_logs;
    default:
      return null;
  }
}

export function createComputerUseArtifactPath(projectRoot: string, stem: string, extension: string): string {
  const artifactsDir = path.join(resolveAdeLayout(projectRoot).artifactsDir, "computer-use");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const safeStem = stem.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
  const safeExt = extension.replace(/^\./, "").trim() || "txt";
  return path.join(artifactsDir, `${Date.now()}-${safeStem}-${randomUUID().slice(0, 8)}.${safeExt}`);
}

export function toProjectArtifactUri(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/");
  }
  return absolutePath;
}
