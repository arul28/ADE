/**
 * The NDJSON client for `ade-desktop-driver.exe` (the Windows driver).
 *
 * The wire is the Mac driver's, byte for byte — one JSON object per line, the
 * same `ping`/`display.*`/`window.*`/`input`/`stream.*`/`record.*` ops, the
 * same reply envelope — so the whole protocol, restart-with-backoff, and health
 * shape are reused from `macDesktopDriverClient.ts` and only three things are
 * configured here:
 *
 *   - the platform is win32,
 *   - the helper is spawned as `host --ade-home <dir>`, the mode the brain runs
 *     in the console session,
 *   - the health copy names Windows Desktop.
 *
 * The `--ade-home` value must be the same directory the brain runs against: the
 * host writes the child-session launcher it starts at logon, and that launcher
 * has to reach the same runtime the console session does.
 */

import type { spawn } from "node:child_process";

import {
  WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
  type MacDesktopDriverHealth,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import { createMacDesktopDriverClient, type MacDesktopDriverClient } from "../macDesktop/macDesktopDriverClient";
import { resolveWindowsDesktopDriverBinary } from "../native/nativeHelperPaths";

export function createWindowsDesktopDriverClient(deps: {
  logger: Logger;
  platform: NodeJS.Platform;
  /** The actual ADE home, passed to the helper as `--ade-home`. */
  adeHome: string;
  onHealthChanged: (health: MacDesktopDriverHealth) => void;
  onDriverLost: (reason: string) => void;
  requestTimeoutMs?: number;
  /** Test seam. Defaults to `child_process.spawn`. */
  spawnProcess?: typeof spawn;
}): MacDesktopDriverClient {
  return createMacDesktopDriverClient({
    logger: deps.logger,
    platform: deps.platform,
    supportedPlatforms: ["win32"],
    unsupportedMessage: WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
    unsupportedTitle: "Windows Desktop needs a Windows host",
    driverLabel: "Windows Desktop",
    driverArgs: ["host", "--ade-home", deps.adeHome],
    // Windows: ask the host to quit over stdin so it can sign its child session
    // out; `kill` there is TerminateProcess and skips the native cleanup.
    gracefulQuit: true,
    resolveExecutablePath: () => resolveWindowsDesktopDriverBinary({ platform: deps.platform, logger: deps.logger }),
    onHealthChanged: deps.onHealthChanged,
    onDriverLost: deps.onDriverLost,
    ...(deps.requestTimeoutMs != null ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
    ...(deps.spawnProcess ? { spawnProcess: deps.spawnProcess } : {}),
  });
}
