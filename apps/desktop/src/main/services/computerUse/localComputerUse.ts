import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
  "Native screenshot, video, and OS GUI control are currently implemented for macOS only. App Control and proof-file ingestion remain available on supported desktop platforms.";

function present(command: string, detail: string): LocalComputerUseCapability {
  return { state: "present", available: true, command, detail };
}

function missing(command: string, detail: string): LocalComputerUseCapability {
  return { state: "missing", available: false, command, detail };
}

function blocked(detail: string): LocalComputerUseCapability {
  return { state: "blocked_by_capability", available: false, command: null, detail };
}

export function getLocalComputerUseCapabilities(
  platform: NodeJS.Platform = process.platform,
  commandAvailable: (command: string) => boolean = commandExists,
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

  const screenshot = commandAvailable("screencapture")
    ? present("screencapture", "macOS screencapture is available for screenshots.")
    : missing("screencapture", "macOS screencapture is required for screenshots.");
  const videoRecording = commandAvailable("screencapture")
    ? present("screencapture", "macOS screencapture can record screen video with the -v flag.")
    : missing("screencapture", "macOS screencapture is required for local video capture.");
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

function computerUseFileName(stem: string, extension: string): string {
  const safeStem = stem.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
  const safeExt = extension.replace(/^\./, "").trim() || "txt";
  return `${Date.now()}-${safeStem}-${randomUUID().slice(0, 8)}.${safeExt}`;
}

export function createComputerUseArtifactPath(projectRoot: string, stem: string, extension: string): string {
  const artifactsDir = path.join(resolveAdeLayout(projectRoot).artifactsDir, "computer-use");
  fs.mkdirSync(artifactsDir, { recursive: true });
  return path.join(artifactsDir, computerUseFileName(stem, extension));
}

/**
 * Where a capture lands when it is NOT being filed as proof.
 *
 * Proof is explicit: only a proof-named call creates a drawer record. A bare
 * `screenshot_environment` (agent vision, an automation run) still has to put
 * the bytes somewhere the caller can read them and `ade proof attach` can later
 * promote them from, so they go to the project's cache/tmp scratch root — which
 * the broker already lists as an allowed import root — instead of the artifact
 * store the drawer reads.
 */
export function createComputerUseScratchPath(projectRoot: string, stem: string, extension: string): string {
  const scratchDir = path.join(resolveAdeLayout(projectRoot).tmpDir, "computer-use");
  fs.mkdirSync(scratchDir, { recursive: true });
  return path.join(scratchDir, computerUseFileName(stem, extension));
}

export function toProjectArtifactUri(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/");
  }
  return absolutePath;
}
