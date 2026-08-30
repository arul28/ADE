import { IPC } from "../../../shared/ipc";
import {
  clampPluginInvokeTimeoutMs,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS,
} from "../../../shared/plugins/sockets";
import { isRetryableRemoteAction } from "../remoteRuntime/retryableRemoteActions";
import {
  localRuntimeActionIpcTimeoutMs,
  LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS,
  PI_LOGIN_IPC_TIMEOUT_MS,
  CURSOR_LOGIN_IPC_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS,
  USAGE_REFRESH_HISTORY_TIMEOUT_MS,
  IOS_SIMULATOR_LAUNCH_TIMEOUT_MS,
  IOS_SIMULATOR_PREVIEW_TIMEOUT_MS,
} from "../localRuntime/localRuntimeTimeoutPolicy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The `{ request: { domain, action } }` payload every runtime `callAction`
 * invoke carries, read off the raw IPC arguments.
 *
 * One decoder for every reader of that shape — the timeout policy below and the
 * failure telemetry in `registerIpc` — because they all describe the same call
 * and a reader that disagreed about what a well-formed request looks like would
 * silently attribute a timeout to one action and its failure to another.
 * `action` is optional: a payload naming only a domain is still enough to
 * attribute a failure, and callers that need to route on the action check it.
 */
export function readRuntimeActionRequest(
  args: readonly unknown[],
): { domain: string; action?: string } | null {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  const domain = typeof request?.domain === "string" ? request.domain.trim() : "";
  if (!domain) return null;
  const action = typeof request?.action === "string" ? request.action.trim() : "";
  return { domain, ...(action ? { action } : {}) };
}

/**
 * The action's OWN args, off the same raw invoke arguments.
 *
 * Read apart from the decoder above rather than added to it, because the two
 * answer different questions: that one identifies the call and is compared
 * whole by its callers, while this is only ever consumed by a budget. Only
 * `plugin.invoke` looks at it — a contributed `composer-action` may name a
 * per-call timeout, and losing it here would cut a recording off at the default.
 */
function readRuntimeActionArgs(args: readonly unknown[]): unknown {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  return request?.args;
}

const RUNTIME_ACTION_CHANNEL: Record<string, Record<string, string>> = {
  ai: {
    piLoginStart: IPC.aiPiLoginStart,
    cursorAuthLogin: IPC.aiCursorAuthLogin,
  },
  lane: {
    create: IPC.lanesCreate,
    createChild: IPC.lanesCreateChild,
    createFromUnstaged: IPC.lanesCreateFromUnstaged,
    importBranch: IPC.lanesImportBranch,
    archive: IPC.lanesArchive,
    delete: IPC.lanesDelete,
  },
  ios_simulator: {
    // A remote runtime builds with the same xcodebuild as a local one, so a
    // cold launch or preview render needs the same budget whichever runtime
    // answers it. Without these the remote path fell through to 30s and
    // reported a timeout while the build was still running. This map only sets
    // the renderer→main IPC timer; the transport budget underneath it lives in
    // remoteConnectionPool's LONG_RUNNING_REMOTE_RUNTIME_ACTION_TIMEOUTS.
    launch: IPC.iosSimulatorLaunch,
    resolvePreviewMatch: IPC.iosSimulatorResolvePreviewMatch,
    ensurePreviewWorkspace: IPC.iosSimulatorEnsurePreviewWorkspace,
    renderCurrentPreview: IPC.iosSimulatorRenderCurrentPreview,
    renderPreview: IPC.iosSimulatorRenderPreview,
  },
  chat: {
    handoffSession: IPC.agentChatHandoff,
    prepareCrossMachineHandoff: IPC.agentChatPrepareCrossMachineHandoff,
  },
  // A remote runtime runs the same ledger worker as a local one, so the Usage
  // page's Refresh needs the same budget whichever runtime answers it.
  usage: {
    refreshHistory: IPC.usageRefreshHistory,
  },
  // A plugin installed on a remote machine clones on that machine and its
  // handlers run there, so both need the local budgets rather than the 30s
  // remote default.
  plugin: {
    install: IPC.pluginInstall,
    invoke: IPC.pluginInvoke,
  },
};

const REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS = 75_000;

function runtimeActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  const channel = RUNTIME_ACTION_CHANNEL[request.domain]?.[request.action];
  // The action's own args ride along so a per-call budget survives the remote
  // path too: a plugin installed on another machine runs its handler there, and
  // a composer action that records for minutes must not be cut off at the
  // default just because the request took the remote route.
  return channel ? ipcInvokeTimeoutMs(channel, [readRuntimeActionArgs(args)]) : null;
}

function retryableRemoteActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  return isRetryableRemoteAction(request.domain, request.action)
    ? REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS
    : null;
}

