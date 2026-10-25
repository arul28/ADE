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

/** What the pane and the CLI call a lane's Linux screen. */
const LINUX_DISPLAY_NAME_PREFIX = "Linux Desktop";

const WINDOW_ACTION_OPS: Record<MacDesktopWindowAction, (typeof MAC_DESKTOP_DRIVER_OPS)[keyof typeof MAC_DESKTOP_DRIVER_OPS]> = {
  focus: MAC_DESKTOP_DRIVER_OPS.windowFocus,
  minimize: MAC_DESKTOP_DRIVER_OPS.windowMinimize,
  close: MAC_DESKTOP_DRIVER_OPS.windowClose,
};

export function createLinuxSeatProvider(client: Parameters<typeof createSeatProvider>[0]): DesktopSeatProvider {
  return createSeatProvider(client, {
    id: "linux-xvfb",
    windowAction: (request, args) => request(WINDOW_ACTION_OPS[args.action], {
      laneId: args.laneId,
      windowId: args.windowId,
    }),
  });
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
