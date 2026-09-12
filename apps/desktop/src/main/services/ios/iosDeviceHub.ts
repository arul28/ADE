import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IosScreenSnapshot,
  IosSimulatorAppState,
  IosSimulatorAppLifecycleArgs,
  IosSimulatorAssertVisibleArgs,
  IosSimulatorCloseDeviceArgs,
  IosSimulatorCloseDeviceResult,
  IosSimulatorDevice,
  IosSimulatorDeviceArgs,
  IosSimulatorDeviceSession,
  IosSimulatorDeviceSettings,
  IosSimulatorElementActionResult,
  IosSimulatorElementMatch,
  IosSimulatorEventLogArgs,
  IosSimulatorEventLogPage,
  IosSimulatorEventPayload,
  IosSimulatorFillElementArgs,
  IosSimulatorFindElementArgs,
  IosSimulatorOpenDeviceArgs,
  IosSimulatorOpenUrlArgs,
  IosSimulatorProofBundle,
  IosSimulatorProofBundleArgs,
  IosSimulatorPushArgs,
  IosSimulatorScreenshot,
  IosSimulatorSetAccessibilityArgs,
  IosSimulatorSetAppearanceArgs,
  IosSimulatorSetContentSizeArgs,
  IosSimulatorSetLocationArgs,
  IosSimulatorSetPermissionArgs,
  IosSimulatorStartEventLogArgs,
  IosSimulatorStopEventLogArgs,
  IosSimulatorStatusBarArgs,
  IosSimulatorTapElementArgs,
  IosSimulatorUninstallAppArgs,
  IosSimulatorWaitForElementArgs,
} from "../../../shared/types/iosSimulator";
import { IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE, IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE } from "../../../shared/types/iosSimulator";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";
import { createIosDeviceTools, type IosDeviceToolsRunCommand } from "./iosDeviceTools";
import { createIosEventLog, type IosEventLogProcess } from "./iosEventLog";
import {
  buildElementRef,
  describeElement,
  describeQuery,
  elementTapPoint,
  matchElements,
} from "./iosSemanticActions";

/**
 * The device half of the iOS simulator surface.
 *
 * The service next door owns an APP session: a bundle id, a build root and a
 * lane. That is the right unit for "build this lane and run it", and the wrong
 * unit for everything else a human does with a simulator — open one, look at
 * what already runs there, switch it to dark mode, deny it the camera, read its
 * log. This hub owns that half, so the two never have to pretend to be one
 * thing.
 *
 * It holds no subprocess helpers of its own. Every process concern arrives
 * through `deps`, which is what lets the host service keep one companion, one
 * control queue, and one lane-safe build root.
 */

export class IosDeviceOwnedByOtherSessionError extends Error {
  readonly code = IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE;

  constructor(readonly ownerChatSessionId: string | null) {
    super(ownerChatSessionId
      ? `This simulator is open in another chat (${ownerChatSessionId}). Take it over to use it here.`
      : "This simulator is open in another chat. Take it over to use it here.");
    this.name = "IosDeviceOwnedByOtherSessionError";
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const WAIT_POLL_INTERVAL_MS = 350;
const PROOF_LOG_ROW_DEFAULT = 50;

export type IosDeviceHubDeps = {
  run: IosDeviceToolsRunCommand;
  /** Spawns `log stream` on a device. Injected so tests never fork a process. */
  spawnLogStream: (deviceUdid: string, predicate: string | null) => IosEventLogProcess;
  /** Opens Simulator.app in the background. */
  openSimulatorApp: () => void;
  resolveDevice: (deviceUdid?: string | null) => Promise<IosSimulatorDevice>;
  resolveControlDeviceUdid: (deviceUdid?: string | null) => Promise<string>;
  getScreenSnapshot: (args: { deviceUdid?: string | null; projectRoot?: string | null; laneId?: string | null }) => Promise<IosScreenSnapshot>;
  screenshot: (args: { deviceUdid?: string | null; projectRoot?: string | null; laneId?: string | null; outPath?: string | null }) => Promise<IosSimulatorScreenshot>;
  tap: (args: { deviceUdid?: string | null; x: number; y: number }) => Promise<unknown>;
  typeText: (args: { deviceUdid?: string | null; text: string }) => Promise<unknown>;
  resolveBuildRoot: (args: { projectRoot?: string | null; laneId?: string | null }) => Promise<string>;
  /**
   * The chat holding the APP session, when there is one.
   *
   * The hub owns the device half and cannot see the app half, but a guard that
   * only knows about device sessions protects nothing in the common case: a
   * chat that ran `launch` holds an app session and usually no device session
   * at all.
   */
  getAppSessionOwner: () => string | null;
  /**
   * The device the APP session runs on, when there is one.
   *
   * The two sessions can name the same simulator and belong to different
   * chats, so releasing the device half has to know whether shutting the
   * simulator down would take another chat's app session with it.
   */
  getAppSessionDeviceUdid: () => string | null;
  emit: (payload: IosSimulatorEventPayload) => void;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
  };
  now?: () => Date;
  /** Filesystem seam for the proof bundle. Defaults to `node:fs`. */
  fileSystem?: {
    mkdir: (dir: string) => Promise<void>;
    writeFile: (filePath: string, contents: string) => Promise<void>;
  };
};

export function createIosDeviceHub(deps: IosDeviceHubDeps) {
  const now = deps.now ?? (() => new Date());
  const nowIso = () => now().toISOString();

  const tools = createIosDeviceTools({
    run: deps.run,
    writeTempFile: async (contents, extension) => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-ios-push-"));
      const filePath = path.join(dir, `payload${extension}`);
      await fs.promises.writeFile(filePath, contents, "utf8");
      return filePath;
    },
    removeFile: async (filePath) => {
      await fs.promises.rm(path.dirname(filePath), { recursive: true, force: true });
    },
    now,
  });

