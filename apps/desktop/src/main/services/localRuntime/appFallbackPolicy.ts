import type { LocalRuntimeStatus } from "../../../shared/types";
import { isBackgroundItemBlocked } from "../../../shared/types/core";
import type { AdeRecoveryErrorCode } from "../../../shared/types/recovery";

export type AppFallbackReason = NonNullable<LocalRuntimeStatus["appFallback"]>["reason"];

/**
 * Failures the brain itself would hit. A brain the desktop starts on its own
 * opens the same database on the same disk, so running one would only fail
 * again; these keep the recovery screen instead.
 */
export const APP_FALLBACK_REFUSED_FAILURES: ReadonlySet<AdeRecoveryErrorCode> = new Set<AdeRecoveryErrorCode>([
  "disk_full",
  "insufficient_headroom",
  "db_integrity",
  "storage_read_failed",
  "migration_incomplete",
  "migration_unknown_state",
]);

/**
 * Why the service manager could not run the brain, when it is a reason a
 * desktop-owned brain can work around; null when it is not.
 */
export function appFallbackReason(
  status: Pick<LocalRuntimeStatus, "serviceInstall" | "serviceHealth">,
): AppFallbackReason | null {
  const install = status.serviceInstall;
  // The installer proved the predecessor is still alive. Keep its socket
  // exclusive even if it has not answered a client yet.
  if (install.failureStep === "predecessor_exit") return null;
  switch (install.failureStep) {
    case "replacement_pid":
    case "replacement_responsive":
    case "launchd_register":
      return install.failureStep;
  }
  if (isBackgroundItemBlocked(status)) return "background_item_blocked";
  if (status.serviceHealth.state === "not_installed") return "service_not_registered";
  if (install.state === "failed") return "service_install_failed";
  if (install.state === "installed" && status.serviceHealth.running === false) return "service_not_running";
  return null;
}
