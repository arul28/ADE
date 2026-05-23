import { IPC } from "../shared/ipc";

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeListener: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => unknown;
};

export function createOrchestrationBridge(ipcRenderer: IpcRendererLike) {
  return {
    runCreate: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationRunCreate, args),
    bundleRead: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationBundleRead, args),
    manifestReadSection: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationManifestReadSection, args),
    manifestPatch: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationManifestPatch, args),
    planAppend: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationPlanAppend, args),
    planWrite: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationPlanWrite, args),
    spawnAgent: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationSpawnAgent, args),
    agentInject: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationAgentInject, args),
    assetRegister: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationAssetRegister, args),
    claimTask: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationClaimTask, args),
    releaseTask: (args: unknown) =>
      ipcRenderer.invoke(IPC.orchestrationReleaseTask, args),
    runList: (args: unknown = {}) =>
      ipcRenderer.invoke(IPC.orchestrationRunList, args),
    subscribe: (
      args: { runId: string; laneId?: string },
      callback: (payload: unknown) => void,
    ): (() => void) => {
      const listener = (_evt: unknown, payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const runId = (payload as { runId?: string }).runId;
        if (runId === args.runId) callback(payload);
      };
      ipcRenderer.on(IPC.orchestrationEvent, listener);
      void ipcRenderer.invoke(IPC.orchestrationSubscribe, args).catch(() => undefined);
      return () => {
        ipcRenderer.removeListener(IPC.orchestrationEvent, listener);
        void ipcRenderer.invoke(IPC.orchestrationUnsubscribe, args).catch(() => undefined);
      };
    },
  };
}
