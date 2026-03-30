import type { ProcessRuntime, ProcessRuntimeStatus } from "../../../shared/types";

export function isActiveProcessStatus(status: ProcessRuntimeStatus): boolean {
  return status === "running" || status === "starting" || status === "degraded" || status === "stopping";
}

export function hasInspectableProcessOutput(runtime: ProcessRuntime): boolean {
  return runtime.status !== "stopped" || runtime.startedAt != null || runtime.lastEndedAt != null || runtime.lastExitCode != null;
}

export function formatProcessStatus(runtime: Pick<ProcessRuntime, "status" | "lastExitCode">): string {
  if ((runtime.status === "crashed" || runtime.status === "exited") && runtime.lastExitCode != null) {
    return `${runtime.status}:${runtime.lastExitCode}`;
  }
  return runtime.status;
}