  const eventLog = createIosEventLog({
    spawnLogStream: deps.spawnLogStream,
    now,
    logger: deps.logger,
  });

  const fileSystem = deps.fileSystem ?? {
    mkdir: async (dir: string) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
    writeFile: async (filePath: string, contents: string) => {
      await fs.promises.writeFile(filePath, contents, "utf8");
    },
  };

  let deviceSession: IosSimulatorDeviceSession | null = null;
  /**
   * The chat that started the running event log.
   *
   * Owning "a stake in the simulator" is not enough to own the log. The device
   * session and the app session can belong to DIFFERENT chats, and there is
   * one log process per host, so a guard that accepted either owner let each
   * of them stop the other's log. The chat that started it keeps it.
   */
  let eventLogOwner: string | null = null;
  /**
   * Serializes the device-session transitions.
   *
   * `openDevice` checks ownership, then awaits a resolve and a boot before it
   * assigns the session. Two overlapping calls both pass the check while the
   * session is null, both boot a simulator, and the second assignment drops
   * the first one with no release, which leaves a booted simulator that no
   * `closeDevice` can reach. The queue makes the check, the boot, the release
   * and the assignment one step.
   */
  let deviceSessionQueue: Promise<unknown> = Promise.resolve();
  const serializeDeviceSession = <T,>(step: () => Promise<T>): Promise<T> => {
    const next = deviceSessionQueue.then(step, step);
    // The queue must survive a rejected step, so the chain keeps only the
    // settled signal and the caller keeps the error.
    deviceSessionQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  /** `simctl location` is write-only, so ADE keeps its own record per device. */
  const lastLocationByDevice = new Map<string, { latitude: number; longitude: number }>();
  const statusBarOverridden = new Set<string>();

  const assertDeviceOwner = (chatSessionId: string | null | undefined, force: boolean | null | undefined) => {
    if (force === true) return;
    const owner = deviceSession?.chatSessionId ?? null;
    if (!owner) return;
    if ((chatSessionId ?? null) === owner) return;
    throw new IosDeviceOwnedByOtherSessionError(owner);
  };

  /**
   * Refuses a caller that did not start the running event log.
   *
   * Runs after `assertSimulatorOwner`, which answers "may this chat touch the
   * simulator at all". This one answers the narrower question the shared log
   * process actually poses: two chats can each hold a stake — one opened the
   * device, the other launched the app — and only one of them started the log.
   * A log nobody started is free to take.
   */
  const assertEventLogOwner = (
    chatSessionId: string | null | undefined,
    force: boolean | null | undefined,
  ) => {
    if (force === true) return;
    if (!eventLog.isRunning() || eventLogOwner === null) return;
    if ((chatSessionId ?? null) === eventLogOwner) return;
    throw new IosDeviceOwnedByOtherSessionError(eventLogOwner);
  };

  /**
   * Refuses a caller that owns neither half of the simulator.
   *
   * Used only by the operations a chat cannot undo. Either claim counts: the
   * chat that opened the device and the chat that launched the app both have a
   * stake in the app staying installed.
   */
  const assertSimulatorOwner = (chatSessionId: string | null | undefined, force: boolean | null | undefined) => {
    if (force === true) return;
    const caller = chatSessionId ?? null;
    const owners = [deviceSession?.chatSessionId ?? null, deps.getAppSessionOwner()]
      .filter((owner): owner is string => Boolean(owner));
    if (owners.length === 0) return;
    if (caller && owners.includes(caller)) return;
    // The app-session owner is the chat whose data this deletes, so it is named
    // first when both halves are claimed.
    const appOwner = deps.getAppSessionOwner();
    throw new IosDeviceOwnedByOtherSessionError(appOwner ?? owners[0] ?? null);
  };

  /**
   * Adds an `ade` row to the log and returns the value the caller produced.
   *
   * The log is what makes a device hub reviewable: a human reading it must see
   * that the dark-mode switch happened between two app log lines, not have to
   * infer it.
   */
  const recordAction = (message: string, command: string | null) => {
    eventLog.record({ message, command, level: "action" });
  };

  const readSettings = async (deviceUdid?: string | null): Promise<IosSimulatorDeviceSettings> => {
    const udid = await deps.resolveControlDeviceUdid(deviceUdid);
    const settings = await tools.readSettings(udid);
    return {
      ...settings,
      location: lastLocationByDevice.get(udid) ?? null,
      statusBarOverridden: statusBarOverridden.has(udid),
    };
  };

  const announceSettings = async (deviceUdid: string) => {
    const settings = await readSettings(deviceUdid).catch(() => null);
    if (settings) deps.emit({ type: "device-settings-changed", settings });
  };

  const findMatch = async (
    args: IosSimulatorFindElementArgs,
  ): Promise<{ match: IosSimulatorElementMatch | null; reason: string | null; snapshot: IosScreenSnapshot }> => {
    const snapshot = await deps.getScreenSnapshot({
      deviceUdid: args.deviceUdid ?? null,
      projectRoot: args.projectRoot ?? null,
      laneId: args.laneId ?? null,
    });
    const outcome = matchElements(snapshot.elements, args.query);
    if (!outcome.selected) return { match: null, reason: outcome.reason, snapshot };
    return {
      match: {
        ref: buildElementRef(outcome.selected),
        element: outcome.selected,
        matchCount: outcome.matches.length,
      },
      reason: null,
      snapshot,
    };
  };

  /**
   * True when a chat other than `chatSessionId` runs an app on this device.
   *
   * Shutting such a device down hands that chat a dead simulator and a session
   * that still says it is running, so every release path asks this before it
   * shuts anything down.
   */
  const appSessionHeldByAnotherChat = (
    deviceUdid: string,
    chatSessionId: string | null,
  ): boolean => {
    const appOwner = deps.getAppSessionOwner();
    return appOwner !== null
      && appOwner !== chatSessionId
      && deps.getAppSessionDeviceUdid() === deviceUdid;
  };

  /**
   * Lets go of a tracked session: shuts the simulator down when asked, stops a
   * log stream that was following it, and announces the release.
   *
   * Shared by `closeDevice`, by `openDevice` taking over a different device,
   * and by `releaseDeviceIfOwnedBy`, so every release lets go of the same
   * things.
   */
  const releaseTrackedDevice = async (
    previous: IosSimulatorDeviceSession,
    shouldShutdown: boolean,
    /**
     * The chat doing the releasing, and whether it is overriding.
     *
     * `releasedBy` is required, not defaulted: the plausible default is the
     * session's own owner, which is the chat being released rather than the
     * one releasing it, and that reading makes the guard below weaker instead
     * of stronger. A new release path has to say who is releasing.
     */
    by: { releasedBy: string | null; force: boolean },
  ): Promise<boolean> => {
    let shutdown = false;
    // Asked here rather than at each call site: `openDevice`, `closeDevice`
    // and `releaseDeviceIfOwnedBy` all shut devices down, and a guard on one
    // of them protects nothing on the other two.
    //
    // `force` passes through because this is the only place in ADE that runs
    // `simctl shutdown`. An absolute guard would leave a simulator no ADE
    // command could shut down, and `close-device --force` already tells the
    // user it closes one anyway.
    if (
      shouldShutdown
      && !by.force
      && appSessionHeldByAnotherChat(previous.deviceUdid, by.releasedBy)
    ) {
      deps.logger.info("ios_simulator.device_shutdown_skipped_app_session", {
        deviceUdid: previous.deviceUdid,
      });
      shouldShutdown = false;
    }
    if (shouldShutdown) {
      await deps.run("xcrun", ["simctl", "shutdown", previous.deviceUdid], { timeoutMs: 60_000 })
        .then(() => {
          shutdown = true;
        })
        .catch((error: unknown) => {
          deps.logger.debug("ios_simulator.device_shutdown_failed", {
            deviceUdid: previous.deviceUdid,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (eventLog.activeDeviceUdid() === previous.deviceUdid) {
      eventLog.stop();
      eventLogOwner = null;
    }
    deps.emit({ type: "device-session-released", previousDeviceSession: previous });
    return shutdown;
  };

  return {
    /* ----------------------------------------------------------------- *
     * Device sessions
     * ----------------------------------------------------------------- */

    getDeviceSession(): IosSimulatorDeviceSession | null {
      return deviceSession;
    },

    /**
     * Boots a simulator and claims it, with no build and no app.
     *
     * A device that was already booted is adopted rather than re-booted, and
     * `bootedByAde` records the difference, so closing the session never shuts
     * down a simulator the user started for something else.
     */
    openDevice(args: IosSimulatorOpenDeviceArgs = {}): Promise<IosSimulatorDeviceSession> {
      return serializeDeviceSession(async () => {
        assertDeviceOwner(args.chatSessionId, args.force);
        const device = await deps.resolveDevice(args.deviceUdid ?? null);
        const alreadyBooted = device.state === "Booted";
        if (!alreadyBooted) {
          await deps.run("xcrun", ["simctl", "boot", device.udid], { timeoutMs: 120_000 });
          await deps.run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeoutMs: 120_000 })
            .catch(() => undefined);
        }
        if (args.openWindow !== false) deps.openSimulatorApp();
        const previous = deviceSession;
        const isSameDevice = previous?.deviceUdid === device.udid;
        // Re-opening the same device keeps the original answer to "did ADE boot
        // this?". The device is booted by the second call, so reading the state
        // alone would record `false` and leave `closeDevice` with no reason to
        // shut down a simulator ADE started.
        const bootedByAde = (isSameDevice && previous?.bootedByAde === true) || !alreadyBooted;
        if (previous && !isSameDevice) {
          // Opening another device ends the session on this one, so it is
          // released here rather than left untracked. ADE shuts it down when ADE
          // booted it, which is what `closeDevice` would have done; a simulator
          // the user started stays running.
          await releaseTrackedDevice(previous, previous.bootedByAde, {
            releasedBy: args.chatSessionId ?? null,
            // Opening another device is not a request to shut this one down,
            // so `force` here would only mean "take a device another chat is
            // using and kill its app too". It never does.
            force: false,
          });
        }
        deviceSession = {
          deviceUdid: device.udid,
          deviceName: device.name,
          chatSessionId: args.chatSessionId ?? null,
          laneId: args.laneId ?? null,
          openedAt: nowIso(),
          bootedByAde,
        };
        deps.logger.info("ios_simulator.device_session_started", {
          deviceUdid: device.udid,
          bootedByAde,
      });
      recordAction(
        `Opened ${device.name}.`,
        `ade ios-sim open-device --device ${device.udid}`,
      );
      deps.emit({ type: "device-session-started", deviceSession });
      return deviceSession;
      });
    },

    /**
     * Releases the tracked device session.
     *
     * A named device that is not the tracked one is answered with a no-op
     * rather than an error. The CLI forwards `--device`, so closing the session
     * on the device the caller actually named is the only safe reading of
     * `close-device --device <udid>`, and "close a device that is not open" is
     * not a failure worth throwing over.
     */
    closeDevice(args: IosSimulatorCloseDeviceArgs = {}): Promise<IosSimulatorCloseDeviceResult> {
      return serializeDeviceSession(async () => {
        if (!deviceSession) {
          return { released: false, shutdown: false, previousDeviceSession: null };
        }
        const requested = args.deviceUdid?.trim() || null;
        if (requested && requested !== deviceSession.deviceUdid) {
          return { released: false, shutdown: false, previousDeviceSession: null };
        }
        if (args.ignoreOwnership !== true) {
          assertDeviceOwner(args.chatSessionId, args.force);
        }
        const previous = deviceSession;
        deviceSession = null;
        const shutdown = await releaseTrackedDevice(
          previous,
          args.shutdownDevice ?? previous.bootedByAde,
          {
            releasedBy: args.chatSessionId ?? null,
            // `force` only, not `ignoreOwnership`. They are different claims:
            // `--force` says "take this from another chat", while
            // `--ignore-ownership` says only "step around the device-session
            // guard in my own name" — the lane-scoped drawer's intent. Letting
            // the softer one through here would shut down a simulator another
            // chat is running an app on, which is what it never asked for.
            force: args.force === true,
          },
        );
        return { released: true, shutdown, previousDeviceSession: previous };
      });
    },

    /**
     * Drops the device session a chat owns when that chat goes away.
     *
     * The owner check runs inside the queue, not before it. Read outside, a
     * chat that ended could release a session another chat opened in the gap
     * between the check and the release.
     */
    releaseDeviceIfOwnedBy(chatSessionId: string): Promise<IosSimulatorCloseDeviceResult> {
      return serializeDeviceSession(async () => {
        const previous = deviceSession;
        if (!previous || previous.chatSessionId !== chatSessionId) {
          return { released: false, shutdown: false, previousDeviceSession: null };
        }
        deviceSession = null;
        // Cleanup after a chat that went away. Nobody asked for this, so it
        // never overrides another chat's app session.
        const shutdown = await releaseTrackedDevice(previous, previous.bootedByAde, {
          releasedBy: chatSessionId,
          force: false,
        });
        return { released: true, shutdown, previousDeviceSession: previous };
      });
    },

    /* ----------------------------------------------------------------- *
     * Device tools
     * ----------------------------------------------------------------- */

    getDeviceSettings: async (args: IosSimulatorDeviceArgs = {}) => readSettings(args.deviceUdid),

    async setAppearance(args: IosSimulatorSetAppearanceArgs): Promise<IosSimulatorDeviceSettings> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setAppearance(udid, args.appearance);
      recordAction(
        `Set appearance to ${args.appearance}.`,
        `ade ios-sim appearance ${args.appearance} --device ${udid}`,
      );
      void announceSettings(udid);
      return readSettings(udid);
    },

    async setContentSize(args: IosSimulatorSetContentSizeArgs): Promise<IosSimulatorDeviceSettings> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setContentSize(udid, args.contentSize);
      recordAction(
        `Set text size to ${args.contentSize}.`,
        `ade ios-sim content-size ${args.contentSize} --device ${udid}`,
      );
      void announceSettings(udid);
      return readSettings(udid);
    },

    async setAccessibilityOption(args: IosSimulatorSetAccessibilityArgs): Promise<IosSimulatorDeviceSettings> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setAccessibilityOption(udid, args.option, args.enabled);
      recordAction(
        `${args.enabled ? "Enabled" : "Disabled"} ${args.option}.`,
        `ade ios-sim accessibility ${args.option} ${args.enabled ? "on" : "off"} --device ${udid}`,
      );
      void announceSettings(udid);
      return readSettings(udid);
    },

    async setLocation(args: IosSimulatorSetLocationArgs): Promise<IosSimulatorDeviceSettings> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setLocation(udid, { latitude: args.latitude, longitude: args.longitude });
      lastLocationByDevice.set(udid, { latitude: args.latitude, longitude: args.longitude });
      recordAction(
        `Set location to ${args.latitude}, ${args.longitude}.`,
        `ade ios-sim location ${args.latitude} ${args.longitude} --device ${udid}`,
      );
      void announceSettings(udid);
      return readSettings(udid);
    },

    async clearLocation(args: IosSimulatorDeviceArgs = {}): Promise<IosSimulatorDeviceSettings> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.clearLocation(udid);
      lastLocationByDevice.delete(udid);
      recordAction("Cleared the simulated location.", `ade ios-sim location --clear --device ${udid}`);
      void announceSettings(udid);
      return readSettings(udid);
    },

