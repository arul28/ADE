import { IPC } from "../../../shared/ipc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const RUNTIME_ACTION_CHANNEL: Record<string, Record<string, string>> = {
  macos_vm: {
    provision: IPC.macosVmProvision,
    start: IPC.macosVmStart,
    stop: IPC.macosVmStop,
    restart: IPC.macosVmRestart,
    delete: IPC.macosVmDelete,
    wipe: IPC.macosVmWipe,
    installRuntime: IPC.macosVmInstallRuntime,
    focusWindow: IPC.macosVmFocusWindow,
    click: IPC.macosVmClick,
    selectPoint: IPC.macosVmSelectPoint,
    typeText: IPC.macosVmTypeText,
    captureScreenshot: IPC.macosVmCaptureScreenshot,
  },
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
  },
};

const LOCAL_RUNTIME_PROJECT_SETUP_TIMEOUT_MS = 150_000;
const REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS = 75_000;

const RETRYABLE_REMOTE_ACTION_PREFIXES = [
  "diagnosticsGet",
  "get",
  "list",
  "oauthGet",
  "oauthList",
  "portGet",
  "portList",
  "proxyGet",
  "read",
  "search",
] as const;

const RETRYABLE_REMOTE_ACTIONS = new Set([
  "chat.codexFuzzyFileSearch",
  "chat.fileSearch",
  "chat.modelCatalog",
  "file.quickOpen",
  "terminal.activeForChat",
  "terminal.preview",
]);

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
  const actionKey = `${domain}.${action}`;
  if (RETRYABLE_REMOTE_ACTIONS.has(actionKey)) return REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS;
  return RETRYABLE_REMOTE_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
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
    case IPC.macosVmProvision:
    case IPC.macosVmStart:
    case IPC.macosVmRestart:
    case IPC.macosVmInstallRuntime:
      return 120 * 60_000;
    case IPC.macosVmStop:
      return 2 * 60_000;
    case IPC.macosVmDelete:
    case IPC.macosVmWipe:
      // wipe() and deleteVm() both call `runLume("delete", …)` with a
      // 10-minute internal budget. A shorter IPC ceiling would fire while
      // the lume process is still running, leaving the store record
      // unchanged (VM appears to still exist) but the underlying process
      // orphaned. Match the internal budget so the renderer sees the real
      // completion outcome.
      return 10 * 60_000;
    case IPC.macosVmCaptureScreenshot:
    case IPC.macosVmFocusWindow:
    case IPC.macosVmClick:
    case IPC.macosVmSelectPoint:
    case IPC.macosVmTypeText:
      return 60_000;
    case IPC.iosSimulatorListLaunchTargets:
    case IPC.iosSimulatorGetScreenSnapshot:
    case IPC.iosSimulatorInspectPoint:
    case IPC.iosSimulatorSelectPoint:
    case IPC.iosSimulatorGetPreviewCapability:
    case IPC.iosSimulatorListPreviewTargets:
    case IPC.iosSimulatorResolvePreviewMatch:
    case IPC.iosSimulatorEnsurePreviewWorkspace:
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
