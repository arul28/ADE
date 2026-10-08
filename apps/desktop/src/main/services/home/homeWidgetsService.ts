import path from "node:path";

import { HOME_WIDGETS_IPC } from "../../../shared/types/homeWidgets";
import { createClipboardHistory, type HomeWidgetsClipboard } from "./homeClipboardHistory";
import { createMachineMonitor } from "./homeMachine";
import { createWeatherService, type HomeWeatherFetch } from "./homeWeather";

/**
 * The main-process half of the home page's widgets: clipboard history
 * (`homeClipboardHistory.ts`), machine health and ports (`homeMachine.ts`)
 * and weather (`homeWeather.ts`).
 *
 * Every rule here exists because of the Windows main-thread stall (a 2s
 * synchronous PowerShell probe every 2s made the whole app stutter): nothing
 * spawns synchronously, nothing starts PowerShell, Windows tools are spawned
 * off the main thread, and nothing runs unless a widget asked for it.
 */

export type HomeWidgetsServiceDeps = {
  userDataDir: string;
  clipboard: HomeWidgetsClipboard;
  /** Pids of ADE's own processes, which the kill action refuses. */
  ownPids: () => number[];
  /** Pids of ADE's background runtime (the brain), when known; also refused. */
  runtimePids?: () => Array<number | null | undefined>;
  broadcast: (channel: string, payload: unknown) => void;
  /** Electron's `powerMonitor.isOnBatteryPower()`: one cheap OS call, no polling service. */
  onBatteryPower?: () => boolean;
  /** Electron's `app.isPackaged` (an unpackaged build protects the dev renderer's server from the kill action). */
  isPackaged?: boolean;
  /** The fetch for weather; Electron's `net.fetch` in the app (it follows the system proxy). */
  fetch?: HomeWeatherFetch;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
  platform?: NodeJS.Platform;
};

export function createHomeWidgetsService(deps: HomeWidgetsServiceDeps) {
  const platform = deps.platform ?? process.platform;
  const clipboard = createClipboardHistory({
    dir: path.join(deps.userDataDir, "home-widgets"),
    clipboard: deps.clipboard,
    platform,
    broadcast: (state) => deps.broadcast(HOME_WIDGETS_IPC.clipboardChanged, state),
    logger: deps.logger,
  });
  const machine = createMachineMonitor({
    platform,
    ownPids: deps.ownPids,
    runtimePids: deps.runtimePids,
    onBatteryPower: deps.onBatteryPower,
    isPackaged: deps.isPackaged,
    logger: deps.logger,
  });
  const weather = createWeatherService({ fetch: deps.fetch ?? ((url, init) => fetch(url, init)) });

  return {
    load: clipboard.load,
    clipboard: {
      getState: clipboard.getState,
      configure: clipboard.configure,
      clear: clipboard.clear,
      remove: clipboard.remove,
      copy: clipboard.copy,
      setPresence: clipboard.setPresence,
    },
    machine,
    weather,
    dispose: () => clipboard.dispose(),
  };
}

export type HomeWidgetsService = ReturnType<typeof createHomeWidgetsService>;
