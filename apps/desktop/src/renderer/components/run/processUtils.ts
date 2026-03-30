import type { ProcessRuntime, ProcessRuntimeStatus } from "../../../shared/types";

const ACTIVE_STATUSES: ReadonlySet<ProcessRuntimeStatus> = new Set([
  "running",
  "starting",
  "degraded",
  "stopping",
]);

export function isActiveProcessStatus(status: ProcessRuntimeStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function hasInspectableProcessOutput(runtime: ProcessRuntime): boolean {
  return runtime.status !== "stopped" || runtime.startedAt != null || runtime.lastEndedAt != null || runtime.lastExitCode != null;
}

const TERMINAL_STATUSES: ReadonlySet<ProcessRuntimeStatus> = new Set(["crashed", "exited"]);

export function formatProcessStatus(runtime: Pick<ProcessRuntime, "status" | "lastExitCode">): string {
  if (TERMINAL_STATUSES.has(runtime.status) && runtime.lastExitCode != null) {
    return `${runtime.status}:${runtime.lastExitCode}`;
  }
  return runtime.status;
}
