import { app, ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { AppBundleOwnershipStatus } from "../../../shared/types/appBundleOwnership";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import { createAppBundleOwnershipService } from "./appBundleOwnership";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";

type Logger = { info(event: string, data?: Record<string, unknown>): void; warn(event: string, data?: Record<string, unknown>): void };

/**
 * Wires the app-bundle ownership check to IPC.
 *
 * No remote pin: this is about the ADE.app installed on THIS computer, the one
 * the window runs from. Another machine's bundle is updated by that machine's
 * own ADE, so there is nothing to route.
 */
/** The fix's outcome as analytics records it; nothing to fix records nothing. */
const FIX_ANALYTICS_OUTCOME = {
  fixed: "completed",
  still_root_owned: "partial",
  cancelled: "cancelled",
  failed: "failed",
} as const;

export function registerAppBundleOwnershipIpc(
  args: { logger?: Logger; analytics?: Pick<ProductAnalyticsService, "captureInternal"> | null } = {},
): void {
  const service = createAppBundleOwnershipService({
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
  });
  const logger = args.logger ?? { warn: () => {} };
  let lastLoggedState: string | null = null;

  const logStatus = (status: AppBundleOwnershipStatus) => {
    if (status.state === lastLoggedState) return;
    lastLoggedState = status.state;
    if (status.state === "needs_fix") {
      args.logger?.warn("app_bundle_ownership.needs_fix", {
        bundlePath: status.bundlePath,
        problemPaths: status.problemPaths,
        ownerName: status.ownerName,
        parentWritable: status.parentWritable,
      });
    } else if (status.state === "unknown") {
      args.logger?.warn("app_bundle_ownership.unknown", { bundlePath: status.bundlePath, reason: status.reason });
    }
  };

  ipcMain.handle(IPC.appBundleOwnershipGetStatus, async (event, options: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.appBundleOwnershipGetStatus)) {
      throw new Error("This check is only available to the ADE window.");
    }
    const refresh = Boolean(options && typeof options === "object" && (options as { refresh?: unknown }).refresh === true);
    const status = await service.getStatus({ refresh });
    logStatus(status);
    return status;
  });

  ipcMain.handle(IPC.appBundleOwnershipFix, async (event) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.appBundleOwnershipFix)) {
      throw new Error("This fix is only available to the ADE window.");
    }
    const result = await service.fix();
    const meta = {
      outcome: result.outcome,
      detail: result.detail,
      state: result.status.state,
      problemPaths: result.status.problemPaths,
    };
    if (result.outcome === "failed") logger.warn("app_bundle_ownership.fix", meta);
    else args.logger?.info("app_bundle_ownership.fix", meta);
    if (result.outcome !== "not_applicable") {
      const outcome = FIX_ANALYTICS_OUTCOME[result.outcome];
      // One press of a rare button; the dedupe holds a retry loop to one an hour per outcome.
      args.analytics?.captureInternal({
        event: "ade_feature_used",
        surface: "desktop",
        properties: { feature: "updates", action: "bundle_ownership_fix", outcome },
        dedupeKey: `bundle_ownership_fix:${outcome}`,
        minimumIntervalMs: 60 * 60_000,
      });
    }
    logStatus(result.status);
    return result;
  });
}
