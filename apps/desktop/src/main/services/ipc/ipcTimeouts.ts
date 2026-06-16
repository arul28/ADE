import { IPC } from "../../../shared/ipc";
import { isRetryableRemoteAction } from "../remoteRuntime/retryableRemoteActions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const RUNTIME_ACTION_CHANNEL: Record<string, Record<string, string>> = {
  lane: {
    create: IPC.lanesCreate,
    createChild: IPC.lanesCreateChild,
    createFromUnstaged: IPC.lanesCreateFromUnstaged,
    importBranch: IPC.lanesImportBranch,
    delete: IPC.lanesDelete,
  },
  ios_simulator: {
    resolvePreviewMatch: IPC.iosSimulatorResolvePreviewMatch,
    ensurePreviewWorkspace: IPC.iosSimulatorEnsurePreviewWorkspace,
    renderCurrentPreview: IPC.iosSimulatorRenderCurrentPreview,
  },
};

const LOCAL_RUNTIME_PROJECT_SETUP_TIMEOUT_MS = 150_000;
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
    const actionTimeoutMs = runtimeActionTimeoutMs(args);
    if (actionTimeoutMs != null) return actionTimeoutMs;
    return LOCAL_RUNTIME_PROJECT_SETUP_TIMEOUT_MS;
  }
  if (channel === IPC.localRuntimeCallSync || channel === IPC.localRuntimeListActionRegistry || channel === IPC.localRuntimeStreamEvents) {
    return LOCAL_RUNTIME_PROJECT_SETUP_TIMEOUT_MS;
  }
  if (channel === IPC.remoteRuntimeCallAction) {
    const actionTimeoutMs = runtimeActionTimeoutMs(args);
    if (actionTimeoutMs != null) return actionTimeoutMs;
    const retryableActionTimeoutMs = retryableRemoteActionTimeoutMs(args);
    if (retryableActionTimeoutMs != null) return retryableActionTimeoutMs;
    return 30_000;
  }
  switch (channel) {
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
    case IPC.remoteRuntimeCheckLocalWork:
      return REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS;
    case IPC.lanesCreate:
    case IPC.lanesCreateChild:
    case IPC.lanesCreateFromUnstaged:
    case IPC.lanesImportBranch:
    case IPC.lanesDelete:
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
