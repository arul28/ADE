import { IPC } from "../../../shared/ipc";
import { isRetryableRemoteAction } from "../remoteRuntime/retryableRemoteActions";
import {
  localRuntimeActionIpcTimeoutMs,
  LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS,
  PI_LOGIN_IPC_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS,
} from "../localRuntime/localRuntimeTimeoutPolicy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const RUNTIME_ACTION_CHANNEL: Record<string, Record<string, string>> = {
  ai: {
    piLoginStart: IPC.aiPiLoginStart,
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
    resolvePreviewMatch: IPC.iosSimulatorResolvePreviewMatch,
    ensurePreviewWorkspace: IPC.iosSimulatorEnsurePreviewWorkspace,
    renderCurrentPreview: IPC.iosSimulatorRenderCurrentPreview,
  },
  chat: {
    handoffSession: IPC.agentChatHandoff,
    prepareCrossMachineHandoff: IPC.agentChatPrepareCrossMachineHandoff,
  },
};

const REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS = 75_000;

function runtimeActionTimeoutMs(args: readonly unknown[]): number | null {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  if (typeof request?.domain !== "string" || typeof request.action !== "string") return null;
  const channel = RUNTIME_ACTION_CHANNEL[request.domain]?.[request.action];
  return channel ? ipcInvokeTimeoutMs(channel) : null;
}

function retryableRemoteActionTimeoutMs(args: readonly unknown[]): number | null {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  const domain = request?.domain;
  const action = request?.action;
  if (typeof domain !== "string" || typeof action !== "string") return null;
  return isRetryableRemoteAction(domain, action)
    ? REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS
    : null;
}

export function ipcInvokeTimeoutMs(channel: string, args: readonly unknown[] = []): number {
  if (channel === IPC.localRuntimeCallAction) {
    const payload = args[0];
    const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
    if (typeof request?.domain === "string" && typeof request.action === "string") {
      return localRuntimeActionIpcTimeoutMs(request.domain, request.action);
    }
    return LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS;
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
      return 4 * 60_000;
    case IPC.iosSimulatorLaunch:
      return 10 * 60_000;
    case IPC.transcriptionTranscribe:
      return 6 * 60_000;
    case IPC.iosSimulatorListLaunchTargets:
    case IPC.iosSimulatorGetScreenSnapshot:
    case IPC.iosSimulatorInspectPoint:
    case IPC.iosSimulatorSelectPoint:
    case IPC.iosSimulatorGetPreviewCapability:
    case IPC.iosSimulatorListPreviewTargets:
    case IPC.iosSimulatorResolvePreviewMatch:
    case IPC.iosSimulatorEnsurePreviewWorkspace:
    case IPC.iosSimulatorRenderCurrentPreview:
    case IPC.iosSimulatorRenderPreview:
      return 2 * 60_000;
    case IPC.iosSimulatorOpenPreviewWorkspace:
    case IPC.iosSimulatorScreenshot:
    case IPC.iosSimulatorStartStream:
    case IPC.iosSimulatorStopStream:
    case IPC.iosSimulatorShutdown:
    case IPC.iosSimulatorGetStreamStatus:
    case IPC.iosSimulatorGetWindowState:
    case IPC.iosSimulatorListWindowSources:
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
