/**
 * The Linux lane-screen backend, as a `DesktopSeatAdapter`.
 *
 * A sibling of the Mac and Windows adapters: the service, the lease, ownership,
 * proof and streaming are shared, and this file only says which helper to run
 * and which ops it answers. The helper (`native/ADEDesktopDriverLinux`, Rust)
 * gives each lane its own Xvfb display with a window manager and a private
 * D-Bus session, and speaks the same NDJSON op table as the other drivers.
 *
 * Every window on a lane's Linux screen belongs to the lane, so the Mac-only
 * ops (park, unpark, adopt, present) answer `unknown_op` and the service never
 * offers them; the window verbs (focus, minimize, close) are answered.
 */

import { expectedErrorKind } from "../../../shared/expectedError";
import {
  LINUX_DESKTOP_LINUX_ONLY_MESSAGE,
  macDesktopDisplayName,
  type DesktopSeatProvider,
  type MacDesktopWindowAction,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import { createMacDesktopDriverClient, MAC_DESKTOP_DRIVER_OPS } from "../macDesktop/macDesktopDriverClient";
import {
  createSeatProvider,
  type DesktopSeatAdapter,
  type MacDesktopDriverClientFactory,
} from "../macDesktop/macDesktopSeatProvider";
import { resolveLinuxDesktopDriverBinary } from "../native/nativeHelperPaths";
import { logLinuxScreenFact, reportLinuxScreenProblem } from "./linuxScreenTelemetry";

/** What the pane and the CLI call a lane's Linux screen. */
const LINUX_DISPLAY_NAME_PREFIX = "Linux Desktop";

const WINDOW_ACTION_OPS: Record<MacDesktopWindowAction, (typeof MAC_DESKTOP_DRIVER_OPS)[keyof typeof MAC_DESKTOP_DRIVER_OPS]> = {
  focus: MAC_DESKTOP_DRIVER_OPS.windowFocus,
  minimize: MAC_DESKTOP_DRIVER_OPS.windowMinimize,
  close: MAC_DESKTOP_DRIVER_OPS.windowClose,
};

export function createLinuxSeatProvider(client: Parameters<typeof createSeatProvider>[0]): DesktopSeatProvider {
  const provider = createSeatProvider(client, {
    id: "linux-xvfb",
    windowAction: (request, args) => request(WINDOW_ACTION_OPS[args.action], {
      laneId: args.laneId,
      windowId: args.windowId,
    }),
  });
  return {
    ...provider,
    // A screen that fails to come up, or comes up without its window manager
    // or accessibility bus, is the first thing that differs between
    // distributions, so it is reported with the host it happened on.
    async create(args) {
      let reply: Awaited<ReturnType<DesktopSeatProvider["create"]>>;
      try {
        reply = await provider.create(args);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const message = error instanceof Error ? error.message : String(error);
        // A refusal the caller caused (a bad size, a lane already busy) is its answer, not a host fault.
        if (expectedErrorKind(error) !== "user") {
          reportLinuxScreenProblem("display_create_failed", message, { code }, typeof code === "string" ? code : "");
        }
        throw error;
      }
      reportDegradedScreen(reply);
      return reply;
    },
  };
}

/** A missing package is the machine's state (a log); a daemon that would not start is a defect (an issue). */
function reportDegradedScreen(reply: unknown): void {
  const linux = (reply as { linux?: unknown } | null)?.linux;
  if (!linux || typeof linux !== "object") return;
  const facts = linux as { windowManager?: unknown; accessibility?: unknown; accessibilityError?: unknown };
  const accessibilityError = typeof facts.accessibilityError === "string" ? facts.accessibilityError : null;
  if (accessibilityError && !/not installed/i.test(accessibilityError)) {
    reportLinuxScreenProblem("display_degraded", `accessibility bus: ${accessibilityError}`, {}, "accessibility");
  } else if (accessibilityError) {
    logLinuxScreenFact("display_degraded", { accessibilityError }, "accessibility");
  }
  if (facts.windowManager === false) logLinuxScreenFact("display_degraded", { windowManager: false }, "window_manager");
}

/**
 * The Linux `DesktopSeatAdapter`, for the service's `seat` dep.
 *
 * `adeHome` is passed to the helper as `--ade-home`: each lane's X authority,
 * browser profile and logs live under `<adeHome>/linux-desktop/`, and a
 * restarted helper sweeps X servers a crashed one left there.
 */
export function createLinuxDesktopSeatAdapter(args: { logger: Logger; adeHome: string }): DesktopSeatAdapter {
  const resolveExecutablePath = () => resolveLinuxDesktopDriverBinary({ platform: "linux", logger: args.logger });
  const createDriverClient: MacDesktopDriverClientFactory = (clientArgs) => createMacDesktopDriverClient({
    logger: clientArgs.logger,
    platform: clientArgs.platform,
    supportedPlatforms: ["linux"],
    unsupportedMessage: LINUX_DESKTOP_LINUX_ONLY_MESSAGE,
    unsupportedTitle: "Linux Desktop needs a Linux host",
    driverLabel: "Linux Desktop",
    driverArgs: ["host", "--ade-home", args.adeHome],
    resolveExecutablePath,
    onHealthChanged: clientArgs.onHealthChanged,
    onDriverLost: clientArgs.onDriverLost,
  });
  return {
    id: "linux-xvfb",
    platform: "linux",
    unsupportedMessage: LINUX_DESKTOP_LINUX_ONLY_MESSAGE,
    unsupportedTitle: "Linux Desktop needs a Linux host",
    driverLabel: "Linux Desktop",
    resolveExecutablePath,
    createProvider: (client) => createLinuxSeatProvider(client),
    createDriverClient,
    // An Xvfb display has no Screen Recording or Accessibility grants to ask for.
    permissionsSupported: false,
    displayName: (laneName) => macDesktopDisplayName(laneName, LINUX_DISPLAY_NAME_PREFIX),
  };
}
