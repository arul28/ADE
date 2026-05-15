import { IPC } from "../../../shared/ipc";

function isRuntimeLaneDeleteAction(args: unknown[] | undefined): boolean {
  const first = args?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return false;
  const request = (first as { request?: unknown }).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const record = request as { domain?: unknown; action?: unknown };
  return record.domain === "lane" && record.action === "delete";
}

export function ipcInvokeTimeoutMs(channel: string, args?: unknown[]): number {
  switch (channel) {
    case IPC.lanesDelete:
      return 4 * 60_000;
    case IPC.localRuntimeCallAction:
    case IPC.remoteRuntimeCallAction:
      if (isRuntimeLaneDeleteAction(args)) return 4 * 60_000;
      return 30_000;
    case IPC.iosSimulatorLaunch:
      return 10 * 60_000;
    case IPC.macosVmProvision:
      return 120 * 60_000;
    case IPC.macosVmStart:
    case IPC.macosVmStop:
    case IPC.macosVmDelete:
      return 2 * 60_000;
    case IPC.macosVmCaptureScreenshot:
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
