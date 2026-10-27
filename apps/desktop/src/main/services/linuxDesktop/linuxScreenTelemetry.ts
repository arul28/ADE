/**
 * Sentry reporting for Linux lane screens, tagged with the host it ran on.
 *
 * Only Ubuntu x64 is exercised by hand, so a failure on another distribution
 * or CPU is how ADE learns that the package names, the helper or the encoder
 * are wrong there. Every report carries the same host tags (distribution,
 * version, CPU, package manager, container), so Sentry can be searched by
 * them, and each kind is reported once per process: a brain whose helper keeps
 * dying is one event, not one per restart.
 *
 * Nothing here carries user content: kinds, error messages from the helper or
 * the package manager, package names and host facts only.
 */

import fs from "node:fs";
import { captureProblem, sendSentryLog } from "../../../shared/sentry/capture";

export type LinuxScreenProblemKind =
  /** The helper could not start, or exited while lanes had screens. */
  | "helper_start_failed"
  | "helper_lost"
  /** `display.create` failed: Xvfb, the window manager or D-Bus did not come up. */
  | "display_create_failed"
  /** The screen came up, but its accessibility bus would not start. */
  | "display_degraded"
  /** A recording's encoder died mid-recording. */
  | "recording_interrupted"
  /** `ade screen setup` could not install what is missing, or the install left it missing. */
  | "setup_failed";

export type LinuxHostTags = {
  "linux.distro": string;
  "linux.distro_version": string;
  "linux.distro_like": string;
  "linux.container": boolean;
  arch: string;
};

let cachedHostTags: LinuxHostTags | null = null;

function readOsRelease(): Record<string, string> {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      const fields: Record<string, string> = {};
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (match) fields[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
      return fields;
    } catch {
      // Try the next location.
    }
  }
  return {};
}

/** The host facts every Linux screen report carries. Read once per process. */
export function linuxHostTags(): LinuxHostTags {
  if (cachedHostTags) return cachedHostTags;
  const release = readOsRelease();
  cachedHostTags = {
    "linux.distro": release.ID || "unknown",
    "linux.distro_version": release.VERSION_ID || "unknown",
    "linux.distro_like": release.ID_LIKE || "none",
    "linux.container": fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"),
    arch: process.arch,
  };
  return cachedHostTags;
}

const reported = new Set<string>();

/**
 * One Sentry issue per kind and distribution. `detail` narrows the once-per-process
 * key (an error code, the missing packages), so a second, different failure of
 * the same kind still reports.
 */
export function reportLinuxScreenProblem(
  kind: LinuxScreenProblemKind,
  message: string,
  extra: Record<string, unknown> = {},
  detail = "",
): void {
  const key = `${kind}\u0000${detail}`;
  if (reported.has(key)) return;
  reported.add(key);
  const host = linuxHostTags();
  captureProblem(`linux_screen.${kind}: ${message}`, {
    level: "warning",
    tags: { feature: "linux_screen", "linux_screen.kind": kind, ...host },
    extra: { ...extra, ...(detail ? { detail } : {}) },
    fingerprint: ["linux_screen", kind, host["linux.distro"], detail],
  });
}

/**
 * A fact about a Linux host that is not a defect (what it was missing, a sudo
 * that needs a password), as a Sentry Log: searchable by distribution, never
 * an issue. Once per process per event and detail.
 */
export function logLinuxScreenFact(event: string, attributes: Record<string, unknown>, detail = ""): void {
  const key = `log\u0000${event}\u0000${detail}`;
  if (reported.has(key)) return;
  reported.add(key);
  sendSentryLog("warn", `linux_screen.${event}`, { ...linuxHostTags(), ...attributes });
}
