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
  /**
   * Validate a raw legacy-broadcast payload against the shared union before it
   * reaches subscribers, mirroring the guard the runtime stream already applies
   * so both delivery paths honour the same contract.
   */
  parseLegacyEvent: (payload: unknown) => OrchestrationEventPayload | null;
  ipcRenderer: IpcRendererLike;
};

export function createOrchestrationBridge(deps: OrchestrationBridgeDeps) {
  const { callAction, subscribeRuntimeOrchestrationEvents, parseLegacyEvent, ipcRenderer } = deps;
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
      callback: (payload: OrchestrationEventPayload) => void,
    ): (() => void) => {
      // The daemon stream (runtime-backed / production) and the legacy
      // desktop-main broadcast (in-process / test) are mutually exclusive per
      // mode, yet both listeners are attached here. Latch onto whichever source
      // delivers first and ignore the other, so an event is never applied twice.
      let activeSource: "runtime" | "legacy" | null = null;
      const deliver = (source: "runtime" | "legacy", payload: OrchestrationEventPayload) => {
        if (activeSource === null) activeSource = source;
        if (activeSource !== source) return;
        if (payload.runId === args.runId) callback(payload);
      };
      // Daemon-routed runtime event stream (runtime-backed / production mode).
      const unsubscribeRuntime = subscribeRuntimeOrchestrationEvents((payload) => {
        deliver("runtime", payload);
      });
      // Legacy desktop-main broadcast (in-process / test mode); validate against
      // the shared union so the fallback honours the same contract.
      const listener = (_evt: unknown, payload: unknown) => {
        const parsed = parseLegacyEvent(payload);
        if (parsed) deliver("legacy", parsed);
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
