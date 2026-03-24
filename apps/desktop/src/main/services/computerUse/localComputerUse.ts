import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { MissionCloseoutRequirementKey, ValidationEvidenceRequirement } from "../../../shared/types";
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

export type GhostDoctorProcessHealthState = "healthy" | "stale" | "unknown";

export type GhostDoctorProcessHealth = {
  state: GhostDoctorProcessHealthState;
  processCount: number | null;
  detail: string;
};

const DARWIN_BLOCKED_DETAIL = "Local computer-use runtime is currently implemented for macOS only.";

function present(command: string, detail: string): LocalComputerUseCapability {
  return { state: "present", available: true, command, detail };
}

function missing(command: string, detail: string): LocalComputerUseCapability {
  return { state: "missing", available: false, command, detail };
}

function blocked(detail: string): LocalComputerUseCapability {
  return { state: "blocked_by_capability", available: false, command: null, detail };
}

const GHOST_DOCTOR_PROCESS_REGEX = /(\d+)\s+ghost MCP process(?:es)?\s+found/i;

export function parseGhostDoctorProcessHealth(output: string): GhostDoctorProcessHealth {
  const trimmed = output.trim();
  if (!trimmed.length) {
    return {
      state: "unknown",
      processCount: null,
      detail: "Ghost doctor did not return any process-health output.",
    };
  }

  const match = trimmed.match(GHOST_DOCTOR_PROCESS_REGEX);
  const processCount = match ? Number(match[1]) : null;
  if (typeof processCount === "number" && Number.isFinite(processCount)) {
    if (processCount > 1) {
      return {
        state: "stale",
        processCount,
        detail: `Ghost doctor found ${processCount} ghost MCP processes. Stop the stale processes and rerun ghost doctor.`,
      };
    }
    return {
      state: "healthy",
      processCount,
      detail: `Ghost doctor found ${processCount} ghost MCP process${processCount === 1 ? "" : "es"} running.`,
    };
  }

  if (/\[FAIL\]\s+Processes:/i.test(trimmed)) {
    return {
      state: "stale",
      processCount: null,
      detail: "Ghost doctor reported a Ghost MCP process failure, but did not include a parseable count.",
    };
  }

  if (/\[ok\]\s+Processes:/i.test(trimmed)) {
    return {
      state: "healthy",
      processCount: null,
      detail: "Ghost doctor reported healthy Ghost MCP process state.",
    };
  }

  return {
    state: "unknown",
    processCount: null,
    detail: "Ghost doctor output did not include a parseable Ghost MCP process check.",
  };
}

export function getGhostDoctorProcessHealth(): GhostDoctorProcessHealth {
  if (process.platform !== "darwin" || !commandExists("ghost")) {
    return {
      state: "unknown",
      processCount: null,
      detail: "Ghost doctor is unavailable on this platform.",
    };
  }

  const result = spawnSync("ghost", ["doctor"], { encoding: "utf8", timeout: 10_000 });
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const parsed = parseGhostDoctorProcessHealth(combinedOutput);

  if (result.error && parsed.state === "unknown") {
    return {
      ...parsed,
      detail: `${parsed.detail} (${result.error.message})`,
    };
  }

  return parsed;
}

export function getLocalComputerUseCapabilities(): LocalComputerUseCapabilities {
  if (process.platform !== "darwin") {
    const blockedCapability = blocked(DARWIN_BLOCKED_DETAIL);
    return {
      platform: process.platform,
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

  const screenshot = commandExists("screencapture")
    ? present("screencapture", "macOS screencapture is available for screenshots.")
    : missing("screencapture", "macOS screencapture is required for screenshots.");
  const videoRecording = commandExists("screencapture")
    ? present("screencapture", "macOS screencapture can record screen video with the -v flag.")
    : missing("screencapture", "macOS screencapture is required for local video capture.");
  const appLaunch = commandExists("open")
    ? present("open", "macOS open is available for launching and focusing apps.")
    : missing("open", "macOS open is required for launching apps.");
  const guiInteraction = commandExists("swift")
    ? present("swift", "Swift CLI is available for native click automation; osascript can handle key input.")
    : commandExists("osascript")
      ? present("osascript", "AppleScript is available for text entry and keypress automation.")
      : missing("swift", "Either Swift CLI or osascript is required for GUI interaction.");
  const environmentInfo = commandExists("osascript")
    ? present("osascript", "AppleScript is available for frontmost-app environment inspection.")
    : missing("osascript", "AppleScript is required for local environment inspection.");

  const allStates = [screenshot, videoRecording, appLaunch, guiInteraction, environmentInfo].map((entry) => entry.state);
  const overallState: LocalComputerUseCapabilityState = allStates.every((state) => state === "present")
    ? "present"
    : allStates.some((state) => state === "blocked_by_capability")
      ? "blocked_by_capability"
      : "missing";

  return {
    platform: process.platform,
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
          ? blocked(DARWIN_BLOCKED_DETAIL)
          : missing(guiInteraction.command ?? screenshot.command ?? "screencapture", "Browser verification needs screenshot capture and local GUI interaction."),
      browser_trace: screenshot.available
        ? present(screenshot.command ?? "screencapture", "Browser trace collection can attach local screenshot-backed evidence or trace files.")
        : screenshot.state === "blocked_by_capability"
          ? blocked(DARWIN_BLOCKED_DETAIL)
          : missing(screenshot.command ?? "screencapture", "Browser trace evidence requires local capture support."),
      video_recording: videoRecording,
      console_logs: environmentInfo,
    },
  };
}

export function getCapabilityForRequirement(
  requirement: MissionCloseoutRequirementKey | ValidationEvidenceRequirement | string,
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
  return path.join(artifactsDir, `${Date.now()}-${safeStem}.${safeExt}`);
}

export function toProjectArtifactUri(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return absolutePath;
}
