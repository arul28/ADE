/* eslint-disable @typescript-eslint/no-explicit-any */

type BridgeHealth = {
  ok: true;
  projectRoot: string;
  socketPath: string;
  projectId: string;
  runtimeVersion: string | null;
  projectName: string;
};

type BridgeEnvelope<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

const BRIDGE_HEALTH_PATH = "/ade-dev-rpc/health";
const BRIDGE_PROBE_TIMEOUT_MS = 1500;

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/ade-dev-rpc${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as BridgeEnvelope<T>;
  if (!payload.ok) {
    throw new Error(payload.error ?? "Browser runtime bridge request failed.");
  }
  return payload.result as T;
}

async function probeBridgeHealth(): Promise<BridgeHealth | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), BRIDGE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(BRIDGE_HEALTH_PATH, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as BridgeHealth;
    return payload.ok === true ? payload : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function mergeProjectFromHealth(health: BridgeHealth, existing: any) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    id: health.projectId,
    name: health.projectName,
    rootPath: health.projectRoot,
  };
}

function patchSyncMethods(ade: any) {
  ade.sync.getStatus = async (args?: Record<string, unknown>) =>
    bridgePost("/sync", { method: "sync.getStatus", params: args ?? {} });
  ade.sync.refreshDiscovery = async () =>
    bridgePost("/sync", { method: "sync.refreshDiscovery" });
  ade.sync.listDevices = async () =>
    bridgePost("/sync", { method: "sync.listDevices" });
  ade.sync.updateLocalDevice = async (args: Record<string, unknown>) =>
    bridgePost("/sync", { method: "sync.updateLocalDevice", params: args });
  ade.sync.connectToBrain = async (draft: Record<string, unknown>) =>
    bridgePost("/sync", { method: "sync.connectToBrain", params: draft });
  ade.sync.disconnectFromBrain = async () =>
    bridgePost("/sync", { method: "sync.disconnectFromBrain" });
  ade.sync.forgetDevice = async (deviceId: string) =>
    bridgePost("/sync", { method: "sync.forgetDevice", params: { deviceId } });
  ade.sync.getTransferReadiness = async () =>
    bridgePost("/sync", { method: "sync.getTransferReadiness" });
  ade.sync.transferBrainToLocal = async () =>
    bridgePost("/sync", { method: "sync.transferBrainToLocal" });
  ade.sync.getPin = async () =>
    bridgePost("/sync", { method: "sync.getPin" });
  ade.sync.setPin = async (pin: string) =>
    bridgePost("/sync", { method: "sync.setPin", params: { pin } });
  ade.sync.generatePin = async () =>
    bridgePost("/sync", { method: "sync.generatePin" });
  ade.sync.clearPin = async () =>
    bridgePost("/sync", { method: "sync.clearPin" });
}

function patchLinearMethods(ade: any) {
  ade.cto.getLinearConnectionStatus = async () =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "getConnectionStatus" });
  ade.cto.getLinearQuickView = async () =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "getQuickView" });
  ade.cto.getLinearIssuePickerData = async () =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "getIssuePickerData" });
  ade.cto.searchLinearIssues = async (args: Record<string, unknown> = {}) =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "searchIssues", args });
  ade.cto.getLinearIssueComments = async (args: Record<string, unknown> = {}) =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "fetchIssueComments", args });
  ade.cto.getLinearProjects = async () =>
    bridgePost("/action", { domain: "linear_issue_tracker", action: "listProjects" });
  ade.cto.setLinearToken = async (args: { token: string }) => {
    await bridgePost("/action", {
      domain: "linear_credentials",
      action: "setToken",
      arg: args.token,
    });
    return bridgePost("/action", {
      domain: "linear_issue_tracker",
      action: "getConnectionStatus",
    });
  };
  ade.cto.clearLinearToken = async () => {
    await bridgePost("/action", { domain: "linear_credentials", action: "clearToken" });
    return bridgePost("/action", {
      domain: "linear_issue_tracker",
      action: "getConnectionStatus",
    });
  };
}

function patchLaneMethods(ade: any) {
  ade.lanes.create = async (args: Record<string, unknown>) =>
    bridgePost("/lane", { action: "create", args });
  ade.lanes.list = async (args: Record<string, unknown> = {}) =>
    bridgePost("/lane", { action: "list", args });
}

export async function attachBrowserRuntimeBridge(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const w = window as any;
  if (!w.__adeBrowserMock || w.__adeRuntimeBridge) return false;

  const health = await probeBridgeHealth();
  if (!health) return false;

  const ade = w.ade;
  if (!ade || typeof ade !== "object") return false;

  const project = mergeProjectFromHealth(health, ade.app?.getProject ? await ade.app.getProject().catch(() => null) : null);

  ade.app.getProject = async () => project;
  ade.app.getWindowSession = async () => ({
    windowId: 1,
    project,
    binding: {
      kind: "local",
      key: `local:${health.projectRoot}`,
      rootPath: health.projectRoot,
      displayName: health.projectName,
    },
    openProjectTabs: [project],
  });

  if (ade.sync && typeof ade.sync === "object") patchSyncMethods(ade);
  if (ade.cto && typeof ade.cto === "object") patchLinearMethods(ade);
  if (ade.lanes && typeof ade.lanes === "object") patchLaneMethods(ade);

  w.__adeRuntimeBridge = true;
  window.dispatchEvent(
    new CustomEvent("ade:runtime-bridge-ready", {
      detail: { projectRoot: health.projectRoot },
    }),
  );
  console.info(
    `[ADE] Browser runtime bridge attached for ${health.projectRoot}`,
  );
  return true;
}