    async setPermission(args: IosSimulatorSetPermissionArgs): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setPermission({
        deviceUdid: udid,
        bundleId: args.bundleId ?? null,
        service: args.service,
        action: args.action,
      });
      // A `reset` takes the whole service back to its default and carries no
      // bundle id, so both the row and the command leave it out. Printing it
      // regardless gave a log row reading "for undefined" and a command nobody
      // could run.
      const bundleId = args.bundleId?.trim() || null;
      recordAction(
        bundleId
          ? `${args.action} ${args.service} for ${bundleId}.`
          : `${args.action} ${args.service}.`,
        `ade ios-sim permission ${args.action} ${args.service}`
          + (bundleId ? ` --bundle-id ${bundleId}` : "")
          + ` --device ${udid}`,
      );
      return { ok: true };
    },

    async sendPushNotification(args: IosSimulatorPushArgs): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.sendPush({ ...args, deviceUdid: udid });
      recordAction(
        `Sent a push notification to ${args.bundleId}.`,
        `ade ios-sim push --bundle-id ${args.bundleId} --device ${udid}`,
      );
      return { ok: true };
    },

    async openUrl(args: IosSimulatorOpenUrlArgs): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.openUrl(udid, args.url);
      recordAction(`Opened ${args.url}.`, `ade ios-sim open-url ${args.url} --device ${udid}`);
      return { ok: true };
    },

    /**
     * Restarts the app that is already installed.
     *
     * Distinct from `launch`, which builds the lane worktree first. A human
     * asking to relaunch wants to see the same binary from its first screen,
     * and paying for a rebuild to get there is the wrong price.
     */
    async relaunchApp(args: IosSimulatorAppLifecycleArgs): Promise<IosSimulatorAppState> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      // Validated before the terminate, because the catch below is deliberately
      // blind: an app that is not running must not fail a relaunch, and without
      // this an empty bundle id would be swallowed there and then handed to
      // `launch` anyway.
      if (!args.bundleId?.trim()) throw new Error("A relaunch needs a bundle id.");
      await tools.terminateApp(udid, args.bundleId).catch(() => {
        // Terminating an app that is not running is not a failure; the launch
        // below is what the caller actually asked for.
      });
      await tools.launchApp(udid, args.bundleId);
      recordAction(
        `Relaunched ${args.bundleId}.`,
        `ade ios-sim relaunch --bundle-id ${args.bundleId} --device ${udid}`,
      );
      return tools.getAppState(udid, args.bundleId);
    },

    async terminateApp(args: IosSimulatorAppLifecycleArgs): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.terminateApp(udid, args.bundleId);
      recordAction(
        `Terminated ${args.bundleId}.`,
        `ade ios-sim terminate --bundle-id ${args.bundleId} --device ${udid}`,
      );
      return { ok: true };
    },

    /**
     * Removes an app and its container.
     *
     * This is the only device tool that is guarded, and the only one a chat
     * cannot undo: an uninstall deletes the app's data, while every other tool
     * here sets a value the owner can see and set back. Input — `tap`, `type`,
     * `drag` — is deliberately unguarded for the same reason, because ADE's
     * lane-scoped surface drives whatever session its lane is running. Pass
     * `force` to take it anyway.
     */
    async uninstallApp(args: IosSimulatorUninstallAppArgs): Promise<{ ok: true }> {
      assertSimulatorOwner(args.chatSessionId, args.force);
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.uninstallApp(udid, args.bundleId);
      recordAction(
        `Uninstalled ${args.bundleId}.`,
        `ade ios-sim uninstall --bundle-id ${args.bundleId} --device ${udid}`,
      );
      return { ok: true };
    },

    async setStatusBar(args: IosSimulatorStatusBarArgs): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.setStatusBar({ ...args, deviceUdid: udid });
      statusBarOverridden.add(udid);
      recordAction("Set a status bar override.", `ade ios-sim status-bar --device ${udid}`);
      return { ok: true };
    },

    async clearStatusBar(args: IosSimulatorDeviceArgs = {}): Promise<{ ok: true }> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      await tools.clearStatusBar(udid);
      statusBarOverridden.delete(udid);
      recordAction("Cleared the status bar override.", `ade ios-sim status-bar --clear --device ${udid}`);
      return { ok: true };
    },

    async getAppState(args: IosSimulatorAppLifecycleArgs): Promise<IosSimulatorAppState> {
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      return tools.getAppState(udid, args.bundleId);
    },

    /* ----------------------------------------------------------------- *
     * Event log
     * ----------------------------------------------------------------- */

    /**
     * Follows one app's `os_log` output on one device.
     *
     * Both halves of the guard matter. The bundle id is required because
     * `log stream` reads the whole device, so an unscoped run hands the caller
     * every other app's rows and the system's. The ownership check is here and
     * not only in the drawer because there is one log process per host: a
     * second chat that could start or stop it would take the first chat's log
     * away, and a control disabled in one renderer stops nothing.
     *
     * It checks BOTH halves, like `uninstallApp`. The common shape is a chat
     * that ran `launch`: it holds an app session and no device session at all,
     * so a guard that only knew about device sessions would wave through every
     * caller in exactly the case the log is most used.
     */
    async startEventLog(args: IosSimulatorStartEventLogArgs): Promise<IosSimulatorEventLogPage> {
      assertSimulatorOwner(args.chatSessionId, args.force);
      assertEventLogOwner(args.chatSessionId, args.force);
      const bundleId = (args.bundleId ?? "").trim();
      if (bundleId.length === 0) {
        throw new Error(
          "Refusing to start the event log without a bundle id: `log stream` reads the whole device, so an unscoped run returns every other app's rows and the system's.",
        );
      }
      const udid = await deps.resolveControlDeviceUdid(args.deviceUdid);
      eventLog.start({ deviceUdid: udid, bundleId });
      eventLogOwner = args.chatSessionId ?? null;
      return eventLog.read({});
    },

    stopEventLog(args: IosSimulatorStopEventLogArgs = {}): IosSimulatorEventLogPage {
      assertSimulatorOwner(args.chatSessionId, args.force);
      assertEventLogOwner(args.chatSessionId, args.force);
      eventLog.stop();
      eventLogOwner = null;
      return eventLog.read({});
    },

    /**
     * Reads new rows.
     *
     * A caller that names a device it is not reading gets an empty page rather
     * than another device's rows. The log follows one device at a time, and a
     * drawer that switched devices would otherwise keep appending the old
     * device's lines under the new device's header with no way to tell.
     */
    async getEventLog(args: IosSimulatorEventLogArgs = {}): Promise<IosSimulatorEventLogPage> {
      const requested = args.deviceUdid?.trim();
      const following = eventLog.activeDeviceUdid();
      // Check before reading, not after. `read` resets the dropped-row counter,
      // so answering a mismatched caller from a page it already consumed would
      // eat a gap the legitimate reader is owed — and a silently truncated log
      // reads as a quiet one.
      if (requested && following && following !== requested) {
        return {
          deviceUdid: following,
          running: eventLog.isRunning(),
          rows: [],
          cursor: args.sinceId ?? 0,
          dropped: 0,
          lastError: null,
        };
      }
      return eventLog.read({ sinceId: args.sinceId ?? null, limit: args.limit ?? null });
    },

    recordAction,

    /* ----------------------------------------------------------------- *
     * Semantic actions
     * ----------------------------------------------------------------- */

    async findElement(args: IosSimulatorFindElementArgs): Promise<IosSimulatorElementActionResult> {
      const { match, reason } = await findMatch(args);
      return {
        ok: Boolean(match),
        action: "assert",
        match,
        matchCount: match?.matchCount ?? 0,
        message: match ? describeElement(match.element) : reason,
        waitedMs: null,
      };
    },

    async tapElement(args: IosSimulatorTapElementArgs): Promise<IosSimulatorElementActionResult> {
      const { match, reason } = await findMatch(args);
      if (!match) {
        return { ok: false, action: "tap", match: null, matchCount: 0, message: reason, waitedMs: null };
      }
      const point = elementTapPoint(match.element);
      if (!point) {
        return {
          ok: false,
          action: "tap",
          match,
          matchCount: match.matchCount,
          message: `${describeElement(match.element)} has no usable frame to tap.`,
          waitedMs: null,
        };
      }
      await deps.tap({ deviceUdid: args.deviceUdid ?? null, x: point.x, y: point.y });
      recordAction(
        `Tapped ${describeElement(match.element)}.`,
        `ade ios-sim tap-element ${describeQuery(args.query)}`,
      );
      return {
        ok: true,
        action: "tap",
        match,
        matchCount: match.matchCount,
        message: null,
        waitedMs: null,
      };
    },

    async fillElement(args: IosSimulatorFillElementArgs): Promise<IosSimulatorElementActionResult> {
      const { match, reason } = await findMatch(args);
      if (!match) {
        return { ok: false, action: "fill", match: null, matchCount: 0, message: reason, waitedMs: null };
      }
      if (args.focusFirst !== false) {
        const point = elementTapPoint(match.element);
        if (!point) {
          return {
            ok: false,
            action: "fill",
            match,
            matchCount: match.matchCount,
            message: `${describeElement(match.element)} has no usable frame to focus.`,
            waitedMs: null,
          };
        }
        await deps.tap({ deviceUdid: args.deviceUdid ?? null, x: point.x, y: point.y });
      }
      await deps.typeText({ deviceUdid: args.deviceUdid ?? null, text: args.text });
      recordAction(
        `Typed into ${describeElement(match.element)}.`,
        `ade ios-sim fill-element ${describeQuery(args.query)}`,
      );
      return {
        ok: true,
        action: "fill",
        match,
        matchCount: match.matchCount,
        message: null,
        waitedMs: null,
      };
    },

    /**
     * Polls until the element appears or disappears.
     *
     * Every poll is a fresh snapshot, which is the point: an agent that sleeps a
     * fixed number of milliseconds is asserting a timing it cannot know.
     */
    async waitForElement(args: IosSimulatorWaitForElementArgs): Promise<IosSimulatorElementActionResult> {
      const wantGone = args.state === "gone";
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(0, Math.round(Number(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))),
      );
      const startedAtMs = now().getTime();
      let lastReason: string | null = null;
      for (;;) {
        const { match, reason } = await findMatch(args);
        lastReason = reason;
        const satisfied = wantGone ? !match : Boolean(match);
        const waitedMs = now().getTime() - startedAtMs;
        if (satisfied) {
          return {
            ok: true,
            action: "wait",
            match: wantGone ? null : match,
            matchCount: match?.matchCount ?? 0,
            message: null,
            waitedMs,
          };
        }
        if (waitedMs >= timeoutMs) {
          return {
            ok: false,
            action: "wait",
            match: wantGone ? match : null,
            matchCount: match?.matchCount ?? 0,
            message: wantGone
              ? `${describeQuery(args.query)} is still on screen after ${timeoutMs}ms.`
              : lastReason ?? `${describeQuery(args.query)} did not appear within ${timeoutMs}ms.`,
            waitedMs,
          };
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, WAIT_POLL_INTERVAL_MS);
          timer.unref?.();
        });
      }
    },

    async assertVisible(args: IosSimulatorAssertVisibleArgs): Promise<IosSimulatorElementActionResult> {
      const { match, reason } = await findMatch(args);
      return {
        ok: Boolean(match),
        action: "assert",
        match,
        matchCount: match?.matchCount ?? 0,
        message: match ? null : reason,
        waitedMs: null,
      };
    },

    /* ----------------------------------------------------------------- *
     * Proof
     * ----------------------------------------------------------------- */

    /**
     * Writes a screenshot plus everything a reviewer needs to believe it.
     *
     * A bare PNG does not say which machine, which simulator, which build root,
     * or what the agent had just done. Those are the first four questions a
     * reviewer asks, so the bundle answers them next to the image.
     */
    async captureProofBundle(args: IosSimulatorProofBundleArgs = {}): Promise<IosSimulatorProofBundle> {
      const buildRoot = await deps.resolveBuildRoot({
        projectRoot: args.projectRoot ?? null,
        laneId: args.laneId ?? null,
      });
      const stamp = nowIso().replace(/[:.]/g, "-");
      const requested = args.outDir?.trim();
      const dir = requested
        ? path.resolve(buildRoot, requested)
        : path.resolve(buildRoot, ".ade", "proof", `ios-sim-${stamp}`);
      // `outDir` reaches here from an agent's tool call and from `ade ios-sim
      // proof-bundle --out`, exactly as `screenshot --out` does, so it gets the
      // same containment rule: an absolute path or a `../..` tail would
      // otherwise let a capture write anywhere the ADE process can. Containment
      // is checked after resolution so both spellings fail the same way.
      // Two checks, because the lexical one cannot see a symlink: a link inside
      // the build root resolves outside it and the write lands wherever the
      // link points. `resolvePathWithinRoot` resolves both sides against the
      // real filesystem, which also keeps a lane worktree reached through a
      // symlink working — the normal case on macOS, where `/tmp` is a link.
      if (!isPathInside(dir, buildRoot)) {
        throw new Error(`${IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE}: ${dir} is outside the build root ${buildRoot}.`);
      }
      // Only when the root is on disk. `resolvePathWithinRoot` reads the real
      // filesystem, and a root that does not exist cannot hold a symlink to
      // escape through — so refusing there would reject a caller for the
      // shape of its own build root rather than for where it writes.
      if (await fs.promises.stat(buildRoot).then(() => true).catch(() => false)) {
        try {
          resolvePathWithinRoot(buildRoot, dir, { allowMissing: true });
        } catch (error) {
          // Same rule as `screenshot --out`: only a containment failure is
          // reported as one. A dangling link or a permission error keeps its
          // own message, which is the one the caller can act on.
          if (!isPathEscapeError(error)) throw error;
          throw new Error(`${IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE}: ${dir} is outside the build root ${buildRoot}.`);
        }
      }
      await fileSystem.mkdir(dir);

      const screenshotPath = path.join(dir, "screen.png");
      const shot = await deps.screenshot({
        deviceUdid: args.deviceUdid ?? null,
        projectRoot: args.projectRoot ?? null,
        laneId: args.laneId ?? null,
        outPath: screenshotPath,
      });

      let elementsPath: string | null = null;
      let snapshot: IosScreenSnapshot | null = null;
      if (args.includeElements !== false) {
        snapshot = await deps.getScreenSnapshot({
          deviceUdid: args.deviceUdid ?? null,
          projectRoot: args.projectRoot ?? null,
          laneId: args.laneId ?? null,
        }).catch(() => null);
        if (snapshot) {
          elementsPath = path.join(dir, "elements.json");
          await fileSystem.writeFile(elementsPath, JSON.stringify({
            screen: snapshot.screen,
            providers: snapshot.providers,
            elements: snapshot.elements.map((element) => ({
              ref: buildElementRef(element),
              ...element,
            })),
          }, null, 2));
        }
      }

      const limit = Math.max(0, Math.min(1000, Math.round(Number(args.logRowLimit ?? PROOF_LOG_ROW_DEFAULT))));
      let logPath: string | null = null;
      // The log follows one device, and a proof can name another. Rows from a
      // device the screenshot did not come from are not evidence for it, so a
      // mismatch drops the file and says so in the metadata rather than
      // pairing one device's screen with another's log. A log that follows no
      // device holds only ADE's own action rows, which belong to the proof
      // whichever device it captured.
      const logDeviceUdid = eventLog.activeDeviceUdid();
      const logFromAnotherDevice = logDeviceUdid !== null && logDeviceUdid !== shot.deviceUdid;
      if (limit > 0 && !logFromAnotherDevice) {
        // The drawer is the reader that shows the gap, so a proof capture takes
        // the rows without consuming the counter on its way past.
        const logRows = eventLog.snapshotRows(limit);
        if (logRows.length) {
          logPath = path.join(dir, "log.json");
          await fileSystem.writeFile(logPath, JSON.stringify(logRows, null, 2));
        }
      }

      const metadataPath = path.join(dir, "metadata.json");
      await fileSystem.writeFile(metadataPath, JSON.stringify({
        capturedAt: shot.capturedAt,
        caption: args.caption ?? null,
        deviceUdid: shot.deviceUdid,
        deviceName: deviceSession?.deviceName ?? null,
        logDeviceUdid,
        logOmittedReason: limit > 0 && logFromAnotherDevice
          ? `The event log follows ${logDeviceUdid}, not the device this proof captured.`
          : null,
        deviceSession,
        buildRoot,
        laneId: args.laneId ?? null,
        screen: snapshot?.screen ?? null,
        platform: process.platform,
        hostname: os.hostname(),
      }, null, 2));

      recordAction("Captured a proof bundle.", `ade ios-sim proof-bundle --out ${dir}`);
      return {
        dir,
        screenshotPath: shot.filePath,
        metadataPath,
        elementsPath,
        logPath,
        caption: args.caption ?? null,
        capturedAt: shot.capturedAt,
      };
    },

    dispose(): void {
      eventLog.dispose();
      deviceSession = null;
      lastLocationByDevice.clear();
      statusBarOverridden.clear();
    },
  };
}

export type IosDeviceHub = ReturnType<typeof createIosDeviceHub>;