/**
 * Headroom the renderer's IPC budget keeps over the child's own.
 *
 * The two must not expire together. The child supervisor answers a blown budget
 * with a typed `plugin_timeout` naming the plugin and the action; an IPC
 * timeout that fired first would replace that with an opaque channel error, and
 * the person looking at it would have no way to tell a wedged plugin from a
 * wedged app.
 */
const PLUGIN_INVOKE_IPC_HEADROOM_MS = 30_000;

/**
 * A plugin invocation may name its own budget — a `composer-action` that
 * records or transcribes runs for minutes by design (see
 * `PLUGIN_SOCKET_INVOKE_TIMEOUT_MS` in `shared/plugins/sockets.ts`). Read the
 * hint off the payload and clamp it, rather than raising the ceiling for every
 * plugin call: an ordinary contributed button that wedges should still fail
 * while the user remembers pressing it.
 */
function pluginInvokeTimeoutMs(args: readonly unknown[]): number {
  const payload = args[0];
  const hint = isRecord(payload) ? clampPluginInvokeTimeoutMs(payload.timeoutMs) : null;
  return (hint ?? PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS) + PLUGIN_INVOKE_IPC_HEADROOM_MS;
}

export function ipcInvokeTimeoutMs(channel: string, args: readonly unknown[] = []): number {
  if (channel === IPC.localRuntimeCallAction) {
    const request = readRuntimeActionRequest(args);
    // The action's own args ride along so `plugin.invoke` can honour a
    // per-call budget: this is the route the desktop's plugin calls take
    // whenever a project runtime is bound.
    return request?.action
      ? localRuntimeActionIpcTimeoutMs(request.domain, request.action, readRuntimeActionArgs(args))
      : LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS;
  }
  if (channel === IPC.localRuntimeCallSync) return LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS;
  // Reconnecting forwards to the brain on the same 30s sync budget. On the 30s
  // IPC default the two would expire together and the renderer would render an
  // opaque IPC timeout instead of the brain's legible reason — so this channel
  // gets the same headroom every other brain-forwarding channel has.
  if (channel === IPC.accountRepairMachinePairing) return LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS;
  if (channel === IPC.localRuntimeListActionRegistry) return LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS;
  if (channel === IPC.localRuntimeStreamEvents) return LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS;
  if (channel === IPC.remoteRuntimeCallAction) {
    const actionTimeoutMs = runtimeActionTimeoutMs(args);
    if (actionTimeoutMs != null) return actionTimeoutMs;
    const retryableActionTimeoutMs = retryableRemoteActionTimeoutMs(args);
    if (retryableActionTimeoutMs != null) return retryableActionTimeoutMs;
    return 30_000;
  }
  switch (channel) {
    // Switching projects can cold-start and bind the local runtime. Keep the
    // renderer's outcome known through setup and result delivery.
    case IPC.projectSwitchToPath:
      return LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS;
    // Awaits the user finishing Pi's own sign-in in a browser.
    case IPC.aiPiLoginStart:
      return PI_LOGIN_IPC_TIMEOUT_MS;
    case IPC.aiCursorAuthLogin:
      return CURSOR_LOGIN_IPC_TIMEOUT_MS;
    case IPC.remoteRuntimeConnect:
    case IPC.remoteRuntimeListProjects:
    case IPC.remoteRuntimeAddProject:
    case IPC.remoteRuntimeBrowseDirectories:
    case IPC.remoteRuntimeGetProjectDetail:
    case IPC.remoteRuntimeGetDefaultParentDir:
    case IPC.remoteRuntimeCreateProject:
    case IPC.remoteRuntimeCloneProject:
    case IPC.remoteRuntimeListMyGitHubRepos:
    case IPC.remoteRuntimeOpenProject:
    case IPC.remoteRuntimeListActionRegistry:
    case IPC.remoteRuntimeCallSync:
    case IPC.remoteRuntimeEnsurePortForward:
    case IPC.remoteRuntimeStreamEvents:
      return REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS;
    case IPC.lanesCreate:
    case IPC.lanesCreateChild:
    case IPC.lanesCreateFromUnstaged:
    case IPC.lanesImportBranch:
    case IPC.lanesArchive:
    case IPC.lanesDelete:
      return 4 * 60_000;
    // Handoff runs an AI brief + session creation + first-message dispatch
    // (and cross-machine prepare additionally packages provider history);
    // it must outlive the daemon-side 120s action timeout so the false
    // "timed out but later succeeded" failure can't reappear via this layer.
    case IPC.agentChatHandoff:
    case IPC.agentChatPrepareCrossMachineHandoff:
      return 150_000;
    // A brain restart waits through the service install, then for the
    // replacement brain to rebind (20s) and answer a ping (20s). The install
    // leg can be 120s rather than 60s, because a forced restart queues behind
    // an in-flight non-forced install instead of joining it. The renderer must
    // not give up before the main process knows the outcome, or the Repair
    // button reports a failure for a restart that actually succeeded.
    case IPC.appRestartBackgroundService:
    // Repairing the stored sign-in ends in that same brain restart, so it
    // inherits the same budget. On the 30s default the renderer would report a
    // failure for a repair that is still running — the exact mis-report the
    // restart case above exists to prevent.
    case IPC.accountRepairSession:
      return 4 * 60_000;
    // The Usage page's Refresh runs the isolated ledger worker end to end. On
    // the 30s default the renderer rejected with a raw IPC timeout — and blanked
    // the page — while the daemon kept scanning for another nine minutes.
    case IPC.usageRefreshHistory:
      return USAGE_REFRESH_HISTORY_TIMEOUT_MS;
    // Installing a plugin is a `git clone`; invoking one runs third-party code
    // behind the child supervisor's own 20s spawn + per-call handler budgets.
    // Both must outlive the daemon work or the renderer reports a failure for
    // an install that lands anyway. See localRuntimeTimeoutPolicy for the pair.
    case IPC.pluginInstall:
      return 4 * 60_000;
    case IPC.pluginInvoke:
      return pluginInvokeTimeoutMs(args);
    // A cold iOS launch is a full xcodebuild plus boot, install and launch. The
    // service's own inner budgets sum to roughly 930s in the worst case, so the
    // IPC timer has to sit above that or the renderer reports a failure for a
    // launch that is still compiling. The remote-runtime path reads its IPC
    // budget from this same case via RUNTIME_ACTION_CHANNEL; the RPC transport
    // it wraps carries its own, shorter budget from remoteConnectionPool.
    case IPC.iosSimulatorLaunch:
      return IOS_SIMULATOR_LAUNCH_TIMEOUT_MS;
    // Streams up to 50 MB to a paired host over HTTP. The upload client's own
    // budget is 5 minutes, so on the 30s default the renderer reported a
    // failure — and dropped the pending attachment chip — for an upload that
    // was still in flight. This has to sit above the client's budget so the
    // legible reason wins.
    case IPC.remoteRuntimeUploadChatAttachment:
      return 6 * 60_000;
    // Preview Lab compiles the target before it can render a frame, so these
    // three carry the same 10 minute budget the local runtime map gives them.
    // The remote-runtime path reads its IPC budget from these same cases via
    // RUNTIME_ACTION_CHANNEL, so a shorter budget here reported a timeout for
    // a preview that was still compiling.
    case IPC.iosSimulatorEnsurePreviewWorkspace:
    case IPC.iosSimulatorRenderCurrentPreview:
    case IPC.iosSimulatorRenderPreview:
      return IOS_SIMULATOR_PREVIEW_TIMEOUT_MS;
    case IPC.iosSimulatorListLaunchTargets:
    case IPC.iosSimulatorGetScreenSnapshot:
    case IPC.iosSimulatorInspectPoint:
    case IPC.iosSimulatorSelectPoint:
    case IPC.iosSimulatorGetPreviewCapability:
    case IPC.iosSimulatorListPreviewTargets:
    case IPC.iosSimulatorResolvePreviewMatch:
      return 2 * 60_000;
    case IPC.iosSimulatorOpenPreviewWorkspace:
    case IPC.iosSimulatorScreenshot:
    case IPC.iosSimulatorStartStream:
    case IPC.iosSimulatorStopStream:
    case IPC.iosSimulatorShutdown:
    case IPC.iosSimulatorGetStreamStatus:
    case IPC.iosSimulatorGetWindowState:
    case IPC.iosSimulatorListWindowSources:
    case IPC.iosSimulatorOpenSystemSettings:
    case IPC.iosSimulatorRevealWindow:
    case IPC.iosSimulatorTap:
    case IPC.iosSimulatorTypeText:
    case IPC.iosSimulatorDrag:
    case IPC.iosSimulatorSwipe:
    case IPC.appControlLaunch:
    case IPC.appControlLaunchInTerminal:
    case IPC.appControlGetSnapshot:
    case IPC.appControlInspectPoint:
    case IPC.appControlSelectPoint:
    case IPC.appControlScreenshot:
    case IPC.appControlConnect:
    case IPC.appControlStop:
    case IPC.appControlFocusWindow:
    case IPC.appControlMinimizeWindow:
    case IPC.appControlClick:
    case IPC.appControlTypeText:
    case IPC.builtInBrowserNavigate:
    case IPC.builtInBrowserCreateTab:
    case IPC.builtInBrowserReload:
    case IPC.builtInBrowserStartInspect:
    case IPC.builtInBrowserStopInspect:
    case IPC.builtInBrowserCaptureScreenshot:
    case IPC.builtInBrowserSelectPoint:
      return 60_000;
    default:
      return 30_000;
  }
}
