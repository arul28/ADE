import { IPC } from "../../../shared/ipc";
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
};

const REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS = 75_000;

function runtimeActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  const channel = RUNTIME_ACTION_CHANNEL[request.domain]?.[request.action];
  return channel ? ipcInvokeTimeoutMs(channel) : null;
}

function retryableRemoteActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  return isRetryableRemoteAction(request.domain, request.action)
    ? REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS
    : null;
}

export function ipcInvokeTimeoutMs(channel: string, args: readonly unknown[] = []): number {
  if (channel === IPC.localRuntimeCallAction) {
    const request = readRuntimeActionRequest(args);
    return request?.action
      ? localRuntimeActionIpcTimeoutMs(request.domain, request.action)
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
    // A cold iOS launch is a full xcodebuild plus boot, install and launch. The
    // service's own inner budgets sum to roughly 930s in the worst case, so the
    // IPC timer has to sit above that or the renderer reports a failure for a
    // launch that is still compiling. The remote-runtime path reads its IPC
    // budget from this same case via RUNTIME_ACTION_CHANNEL; the RPC transport
    // it wraps carries its own, shorter budget from remoteConnectionPool.
    case IPC.iosSimulatorLaunch:
      return IOS_SIMULATOR_LAUNCH_TIMEOUT_MS;
    case IPC.transcriptionTranscribe:
      return 6 * 60_000;
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
