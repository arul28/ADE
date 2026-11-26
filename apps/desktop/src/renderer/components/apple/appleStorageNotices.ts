import type { AppleDeviceCleanupResult, AppleRuntimeDeleteResult } from "../../../shared/types/iosSimulator";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";

/**
 * The toasts for cleaning up simulators and removing runtimes, shared by the
 * Apple pane's picker and Settings › Apple devices, so both say the same.
 */

/** The Clean up toast's tone and words: what happened, per docs/design/notices.md. */
export function cleanupNotice(input: { listUnreadable: boolean; deviceErrors: number; summary: string | null }): {
  tone: "success" | "warning" | "error";
  title: string;
  message?: string;
} {
  if (input.listUnreadable) {
    return { tone: "error", title: "Could not read the simulator list", message: "Nothing was cleaned up. The ADE log has the details." };
  }
  if (input.deviceErrors) {
    return {
      tone: input.summary ? "warning" : "error",
      title: input.summary ?? "Simulators were not cleaned up",
      message: `${input.deviceErrors} could not be cleaned up yet. The ADE log has the details.`,
    };
  }
  return { tone: "success", title: input.summary ?? "No simulators to clean up" };
}

/** Why Clean up powered nothing off, in the words the toast uses. */
export const CLEANUP_SKIP_REASON: Record<NonNullable<AppleDeviceCleanupResult["powerOffSkipped"]>, string> = {
  "simulator-app-open": "Simulator.app is open, so nothing was powered off.",
  "process-list-unavailable": "ADE could not check what uses the devices, so nothing was powered off.",
};

/** What a runtime remove did, as one toast. Counts only; the details are in the log. */
export function showRuntimeRemoval(result: AppleRuntimeDeleteResult) {
  const freed = result.deleted.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const parts = [
    result.deleted.length ? `removed ${result.deleted.map((entry) => entry.name).join(", ")}` : null,
    result.moved.length ? `moved ${result.moved.length} simulator${result.moved.length === 1 ? "" : "s"}` : null,
    result.erased.length ? `erased ${result.erased.length}` : null,
  ].filter(Boolean);
  const failed = result.errors.length > 0;
  showToast({
    id: "apple-runtime-remove",
    tone: failed ? "warning" : "success",
    title: failed
      ? (result.deleted.length ? "Some runtimes were not removed" : "The runtime was not removed")
      : `Freed ${(freed / 1e9).toFixed(1)} GB`,
    message: [parts.length ? `${parts.join(", ")}.` : null, failed ? result.errors[0]!.message : null].filter(Boolean).join(" "),
    ...(failed ? { durationMs: READABLE_TOAST_DURATION_MS } : {}),
  });
}
