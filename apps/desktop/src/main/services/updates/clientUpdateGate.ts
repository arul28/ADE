import fs from "node:fs";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import {
  desktopUpdateRequirement,
  CLIENT_MINIMUM_FRESH_MS,
  type ClientUpdateGateState,
} from "../../../shared/clientUpdateGate";
import { createClientMinimumReader, fetchClientMinimumBody, type ClientMinimumReader } from "../../../shared/clientMinimumReader";
import { CLIENT_MINIMUM_LINKS } from "../../../../../account-directory/src/clientMinimumContract";
import { setSentryUpdateGateResolver } from "../../../shared/sentry/eventFilter";
import { compareUpdateVersions, isWindowsSelfInstallBlocked } from "../../../shared/updateVersions";
import { updateTrackOfVersion } from "../../../shared/updateTrack";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import { BRAND } from "../../../shared/brand";

/**
 * This computer's build against the owner's minimum (`GET /client/minimum`).
 *
 * Read in main only, at launch, then every 3 hours, and when an ADE window
 * gains focus after more than 30 minutes without a read. No other timer: the
 * window gets the answer with one IPC read and a change event. The one timer
 * comes due sooner only while this build is blocked, at the moment its last
 * answer goes stale, so an offline computer is let through on time.
 *
 * The rule is `desktopUpdateRequirement`; a stale or failed read never blocks.
 * While blocked, this build drops its own Sentry errors, logs and traces.
 */

export const CLIENT_MINIMUM_READ_INTERVAL_MS = 3 * 60 * 60_000;
export const CLIENT_MINIMUM_FOCUS_REREAD_MS = 30 * 60_000;

type GateLogger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
};

type AutoUpdateSource = {
  getSnapshot(): AutoUpdateSnapshot;
  onStateChange(listener: (snapshot: AutoUpdateSnapshot) => void): (() => void) | void;
};

/** The newest build per track: both feeds, plus this computer's own feed for its track. */
export function latestFromAutoUpdate(snapshot: AutoUpdateSnapshot | null | undefined): ClientUpdateGateState["latest"] {
  const latest = {
    stable: snapshot?.latestByTrack?.stable ?? null,
    beta: snapshot?.latestByTrack?.beta ?? null,
  };
  for (const version of [snapshot?.latestKnownVersion, snapshot?.version]) {
    const trimmed = version?.trim();
    if (!trimmed || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) continue;
    const track = updateTrackOfVersion(trimmed);
    const known = latest[track];
    if (!known || compareUpdateVersions(trimmed, known) > 0) latest[track] = trimmed;
  }
  return latest;
}

/** `brew upgrade --cask ade` when the cask is installed (macOS only). */
function homebrewUpgradeCommand(platform: NodeJS.Platform): string | null {
  if (platform !== "darwin") return null;
  for (const caskroom of ["/opt/homebrew/Caskroom/ade", "/usr/local/Caskroom/ade"]) {
    try {
      if (fs.existsSync(caskroom)) return "brew upgrade --cask ade";
    } catch {
      // Unreadable: no command, the download link still shows.
    }
  }
  return null;
}

export type ClientUpdateGateService = {
  getState(): ClientUpdateGateState;
  /** Reads again now (the gate's Retry). */
  refresh(): Promise<ClientUpdateGateState>;
  /** An ADE window gained focus. */
  noteWindowFocus(): void;
  onChange(listener: (state: ClientUpdateGateState) => void): () => void;
  dispose(): void;
};

