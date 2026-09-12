import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
  IosSimulatorDeviceSettings,
  IosSimulatorLogRow,
  IosSimulatorPrivacyAction,
  IosSimulatorPrivacyService,
} from "../../../shared/types/iosSimulator";
import type { OpenProjectBinding } from "../../../shared/types";
import type { IosSimToolsColumnProps } from "./IosSimToolsColumn";

/** How often the tools column re-reads whether the app is running. */
const APP_STATE_POLL_MS = 4_000;
/** How often the event log pulls new rows while it is open and running. */
const EVENT_LOG_POLL_MS = 1_500;
/** Rows kept in the renderer. The service keeps its own, larger, ring. */
const EVENT_LOG_VIEW_ROWS = 400;

export type UseIosSimDeviceToolsArgs = {
  /** The device every `simctl` call below acts on. */
  activeDeviceUdid: string | null;
  /** The bundle id of the app in the active session, when there is one. */
  bundleId: string | null;
  /**
   * This chat, for the ownership check on the event log.
   *
   * The log is one process per host, so a chat that does not own the device
   * session must not start or stop it. The service rejects that call; this is
   * what lets it tell the two chats apart.
   */
  chatSessionId: string | null;
  /**
   * The lane-scoped surface drives a simulator it does not own on purpose, so
   * it passes the same bypass `shutdown` already takes. Without it the event
   * log would be the one control on that surface that refuses to run.
   */
  ignoreOwnership: boolean;
  /** True while the tools column is on screen. Nothing here runs otherwise. */
  visible: boolean;
  /**
   * Whether the tools should still own a device, as opposed to whether they
   * are on screen. Expanding the video hides the column without closing it, and
   * a log the user started must survive that — stopping it there killed the
   * host process and collapsing the video never brought it back. A device that
   * goes away is different: nothing is left to follow, so that still stops.
   */
  requested: boolean;
  /**
   * The machine that owns the simulator. Read through a ref because a local pin
   * object is rebuilt on every cross-machine merge, and a dependency on its
   * identity would restart the polls on that timer.
   *
   * The moved effects below list it because `exhaustive-deps` demands a ref it
   * did not see declared here. A ref object never changes identity, so the
   * arrays behave exactly as they did in the component.
   */
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /**
   * Where a failure surfaces, and where success clears it. Must be stable: the
   * effects below list it, so a fresh identity each render would re-arm them.
   */
  onError: (message: string | null) => void;
};

/**
 * Everything the tools column needs, minus what only the panel knows.
 *
 * `busy` and `disabled` stay with the panel because they describe the launch
 * and the ownership it owns, not the device this hook drives. A relaunch is
 * neither: it restarts the installed binary, so it belongs here with the other
 * device tools.
 */
export type IosSimDeviceTools = Omit<
  IosSimToolsColumnProps,
  "busy" | "disabled" | "className"
>;

/**
 * Owns the device half of the iOS simulator drawer: settings, app lifecycle,
 * and the event log.
 *
 * Each handler runs one `simctl` call on the machine that owns the simulator,
 * then takes the settings from the result rather than assuming the write
 * landed. A failure reaches `onError` instead of leaving a control lying about
 * the device.
 *
 * This lives outside the panel because none of it touches the live view, the
 * launch, the inspector, or the preview — the four things the panel is
 * actually about. Sharing a 4,000-line component with them made the device
 * state impossible to read in one sitting, which is how the log process came
 * to leak on unmount.
 */
