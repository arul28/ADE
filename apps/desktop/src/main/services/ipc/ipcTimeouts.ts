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
};

function runtimeActionTimeoutMs(args: readonly unknown[]): number | null {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  if (typeof request?.domain !== "string" || typeof request.action !== "string") return null;
  const channel = RUNTIME_ACTION_CHANNEL[request.domain]?.[request.action];
  return channel ? ipcInvokeTimeoutMs(channel) : null;
}

export function ipcInvokeTimeoutMs(channel: string, args: readonly unknown[] = []): number {
  if (channel === IPC.localRuntimeCallAction || channel === IPC.remoteRuntimeCallAction) {
    const actionTimeoutMs = runtimeActionTimeoutMs(args);
    if (actionTimeoutMs != null) return actionTimeoutMs;
    return 30_000;
  }
  switch (channel) {
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
