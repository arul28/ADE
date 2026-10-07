import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  startJsonRpcServer,
  type JsonRpcRequest,
  type JsonRpcServerErrorContext,
  type JsonRpcTransport,
} from "../../../../../ade-cli/src/jsonrpc";
import {
  isBuiltInBrowserDesktopBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import {
  BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD,
  type BuiltInBrowserRuntimeStatus,
} from "../../../shared/types/builtInBrowserRuntimeStatus";
import { promisify } from "node:util";
import type { Logger } from "../logging/logger";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import type { AppControlScreencastRecorderBackend } from "../appControl/appControlRecording";
import {
  APP_CONTROL_RECORDER_BRIDGE_PREFIX,
  isAppControlRecorderBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/appControlRecorderBridgeClient";
import {
  DEMO_ENGINE_BRIDGE_PREFIX,
  isDemoEngineBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/demoEngineBridgeClient";
import {
  DESKTOP_APP_UPDATE_BRIDGE_PREFIX,
  DESKTOP_APP_UPDATE_INSTALL_METHOD,
} from "../../../../../ade-cli/src/services/runtime/desktopAppUpdateBridge";
import type { RemoteUpdateInstaller } from "../updates/remoteUpdateInstall";
import {
  SCENE_PREVIEW_BRIDGE_PREFIX,
  isScenePreviewBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/scenePreviewBridgeClient";
import {
  SCENE_PREVIEW_MAX_SOURCE_BYTES,
  type ScenePreviewRequest,
  type ScenePreviewResult,
} from "../../../shared/scenePreview";
import {
  type DemoEngine,
  type DemoPlan,
} from "../../../shared/demoVideo/demoContract";
import { DEMO_ENGINE_INPUT_EXTENSIONS } from "../demoVideo/demoMp4Source";
import { ELEVATED_DESKTOP_MESSAGE, ELEVATED_DESKTOP_TITLE } from "../../../shared/types/builtInBrowser";
import { builtInBrowserAgentPresence } from "./builtInBrowserPresence";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { localIpcListenOptions } from "../../../../../ade-cli/src/services/runtime/localIpcListenOptions";
import { pathComparisonKey } from "../shared/pathCompare";

/**
 * Per connection: the App Control recordings it started and the demo jobs it
 * runs, both cancelled when it closes.
 */
type BridgeConnectionState = {
  recorderKeys: Set<string>;
  demoJobs: Map<string, AbortController>;
  closed: boolean;
};

/**
 * Side-channel JSON-RPC server that exposes the desktop's
 * `BuiltInBrowserService` to the runtime daemon. The daemon proxies
 * `ade browser …` CLI calls through this socket because it cannot host
 * `BuiltInBrowserService` itself (Electron-only APIs).
 *
 * Methods are addressed as `built_in_browser.<allowlistedName>`. Anything
 * outside the allowlist returns `methodNotFound` so a daemon bug or
 * out-of-date desktop doesn't accidentally expose private internals.
 */

/**
 * The bridge methods whose own handlers end the agent's turn at a tab, and so
 * must NOT be followed by the trailing presence touch every other method gets.
 *
 * Derived from the presence router's clear paths rather than from intuition —
 * these are exactly the dispatchable methods that reach one of them:
 *
 * - `closeTab` → the coordinator resolves the closing tab id and calls
 *   `presenceRouter.noteTabClosed` inside the awaited promise.
 * - `startHandoff` → emits `handoff-started`, which the router turns into
 *   `clearForTab` plus `clearForChatSession` for the previous owner.
 *
 * The other clear path is deliberately absent: `noteWindowTabsClosed` runs
 * on window teardown, which no bridge method can request. `endSession` reads as turn-ending but is not — it closes a
 * recorded action session, touches no tab and clears no presence, so an agent
 * that ends a session and keeps browsing must keep its globe.
 */
const BUILT_IN_BROWSER_METHOD_PREFIX = "built_in_browser.";

const TURN_ENDING_BRIDGE_METHODS = new Set<string>(["closeTab", "startHandoff"]);

export type BuiltInBrowserDesktopBridgeServer = {
  socketPath: string;
  dispose: () => void;
};

const execFileAsync = promisify(execFile);

/**
 * True when this Windows process runs elevated (High or System integrity).
 * `whoami /groups` names the token's mandatory label; never throws.
 */
async function isWindowsProcessElevated(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const whoami = resolveTrustedWindowsTool("whoami");
    const { stdout } = await execFileAsync(whoami, ["/groups", "/fo", "csv", "/nh"], {
      windowsHide: true,
      timeout: 10_000,
    });
    return /S-1-16-(?:12288|16384)\b/.test(String(stdout));
  } catch {
    return false;
  }
}

export function startBuiltInBrowserDesktopBridgeServer(args: {
  socketPath: string;
  service: BuiltInBrowserService;
  logger: Logger;
  /**
   * The App Control screencast recorder (Windows/Linux), served to the runtime
   * daemon as `app_control_recorder.*`. Absent: those methods are not found.
   */
  appControlScreencastRecorder?: AppControlScreencastRecorderBackend | null;
  /**
   * The Chromium demo engine, served to the runtime daemon as
   * `demo_engine.*`. Absent: those methods are not found.
   */
  demoEngine?: DemoEngine | null;
  /**
   * This app's updater, served to the runtime daemon as `app_update.install`
   * so "Update & restart" pressed on another machine installs this app's
   * update instead of a standalone runtime this app would then replace.
   * Resolved per call: the updater is built after the bridge starts.
   */
  getAppUpdateInstaller?: (() => RemoteUpdateInstaller | null) | null;
  /**
   * `ade scene preview`: renders one scene in a hidden window, served to the
   * runtime daemon as `scene_preview.render`. Absent: not found.
   */
  scenePreview?: ((request: ScenePreviewRequest) => Promise<ScenePreviewResult>) | null;
  /**
   * Windows: this desktop is running elevated, so the background service
   * cannot open its bridge pipe. The caller tells the user.
   */
  onElevatedDesktop?: (() => void) | null;
}): BuiltInBrowserDesktopBridgeServer {
  const { socketPath, service, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");

  if (!isNamedPipe) {
    const socketDir = path.dirname(socketPath);
    try {
      const existed = fs.existsSync(socketDir);
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      if (!isSystemTempDir(socketDir) || !existed) {
        fs.chmodSync(socketDir, 0o700);
      }
    } catch (error) {
      logger.warn("built_in_browser_bridge.sockdir_create_failed", {
        socketPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // The path is NOT unlinked here. A dev desktop that shares the machine's
    // ADE home with the live desktop resolves the same bridge path, and a
    // blind unlink handed the live brain's browser calls to whichever desktop
    // started last (2026-09-18). Listen first; on EADDRINUSE probe the socket
    // and unlink only a socket nobody answers on (see the error handler).
  }

  const activeServerHandles = new Set<() => void>();
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    activeSockets.add(conn);
    const connection: BridgeConnectionState = { recorderKeys: new Set(), demoJobs: new Map(), closed: false };
    const transport: JsonRpcTransport = {
      onData(callback) {
        conn.on("data", callback);
      },
      write(data) {
        conn.write(data);
      },
      close() {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer((request) => handleRequest(request, connection), transport, {
      nonFatal: true,
      onError(error: unknown, context: JsonRpcServerErrorContext) {
        logger.warn("built_in_browser_bridge.contained_rpc_error", {
          context,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    activeServerHandles.add(stop);
    conn.on("close", () => {
      activeSockets.delete(conn);
      activeServerHandles.delete(stop);
      stop();
      // A runtime that exited or crashed mid-recording never sends its stop.
      // Drop what it started, or the lane's key stays taken and the hidden
      // encoder window, file handle and drain timer live on.
      releaseConnectionRecordings(connection);
    });
    conn.on("error", () => {
      // ignore per-connection errors; they are surfaced via the JSON-RPC frame.
    });
  });

  // One retry after a stale-socket unlink; a second EADDRINUSE means a live
  // owner appeared in between and this desktop yields to it.
  let retriedAfterStaleUnlink = false;
  server.on("error", (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && !isNamedPipe && !retriedAfterStaleUnlink) {
      retriedAfterStaleUnlink = true;
      // Probe: a live bridge accepts the connection; a stale file refuses it.
      const probe = net.connect(socketPath);
      let settled = false;
      const settle = (live: boolean) => {
        if (settled) return;
        settled = true;
        probe.destroy();
        if (live) {
          logger.warn("built_in_browser_bridge.already_served", {
            socketPath,
            reason: "another desktop answers on this bridge socket; leaving it in place",
          });
          try {
            server.close();
          } catch {
            // ignore close failures when yielding
          }
          return;
        }
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // the stale file may already be gone
        }
        logger.info("built_in_browser_bridge.stale_socket_replaced", { socketPath });
        server.listen(localIpcListenOptions(socketPath));
      };
      probe.once("connect", () => settle(true));
      probe.once("error", () => settle(false));
      probe.setTimeout(1_000, () => settle(false));
      return;
    }
    logger.error("built_in_browser_bridge.server_error", {
      socketPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    server.listen(localIpcListenOptions(socketPath), () => {
      if (!isNamedPipe) {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (error) {
          logger.warn("built_in_browser_bridge.sock_chmod_failed", {
            socketPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          try {
            server.close();
          } catch {
            // ignore close failures after chmod failure
          }
          return;
        }
      }
      logger.info("built_in_browser_bridge.listening", { socketPath });
      if (isNamedPipe && process.platform === "win32") {
        // A pipe made by an elevated process admits administrators only, so
        // the background service (the plain user) is refused with EPERM and
        // every demo, browser call and screencast from it fails. Node cannot
        // set the pipe's DACL, so this is said once, loudly, instead.
        void isWindowsProcessElevated().then((elevated) => {
          if (!elevated) return;
          logger.warn("built_in_browser_bridge.elevated_desktop", {
            socketPath,
            reason: `${ELEVATED_DESKTOP_TITLE}. ${ELEVATED_DESKTOP_MESSAGE}`,
          });
          args.onElevatedDesktop?.();
        });
      }
    });
  } catch (error) {
    throw error;
  }

  function releaseConnectionRecordings(connection: BridgeConnectionState): void {
    const recorder = args.appControlScreencastRecorder ?? null;
    connection.closed = true;
    // Nobody is left to receive a demo job's answer; stop its hidden renderer.
    for (const controller of connection.demoJobs.values()) controller.abort();
    connection.demoJobs.clear();
    const keys = [...connection.recorderKeys];
    connection.recorderKeys.clear();
    if (!recorder || !keys.length) return;
    for (const key of keys) {
      try {
        recorder.cancel?.(key);
      } catch {
        // best effort: the next start for the lane reports what is left
      }
    }
    logger.info("built_in_browser_bridge.recordings_released_on_close", { count: keys.length });
  }

  // The engines served besides the built-in browser, each under its own method
  // prefix. Everything else must be `built_in_browser.*`.
  const engines: Array<{
    prefix: string;
    handle: (name: string, params: Record<string, unknown>, connection: BridgeConnectionState) => Promise<unknown>;
  }> = [
    { prefix: APP_CONTROL_RECORDER_BRIDGE_PREFIX, handle: (name, params, connection) => handleAppControlRecorder(name, params, connection) },
    { prefix: DEMO_ENGINE_BRIDGE_PREFIX, handle: (name, params, connection) => handleDemoEngine(name, params, connection) },
    { prefix: SCENE_PREVIEW_BRIDGE_PREFIX, handle: (name, params) => handleScenePreview(name, params) },
  ];

  async function handleRequest(request: JsonRpcRequest, connection: BridgeConnectionState): Promise<unknown> {
    const method = request.method ?? "";
    const engine = engines.find((entry) => method.startsWith(entry.prefix)) ?? null;
    const isAppUpdateMethod = method.startsWith(DESKTOP_APP_UPDATE_BRIDGE_PREFIX);
    if (!engine && !isAppUpdateMethod && !method.startsWith(BUILT_IN_BROWSER_METHOD_PREFIX)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Unsupported method '${method}'. Desktop bridge only handles ${[BUILT_IN_BROWSER_METHOD_PREFIX, DESKTOP_APP_UPDATE_BRIDGE_PREFIX, ...engines.map((entry) => entry.prefix)].map((prefix) => `${prefix}*`).join(", ")}`,
      );
    }
    const name = method.slice((engine?.prefix ?? BUILT_IN_BROWSER_METHOD_PREFIX).length);
    // No secret on this socket: it is owner-only (0600 in a 0700 directory, a
    // per-account named pipe on Windows), the same boundary the brain's own
    // socket relies on. A process that can open it is already running as the
    // user and could drive the browser profile on disk directly.
    const rawParams = isRecord(request.params) ? { ...request.params } : {};
    if (engine) return await engine.handle(name, rawParams, connection);
    if (isAppUpdateMethod) {
      const installer = args.getAppUpdateInstaller?.() ?? null;
      if (method !== DESKTOP_APP_UPDATE_INSTALL_METHOD || !installer) {
        throw new JsonRpcError(
          JsonRpcErrorCode.methodNotFound,
          `Action '${method}' is not exposed by the desktop bridge.`,
        );
      }
      return await installer.install({ targetVersion: normalizedString(rawParams.targetVersion) });
    }
    // Kept for brains from before the bridge dropped its secret: they probe
    // with it before every call.
    if (name === "authenticate") {
      return { authenticated: true };
    }
    // Read-only Work-tools mirror for the runtime daemon. A deliberately narrow
    // projection (see `BuiltInBrowserRuntimeStatus`): no cookies, no
    // observation bytes and no way to act on a tab.
    if (name === BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD) {
      // Project-scoped, not frontmost-window-scoped. The daemon asking is bound
      // to one project; answering out of whichever window is active would hide
      // its own tabs and leak another project's tab titles and URLs onto a
      // phone bound to this one.
      const scopeProjectRoot = normalizedString(rawParams.projectRoot);
      const status = service.getStatusForProjectScope(scopeProjectRoot);
      if (!status) {
        // Two different absences, two different instructions. A window that has
        // the project open but has never used its Browser pane has no
        // collection to read — and the read deliberately does not build one —
        // but that user must not be told to open a project they already have
        // open. `hasWindowForProjectScope` is the same side-effect-free lookup.
        const empty: BuiltInBrowserRuntimeStatus = {
          activeTabId: null,
          tabs: [],
          unavailable: service.hasWindowForProjectScope(scopeProjectRoot)
            ? "browser_pane_not_opened"
            : "desktop_not_attached_for_project",
        };
        return empty;
      }
      const runtimeStatus: BuiltInBrowserRuntimeStatus = {
        unavailable: null,
        // Project-scoped for the same reason the tab list is: a phone bound to
        // one project must not learn that a chat in another one is browsing.
        presence: builtInBrowserAgentPresence
          .list({ projectRoot: scopeProjectRoot })
          .map((entry) => ({
            chatSessionId: entry.chatSessionId,
            laneId: entry.laneId,
            tabId: entry.tabId,
            since: entry.since,
            lastActivityAt: entry.lastActivityAt,
          })),
        activeTabId: status.activeTabId,
        tabs: status.tabs.map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          ownerLaneId: tab.ownerLaneId,
          ownerChatSessionId: tab.ownerChatSessionId,
          recording: tab.recording != null,
          handoff: tab.handoff
            ? {
              reason: tab.handoff.reason,
              previousOwner: {
                laneId: tab.handoff.previousOwner.laneId,
                chatSessionId: tab.handoff.previousOwner.chatSessionId,
              },
            }
            : null,
        })),
      };
      return runtimeStatus;
    }
    if (
      name === "getProfileDiagnostics"
      || name === "listPermissions"
      || name === "clearPermissions"
    ) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        `Action 'built_in_browser.${name}' is only available to the trusted ADE renderer.`,
      );
    }
    if (!isBuiltInBrowserDesktopBridgeMethod(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action 'built_in_browser.${name}' is not exposed by the desktop bridge.`,
      );
    }
    // The runtime daemon decides who is calling: it resolves the chat, its lane
    // and its project (or the personal collection) from the caller it already
    // knows, and sends them here. A call with no chat (the user's own terminal)
    // is allowed too; it just owns no tab.
    const chatSessionId = normalizedString(rawParams.chatSessionId);
    const laneId = normalizedString(rawParams.laneId);
    const tabCollection = rawParams.tabCollection === "personal" ? "personal" : null;
    const projectRoot = tabCollection === "personal" ? null : normalizedString(rawParams.projectRoot);
    const params = {
      ...rawParams,
      chatSessionId: chatSessionId ?? undefined,
      laneId: laneId ?? undefined,
      ...(projectRoot
        ? { projectRoot, tabCollection: undefined }
        : { projectRoot: undefined, tabCollection: tabCollection ?? undefined }),
      force: false,
    };
    // A step caption touches no tab: it must not light the browser's presence.
    if (name === "noteDemoStep") {
      return service.noteDemoStep(params);
    }
    const callable = (service as unknown as Record<string, unknown>)[name];
    if (typeof callable !== "function") {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Desktop bridge cannot dispatch built_in_browser.${name}.`,
      );
    }
    // Presence is a chat's ("this chat is browsing"); a chatless call has none.
    if (!chatSessionId) {
      try {
        return await (callable as (input: unknown) => Promise<unknown>).call(service, params);
      } catch (error) {
        if (error instanceof JsonRpcError) throw error;
        throw new JsonRpcError(
          JsonRpcErrorCode.internalError,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // Recorded on BOTH edges of the call.
    //
    // Before, because a `wait`, a slow navigation or a long `observe` is
    // exactly the stretch a person is trying to explain, and a globe that lit
    // only on completion stayed dark for the whole of it — indefinitely, for
    // back-to-back long calls, since the twenty-second window would not even
    // start until one returned. After, because that window should be measured
    // from when the agent finished, not from when it began.
    //
    // Every method counts, reads included: `status` and `observe` are how an
    // agent looks at the page, and a badge that lit only for writes would go
    // dark while it read.
    const presenceTouch = {
      chatSessionId,
      laneId,
      projectRoot,
      tabId: normalizedString(rawParams.tabId),
    };
    const opened = builtInBrowserAgentPresence.touch(presenceTouch);
    try {
      const result = await (callable as (input: unknown) => Promise<unknown>).call(service, params);
      // …except after the two calls that END the agent's turn at the tab. Both
      // clear presence from inside the dispatch, and a trailing touch would
      // re-create the record they just removed — with the dead or handed-off
      // tab id — leaving the badge saying "browsing" for a full expiry window
      // after the agent closed its last tab, or pulsing beside the very banner
      // asking a human to sign in.
      if (!TURN_ENDING_BRIDGE_METHODS.has(name)) {
        builtInBrowserAgentPresence.touch(presenceTouch);
      }
      return result;
    } catch (error) {
      // The call did nothing to the browser ("No ADE browser window is open for
      // project…"), so the announcement is taken back — but only when this call
      // is what made it. A failure inside a stream of commands leaves presence
      // the earlier ones earned, and the `ifSequence` guard drops the undo if a
      // concurrent command from the same chat moved the entry meanwhile (or if
      // a recording took a hold on it while this call was in flight).
      if (opened.created) {
        builtInBrowserAgentPresence.clearForChatSession(chatSessionId, {
          ifSequence: opened.sequence,
        });
      }
      if (error instanceof JsonRpcError) throw error;
      throw new JsonRpcError(
        JsonRpcErrorCode.internalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * The App Control screencast recorder, for the runtime daemon, which decides
   * which lane records. Recordings are keyed per lane.
   */
  async function handleAppControlRecorder(
    name: string,
    params: Record<string, unknown>,
    connection: BridgeConnectionState,
  ): Promise<unknown> {
    const recorder = args.appControlScreencastRecorder ?? null;
    if (!recorder || !isAppControlRecorderBridgeMethod(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action '${APP_CONTROL_RECORDER_BRIDGE_PREFIX}${name}' is not exposed by the desktop bridge.`,
      );
    }
    const key = normalizedString(params.key);
    if (!key) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "App Control recorder calls need a recording key.");
    }
    try {
      if (name === "start") {
        const filePath = await resolveRecorderTargetPath(normalizedString(params.filePath));
        const fps = typeof params.fps === "number" && Number.isFinite(params.fps) ? params.fps : 10;
        const started = await recorder.start({ key, filePath, fps, keepIdle: params.keepIdle === true });
        // The caller went away while the recorder was starting; nobody will stop it.
        if (connection.closed) {
          recorder.cancel?.(key);
          return started;
        }
        connection.recorderKeys.add(key);
        return started;
      }
      if (name === "pushFrame") {
        const frame = isRecord(params.frame) ? params.frame : null;
        if (frame && typeof frame.data === "string" && frame.data) {
          recorder.pushFrame(key, frame as unknown as Parameters<AppControlScreencastRecorderBackend["pushFrame"]>[1]);
        }
        return { ok: true };
      }
      if (name === "stop") {
        connection.recorderKeys.delete(key);
        return await recorder.stop(key);
      }
      connection.recorderKeys.delete(key);
      recorder.cancel?.(key);
      return { ok: true };
    } catch (error) {
      if (error instanceof JsonRpcError) throw error;
      throw new JsonRpcError(
        JsonRpcErrorCode.internalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * `ade scene preview`, for the runtime daemon.
   * The scene source is the only input: no path is read or written here, and
   * the screenshot comes back in the answer for the daemon to file.
   */
  async function handleScenePreview(name: string, params: Record<string, unknown>): Promise<unknown> {
    const preview = args.scenePreview ?? null;
    if (!preview || !isScenePreviewBridgeMethod(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action '${SCENE_PREVIEW_BRIDGE_PREFIX}${name}' is not exposed by the desktop bridge.`,
      );
    }
    const request = isRecord(params.request) ? params.request : null;
    const source = request && typeof request.source === "string" ? request.source : "";
    if (!source.trim()) throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "A scene preview needs the scene's source.");
    if (Buffer.byteLength(source, "utf8") > SCENE_PREVIEW_MAX_SOURCE_BYTES) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "That scene is too large to preview.");
    }
    try {
      return await preview({
        source,
        ...(typeof request?.width === "number" ? { width: request.width } : {}),
        ...(request?.theme === "light" || request?.theme === "dark" ? { theme: request.theme } : {}),
        ...(request && "data" in request && request.data != null ? { data: request.data } : {}),
      });
    } catch (error) {
      throw new JsonRpcError(JsonRpcErrorCode.internalError, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The Chromium demo engine, for the runtime daemon. The engine reads one `.aderaw` capture and
   * writes one `.mp4`; paths are checked here before it opens either.
   */
  async function handleDemoEngine(
    name: string,
    params: Record<string, unknown>,
    connection: BridgeConnectionState,
  ): Promise<unknown> {
    const engine = args.demoEngine ?? null;
    if (!engine || !isDemoEngineBridgeMethod(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action '${DEMO_ENGINE_BRIDGE_PREFIX}${name}' is not exposed by the desktop bridge.`,
      );
    }
    const jobId = normalizedString(params.jobId);
    if (!jobId) throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Demo engine calls need a job id.");
    if (name === "cancel") {
      connection.demoJobs.get(jobId)?.abort();
      connection.demoJobs.delete(jobId);
      return { ok: true };
    }
    if (connection.demoJobs.has(jobId)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Demo job ${jobId} is already running.`);
    }
    const controller = new AbortController();
    connection.demoJobs.set(jobId, controller);
    try {
      if (name === "analyze") {
        const input = await resolveDemoEnginePath(normalizedString(params.input), DEMO_ENGINE_INPUT_EXTENSIONS, true);
        return await engine.analyze(input, { signal: controller.signal });
      }
      const request = isRecord(params.request) ? params.request : null;
      if (!request || !isRecord(request.plan)) {
        throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Demo engine render needs a request with a plan.");
      }
      const input = await resolveDemoEnginePath(normalizedString(request.input), DEMO_ENGINE_INPUT_EXTENSIONS, true);
      const output = await resolveDemoEnginePath(normalizedString(request.output), [".mp4"], false);
      return await engine.render(
        { input, output, plan: request.plan as unknown as DemoPlan },
        { signal: controller.signal },
      );
    } catch (error) {
      if (error instanceof JsonRpcError) throw error;
      throw new JsonRpcError(
        JsonRpcErrorCode.internalError,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (connection.demoJobs.get(jobId) === controller) connection.demoJobs.delete(jobId);
    }
  }

  return {
    socketPath,
    dispose: () => {
      for (const stop of activeServerHandles) {
        try {
          stop();
        } catch {
          // ignore
        }
      }
      activeServerHandles.clear();
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
      try {
        server.close();
      } catch {
        // ignore
      }
      if (!isNamedPipe) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * The file an App Control recording may write. The recorder opens it for
 * writing, so a bridge caller must not be able to name any file it likes: the
 * runtime reserves recordings under a project's `.ade/artifacts/computer-use`
 * (`createComputerUseArtifactPath`), and that is the only place taken. The
 * directory is resolved through symlinks before the check, and the file is
 * rebuilt from that real directory so a link swapped in later cannot redirect it.
 */
/** Whether a real directory is a project's `.ade/artifacts/computer-use`. */
function isComputerUseArtifactsDir(realDir: string): boolean {
  const tail = realDir.split(/[\\/]+/).filter(Boolean).map((segment) => pathComparisonKey(segment)).slice(-3);
  return tail.length === 3 && tail[0] === ".ade" && tail[1] === "artifacts" && tail[2] === "computer-use";
}

async function resolveRecorderTargetPath(filePath: string | null): Promise<string> {
  const refuse = (): never => {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "App Control recorder start needs an absolute .mp4, .webm or .aderaw path under a project's .ade/artifacts/computer-use directory.",
    );
  };
  if (!filePath || !path.isAbsolute(filePath) || !/\.(mp4|webm|aderaw)$/i.test(filePath)) return refuse();
  const realDir = await fs.promises.realpath(path.dirname(filePath)).catch(() => null);
  if (!realDir) return refuse();
  if (!isComputerUseArtifactsDir(realDir)) return refuse();
  return path.join(realDir, path.basename(filePath));
}


/**
 * A file the demo engine may read (`mustExist`) or write. Absolute, with an
 * extension that job takes, in a project's `.ade/artifacts/computer-use`
 * directory (the only place App Control's recordings live); resolved through
 * symlinks and rebuilt from the real directory, as for the recorder. The
 * engine writes a temporary sibling and renames it onto the output.
 */
async function resolveDemoEnginePath(filePath: string | null, extensions: readonly string[], mustExist: boolean): Promise<string> {
  const refuse = (): never => {
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      `The demo engine needs an absolute ${extensions.join(" or ")} path under a project's .ade/artifacts/computer-use directory${mustExist ? ", of a file that exists" : ""}.`,
    );
  };
  if (!filePath || !path.isAbsolute(filePath) || !extensions.includes(path.extname(filePath).toLowerCase())) return refuse();
  const realDir = await fs.promises.realpath(path.dirname(filePath)).catch(() => null);
  if (!realDir || !isComputerUseArtifactsDir(realDir)) return refuse();
  const resolved = path.join(realDir, path.basename(filePath));
  if (mustExist) {
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat?.isFile()) return refuse();
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSystemTempDir(dirPath: string): boolean {
  const normalized = path.resolve(dirPath);
  return normalized === path.resolve(os.tmpdir())
    || normalized === "/tmp"
    || normalized === "/private/tmp";
}
