import { IPC } from "../shared/ipc";
import type { OrchestrationEventPayload } from "../shared/types/orchestration";

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeListener: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => unknown;
};

export type OrchestrationBridgeDeps = {
  /**
   * Route an orchestration action through the daemon (remote → local), falling
   * back to the desktop-main IPC handler when no runtime is bound (in-process /
   * test mode). `ipcChannel` is the legacy fallback handler.
   */
  callAction: (action: string, args: unknown, ipcChannel: string) => Promise<unknown>;
  /**
   * Register a callback fed by the daemon runtime event stream (category
   * "orchestrator"). Returns an unregister function.
   */
  subscribeRuntimeOrchestrationEvents: (
    cb: (payload: OrchestrationEventPayload) => void,
  ) => () => void;
  ipcRenderer: IpcRendererLike;
};

export function createOrchestrationBridge(deps: OrchestrationBridgeDeps) {
  const { callAction, subscribeRuntimeOrchestrationEvents, ipcRenderer } = deps;
  return {
    runCreate: (args: unknown) =>
      callAction("runCreate", args, IPC.orchestrationRunCreate),
    bundleRead: (args: unknown) =>
      callAction("bundleRead", args, IPC.orchestrationBundleRead),
    manifestReadSection: (args: unknown) =>
      callAction("manifestReadSection", args, IPC.orchestrationManifestReadSection),
    manifestPatch: (args: unknown) =>
      callAction("manifestPatch", args, IPC.orchestrationManifestPatch),
    planAppend: (args: unknown) =>
      callAction("planAppend", args, IPC.orchestrationPlanAppend),
    planWrite: (args: unknown) =>
      callAction("planWrite", args, IPC.orchestrationPlanWrite),
    spawnAgent: (args: unknown) =>
      callAction("spawnAgent", args, IPC.orchestrationSpawnAgent),
    agentInject: (args: unknown) =>
      callAction("agentInject", args, IPC.orchestrationAgentInject),
    assetRegister: (args: unknown) =>
      callAction("assetRegister", args, IPC.orchestrationAssetRegister),
    claimTask: (args: unknown) =>
      callAction("claimTask", args, IPC.orchestrationClaimTask),
    releaseTask: (args: unknown) =>
      callAction("releaseTask", args, IPC.orchestrationReleaseTask),
    runList: (args: unknown = {}) =>
      callAction("runList", args, IPC.orchestrationRunList),
    subscribe: (
      args: { runId: string; laneId?: string },
      callback: (payload: unknown) => void,
    ): (() => void) => {
      // Daemon-routed runtime event stream (runtime-backed / production mode).
      const unsubscribeRuntime = subscribeRuntimeOrchestrationEvents((payload) => {
        if (payload.runId === args.runId) callback(payload);
      });
      // Legacy desktop-main broadcast (in-process / test mode).
      const listener = (_evt: unknown, payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const runId = (payload as { runId?: string }).runId;
        if (runId === args.runId) callback(payload);
      };
      ipcRenderer.on(IPC.orchestrationEvent, listener);
      // Ensure the run bundle is loaded/subscribed on whichever backend handles it.
      void callAction("subscribe", args, IPC.orchestrationSubscribe).catch(() => undefined);
      return () => {
        unsubscribeRuntime();
        ipcRenderer.removeListener(IPC.orchestrationEvent, listener);
        void callAction(
          "unsubscribe",
          { runId: args.runId },
          IPC.orchestrationUnsubscribe,
        ).catch(() => undefined);
      };
    },
  };
}