export function useIosSimDeviceTools({
  activeDeviceUdid,
  bundleId,
  chatSessionId,
  ignoreOwnership,
  visible,
  requested,
  runtimePinRef,
  onError,
}: UseIosSimDeviceToolsArgs): IosSimDeviceTools {
  const [deviceSettings, setDeviceSettings] = useState<IosSimulatorDeviceSettings | null>(null);
  const [logRows, setLogRows] = useState<IosSimulatorLogRow[]>([]);
  const [logRunning, setLogRunning] = useState(false);
  /**
   * The cursor has one reader: the poll below. Holding it in state as well
   * re-rendered the whole drawer every poll to keep a ref in sync with itself.
   */
  const logCursorRef = useRef(0);
  /** Rows the service dropped from the head of its ring since the log started. */
  const [logDropped, setLogDropped] = useState(0);
  /** What the log stream last reported about itself. */
  const [logError, setLogError] = useState<string | null>(null);
  /**
   * Mirrors `logRunning` for the unmount effect below, which cannot read state
   * without listing it and ceasing to be a mount/unmount effect.
   */
  const logRunningRef = useRef(false);
  logRunningRef.current = logRunning;
  /**
   * The owning chat, for the two teardown effects below.
   *
   * They stop the log when the column closes and when the panel unmounts, and
   * neither may re-arm on a new identity: listing `chatSessionId` would make
   * the unmount cleanup fire on a chat switch and stop a log nobody asked to
   * stop.
   */
  const chatSessionIdRef = useRef(chatSessionId);
  chatSessionIdRef.current = chatSessionId;
  const logOwnerArgs = useMemo(
    () => ({ chatSessionId, ...(ignoreOwnership ? { force: true } : {}) }),
    [chatSessionId, ignoreOwnership],
  );
  const logOwnerArgsRef = useRef(logOwnerArgs);
  logOwnerArgsRef.current = logOwnerArgs;
  /**
   * The device the host's log process currently follows.
   *
   * `startEventLog` binds the process to one device, so this is the only way to
   * tell that the drawer has moved on to another one.
   */
  const logDeviceRef = useRef<string | null>(null);
  const [appRunning, setAppRunning] = useState<boolean | null>(null);

  /**
   * Runs one device call and reports its failure in the footer.
   *
   * `apply` is what the caller does with the result, supplied statically so the
   * type of that result stays exact. That is what an earlier shape got wrong:
   * it took a union and picked a branch at runtime with an `in` check, which
   * hid from every reader which calls report the device back and which do not.
   */
  const runTool = useCallback(async <T,>(
    label: string,
    action: () => Promise<T>,
    apply?: (result: T) => void,
  ): Promise<void> => {
    try {
      const result = await action();
      apply?.(result);
      onError(null);
    } catch (error) {
      onError(`${label} failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onError]);

  /** A call whose result is the device's new state. */
  const runSettingsTool = useCallback((
    label: string,
    action: () => Promise<IosSimulatorDeviceSettings>,
  ): Promise<void> => runTool(label, action, setDeviceSettings), [runTool]);

  /** A call that changes the device without reporting its state back. */
  const runDeviceCommand = useCallback((
    label: string,
    action: () => Promise<{ ok: true }>,
  ): Promise<void> => runTool(label, action), [runTool]);

  const refreshDeviceSettings = useCallback(async () => {
    try {
      const settings = await window.ade.iosSimulator.getDeviceSettings(
        { deviceUdid: activeDeviceUdid ?? null },
        runtimePinRef.current,
      );
      setDeviceSettings(settings);
    } catch {
      // A device that is not booted has no settings to read. The column shows
      // its "n/a" state, which is the truth, so nothing is reported here.
      setDeviceSettings(null);
    }
  }, [activeDeviceUdid, runtimePinRef]);

  const handleSetAppearance = useCallback((appearance: IosSimulatorAppearance) => {
    void runSettingsTool("Setting the appearance", () => window.ade.iosSimulator.setAppearance(
      { deviceUdid: activeDeviceUdid ?? null, appearance },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runSettingsTool, runtimePinRef]);

  const handleSetContentSize = useCallback((contentSize: IosSimulatorContentSize) => {
    void runSettingsTool("Setting the text size", () => window.ade.iosSimulator.setContentSize(
      { deviceUdid: activeDeviceUdid ?? null, contentSize },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runSettingsTool, runtimePinRef]);

  const handleSetAccessibility = useCallback((option: IosSimulatorAccessibilityOption, enabled: boolean) => {
    void runSettingsTool("Setting the accessibility option", () => window.ade.iosSimulator.setAccessibilityOption(
      { deviceUdid: activeDeviceUdid ?? null, option, enabled },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runSettingsTool, runtimePinRef]);

  const handleSetLocation = useCallback((latitude: number, longitude: number) => {
    void runSettingsTool("Setting the location", () => window.ade.iosSimulator.setLocation(
      { deviceUdid: activeDeviceUdid ?? null, latitude, longitude },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runSettingsTool, runtimePinRef]);

  const handleClearLocation = useCallback(() => {
    void runSettingsTool("Clearing the location", () => window.ade.iosSimulator.clearLocation(
      { deviceUdid: activeDeviceUdid ?? null },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runSettingsTool, runtimePinRef]);

  const handleSetPermission = useCallback((
    action: IosSimulatorPrivacyAction,
    service: IosSimulatorPrivacyService,
  ) => {
    if (!bundleId && action !== "reset") {
      onError("Granting or revoking a permission needs an app session.");
      return;
    }
    void runDeviceCommand("Changing the permission", () => window.ade.iosSimulator.setPermission(
      { deviceUdid: activeDeviceUdid ?? null, bundleId, service, action },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, bundleId, onError, runDeviceCommand, runtimePinRef]);

  const handleSendPush = useCallback((title: string, body: string) => {
    if (!bundleId) return;
    void runDeviceCommand("Sending the push notification", () => window.ade.iosSimulator.sendPushNotification(
      { deviceUdid: activeDeviceUdid ?? null, bundleId, title, body },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, bundleId, runDeviceCommand, runtimePinRef]);

  const handleOpenSimulatorUrl = useCallback((url: string) => {
    void runDeviceCommand("Opening the URL", () => window.ade.iosSimulator.openUrl(
      { deviceUdid: activeDeviceUdid ?? null, url },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, runDeviceCommand, runtimePinRef]);

  /**
   * Restarts the installed binary.
   *
   * Not `launch`: that rebuilds the lane worktree first, which is minutes of
   * work to answer "show me this screen again".
   */
  const handleRelaunchApp = useCallback(() => {
    if (!bundleId) return;
    void runTool(
      "Relaunching the app",
      () => window.ade.iosSimulator.relaunchApp(
        { deviceUdid: activeDeviceUdid ?? null, bundleId },
        runtimePinRef.current,
      ),
      (state) => setAppRunning(state.running),
    );
  }, [activeDeviceUdid, bundleId, runTool, runtimePinRef]);

  const handleTerminateApp = useCallback(() => {
    if (!bundleId) return;
    void runDeviceCommand("Terminating the app", () => window.ade.iosSimulator.terminateApp(
      { deviceUdid: activeDeviceUdid ?? null, bundleId },
      runtimePinRef.current,
    ));
  }, [activeDeviceUdid, bundleId, runDeviceCommand, runtimePinRef]);

  const handleToggleEventLog = useCallback(() => {
    void (async () => {
      try {
        if (logRunning) {
          // The final page can name why the stream ended, so keep that even
          // though the rows already on screen are the last there will be.
          const page = await window.ade.iosSimulator.stopEventLog(
            logOwnerArgs,
            runtimePinRef.current,
          );
          logDeviceRef.current = null;
          setLogError(page.lastError);
          setLogRunning(false);
          return;
        }
        if (!bundleId) {
          // `log stream` reads the whole device, so the log is scoped to one
          // app or it does not run. The button is disabled without a bundle
          // id; this is the guard that survives a stale render.
          onError("Open an app in this drawer before you start the event log.");
          return;
        }
        const page = await window.ade.iosSimulator.startEventLog({
          deviceUdid: activeDeviceUdid ?? null,
          bundleId,
          ...logOwnerArgs,
        }, runtimePinRef.current);
        logDeviceRef.current = activeDeviceUdid ?? null;
        // The start page already carries rows, so the cursor has to move with
        // them. Left at zero, the first poll asked for everything since the
        // beginning of the log and appended the same rows a second time.
        logCursorRef.current = page.cursor;
        // A new run counts its own drops and reports its own error.
        setLogDropped(0);
        setLogError(page.lastError);
        setLogRunning(true);
        setLogRows(page.rows);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [activeDeviceUdid, bundleId, logOwnerArgs, logRunning, onError, runtimePinRef]);

  const handleCopyToolsText = useCallback((text: string) => {
    if (!text) return;
    void window.ade.app.writeClipboardText(text);
  }, []);

  // Reading the settings costs nine `simctl` calls, so it runs when the column
  // opens and when the device changes, not on the status poll.
  useEffect(() => {
    if (!visible) return;
    void refreshDeviceSettings();
  }, [visible, activeDeviceUdid, refreshDeviceSettings]);

  // Whether the app is running is the one fact the column shows that changes
  // without ADE doing anything, so it is the only thing here that polls.
  useEffect(() => {
    if (!visible || !bundleId) {
      setAppRunning(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const state = await window.ade.iosSimulator.getAppState(
          { deviceUdid: activeDeviceUdid ?? null, bundleId },
          runtimePinRef.current,
        );
        if (!cancelled) setAppRunning(state.running);
      } catch {
        if (!cancelled) setAppRunning(null);
      }
    };
    void read();
    const timer = setInterval(() => void read(), APP_STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeDeviceUdid, bundleId, visible, runtimePinRef]);

  // Log rows arrive by cursor, not by event: a busy app writes hundreds of
  // lines a second, and one event per line would cost more than the log is
  // worth. The cursor also means a poll that misses a beat loses nothing.
  useEffect(() => {
    if (!visible || !logRunning) return;
    let cancelled = false;
    const read = async () => {
      try {
        const page = await window.ade.iosSimulator.getEventLog(
          { deviceUdid: activeDeviceUdid ?? null, sinceId: logCursorRef.current, limit: 200 },
          runtimePinRef.current,
        );
        if (cancelled) return;
        if (page.rows.length) {
          setLogRows((current) => [...current, ...page.rows].slice(-EVENT_LOG_VIEW_ROWS));
        }
        logCursorRef.current = page.cursor;
        // A busy app outruns both rings: the service drops the oldest rows and
        // reports how many, and the view keeps only its last few hundred. A
        // reader who cannot see either count reads a truncated log as a quiet
        // one, which is the opposite of what it says.
        if (page.dropped > 0) setLogDropped((current) => current + page.dropped);
        setLogError(page.lastError);
        if (!page.running) setLogRunning(false);
      } catch {
        // A single failed read is not worth a message: the next poll either
        // recovers or the page carries the log's own `lastError`.
      }
    };
    const timer = setInterval(() => void read(), EVENT_LOG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeDeviceUdid, logRunning, visible, runtimePinRef]);

  /**
   * Re-binds a running log to the device the drawer now shows.
   *
   * The host's log process follows whichever device `startEventLog` named, so a
   * device switch left the panel appending the previous device's rows under the
   * new device's header. `getEventLog` now returns nothing for a device the log
   * does not follow, which would instead freeze the view, so the rows and the
   * cursor are dropped and the process is started again.
   *
   * `visible` is part of the guard so this never races the stop below: a device
   * that goes away hides the column, and starting a log there would outlive the
   * stop that fires in the same commit.
   */
  useEffect(() => {
    const deviceUdid = activeDeviceUdid ?? null;
    if (!visible || !logRunning || !bundleId || logDeviceRef.current === deviceUdid) return;
    logDeviceRef.current = deviceUdid;
    logCursorRef.current = 0;
    setLogDropped(0);
    setLogError(null);
    setLogRows([]);
    let cancelled = false;
    void (async () => {
      try {
        const page = await window.ade.iosSimulator.startEventLog(
          { deviceUdid, bundleId, ...logOwnerArgs },
          runtimePinRef.current,
        );
        if (cancelled) return;
        logCursorRef.current = page.cursor;
        setLogRows(page.rows);
      } catch (error) {
        if (cancelled) return;
        logDeviceRef.current = null;
        setLogRunning(false);
        onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeDeviceUdid, bundleId, logOwnerArgs, logRunning, onError, runtimePinRef, visible]);

  // Closing the column stops the log: the process runs on the machine that owns
  // the simulator, and nothing else reads it. Keyed on `requested`, not
  // `visible`, so expanding the video only pauses the poll.
  useEffect(() => {
    if (requested || !logRunning) return;
    // The running state follows the host, not the intent. Clearing it before
    // the stop returned left the drawer showing a stopped log while
    // `log stream` still ran, with no control left to stop it. The device the
    // log follows is restored on a refusal for the same reason.
    const followed = logDeviceRef.current;
    logDeviceRef.current = null;
    // Reopening the column starts a new log, and the stop from the close before
    // it can still be in flight. Its completion must not turn that new log off,
    // and its failure must not put the old device back over the new one.
    let superseded = false;
    void window.ade.iosSimulator
      .stopEventLog(logOwnerArgsRef.current, runtimePinRef.current)
      .then(() => {
        if (superseded) return;
        setLogRunning(false);
      })
      .catch((error: unknown) => {
        if (superseded) return;
        logDeviceRef.current = followed;
        onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      superseded = true;
    };
  }, [logRunning, onError, requested, runtimePinRef]);

  /**
   * Stops the log when the drawer goes away.
   *
   * The effect above only fires while the panel stays mounted, so switching
   * Work tabs or closing the chat left `xcrun simctl spawn log stream` running
   * on the host, one orphan per open. The ref is read instead of the state so
   * this stays a mount/unmount effect: listing `logRunning` would re-arm the
   * cleanup on every toggle and stop a log the user just started.
   */
  useEffect(() => () => {
    if (!logRunningRef.current) return;
    logRunningRef.current = false;
    logDeviceRef.current = null;
    // Nothing is left to report to, so a refusal is swallowed here on purpose.
    // The host still releases the log when the chat's session ends, and a log
    // this chat is not allowed to stop is one it must leave running anyway.
    void window.ade.iosSimulator
      .stopEventLog(logOwnerArgsRef.current, runtimePinRef.current)
      .catch(() => {});
  }, [runtimePinRef]);

  return {
    settings: deviceSettings,
    bundleId,
    appRunning,
    logRows,
    logRunning,
    logDropped,
    logError,
    onSetAppearance: handleSetAppearance,
    onSetContentSize: handleSetContentSize,
    onSetAccessibility: handleSetAccessibility,
    onSetLocation: handleSetLocation,
    onClearLocation: handleClearLocation,
    onSetPermission: handleSetPermission,
    onSendPush: handleSendPush,
    onOpenUrl: handleOpenSimulatorUrl,
    onRelaunchApp: handleRelaunchApp,
    onTerminateApp: handleTerminateApp,
    onToggleLog: handleToggleEventLog,
    onCopy: handleCopyToolsText,
    onRefresh: () => void refreshDeviceSettings(),
  };
}