export function createClientUpdateGateService(args: {
  /** This build's version; null for a build with no minimum (dev, Alpha and other channel builds). */
  currentVersion: string | null;
  /** False when this install cannot update itself (a Linux package, no update feed). */
  canSelfUpdate: boolean;
  platform: NodeJS.Platform;
  arch: string;
  autoUpdate: AutoUpdateSource;
  /** The account server's base URL; throws or returns "" when none is configured. */
  directoryBaseUrl: () => string;
  logger: GateLogger;
  reader?: ClientMinimumReader;
  nowMs?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}): ClientUpdateGateService {
  const nowMs = args.nowMs ?? (() => Date.now());
  const setTimer = args.setTimer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  });
  const reader = args.reader ?? createClientMinimumReader({
    nowMs,
    fetchBody: async () => {
      let base = "";
      try {
        base = args.directoryBaseUrl();
      } catch {
        base = "";
      }
      return await fetchClientMinimumBody(base);
    },
    onReadFailed: (error) => {
      args.logger.warn("client_update.minimum_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const listeners = new Set<(state: ClientUpdateGateState) => void>();
  let packageManagerCommand: string | null | undefined;
  let state = compute();
  let stateKey = JSON.stringify(state);
  let timer: { cancel(): void } | null = null;
  let disposed = false;
  // Main's Sentry hooks read this at send time; renderer events and logs pass them too.
  setSentryUpdateGateResolver(() => ({ requirement: state.self, version: args.currentVersion }));

  function compute(): ClientUpdateGateState {
    const minimum = reader.current();
    const snapshot = args.autoUpdate.getSnapshot();
    const latest = latestFromAutoUpdate(snapshot);
    const self = desktopUpdateRequirement({ currentVersion: args.currentVersion, minimum, latest });
    const blockedInstaller = isWindowsSelfInstallBlocked(args.currentVersion, `${args.platform}-${args.arch}`);
    const install = !args.canSelfUpdate || snapshot.installMode === "manual" || blockedInstaller ? "download" : "updater";
    // Looked up once, and only for a blocked build: the gate is the one place it shows.
    if (self.required && packageManagerCommand === undefined) packageManagerCommand = homebrewUpgradeCommand(args.platform);
    return {
      self,
      minimum: minimum ? { desktop: minimum.desktop } : null,
      latest,
      downloadUrl: minimum?.links.download ?? CLIENT_MINIMUM_LINKS.download,
      install,
      packageManagerCommand: packageManagerCommand ?? null,
      answeredAt: reader.answeredAtMs(),
    };
  }

  function publish(): void {
    const next = compute();
    const key = JSON.stringify(next);
    if (key === stateKey) return;
    const wasRequired = state.self.required;
    state = next;
    stateKey = key;
    if (next.self.required && !wasRequired) {
      args.logger.warn("client_update.required", {
        currentVersion: next.self.currentVersion,
        minimumVersion: next.self.minimumVersion,
        targetVersion: next.self.targetVersion,
        install: next.install,
      });
    } else if (!next.self.required && wasRequired) {
      args.logger.info("client_update.cleared", { answeredAt: next.answeredAt });
    }
    for (const listener of listeners) listener(next);
  }

  /** The one timer: 3 hours, or sooner while blocked, when the answer goes stale. */
  function schedule(): void {
    timer?.cancel();
    if (disposed) return;
    let delay = CLIENT_MINIMUM_READ_INTERVAL_MS;
    const answeredAt = reader.answeredAtMs();
    if (state.self.required && answeredAt != null) {
      delay = Math.min(delay, Math.max(1_000, answeredAt + CLIENT_MINIMUM_FRESH_MS - nowMs() + 1_000));
    }
    timer = setTimer(() => void read(), delay);
  }

  async function read(): Promise<ClientUpdateGateState> {
    await reader.refresh();
    if (disposed) return state;
    publish();
    schedule();
    return state;
  }

  const offAutoUpdate = args.autoUpdate.onStateChange(() => {
    if (!disposed) publish();
  });

  // Dev, Alpha and channel builds have no minimum, but another machine is
  // still judged against it, so every build reads it.
  void read();

  return {
    getState: () => state,
    refresh: read,
    noteWindowFocus() {
      if (disposed) return;
      const attempted = reader.attemptedAtMs();
      if (attempted != null && nowMs() - attempted <= CLIENT_MINIMUM_FOCUS_REREAD_MS) {
        // No read, but a stale answer may have to open the gate now.
        publish();
        return;
      }
      void read();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      setSentryUpdateGateResolver(null);
      timer?.cancel();
      timer = null;
      listeners.clear();
      if (typeof offAutoUpdate === "function") offAutoUpdate();
    },
  };
}

/** The window's two calls and its change event. About this computer only: no pin. */
export function registerClientUpdateGateIpc(service: ClientUpdateGateService, logger: GateLogger): () => void {
  ipcMain.handle(IPC.clientUpdateGateGetState, (event) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.clientUpdateGateGetState)) {
      throw new Error(`Only the ${BRAND.NAME} window can read this.`);
    }
    return service.getState();
  });
  ipcMain.handle(IPC.clientUpdateGateRefresh, async (event) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.clientUpdateGateRefresh)) {
      throw new Error(`Only the ${BRAND.NAME} window can read this.`);
    }
    return await service.refresh();
  });
  // An ordinary quit: `before-quit` asks about running agents as always.
  ipcMain.handle(IPC.clientUpdateGateQuit, (event) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.clientUpdateGateQuit)) return false;
    app.quit();
    return true;
  });
  return service.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.clientUpdateGateEvent, state);
    }
  });
}
