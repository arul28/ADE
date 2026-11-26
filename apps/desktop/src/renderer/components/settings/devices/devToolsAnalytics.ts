/**
 * One coarse fact per developer-tools cleanup the person runs from Settings
 * (`ade_feature_used`, feature "storage_doctor"): which kind, whether it
 * worked, and how many bytes came back. Never a name, path, udid or machine.
 * Deduped per action and outcome for an hour, so at most 192 a day.
 */
export type DevToolsCleanupAction = "simulator_deleted" | "runtime_removed" | "build_data_deleted" | "emulator_deleted";

export function captureDevToolsCleanup(action: DevToolsCleanupAction, outcome: "completed" | "failed", bytesFreed?: number | null): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: {
      feature: "storage_doctor",
      action,
      outcome,
      source: "renderer_route",
      ...(outcome === "completed" && bytesFreed != null && bytesFreed > 0 ? { bytes_freed: Math.round(bytesFreed) } : {}),
    },
    dedupeKey: `dev_tools_cleanup:${action}:${outcome}`,
    minimumIntervalMs: 60 * 60_000,
  }).catch(() => undefined);
}
