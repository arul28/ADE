import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { ProductAnalyticsReplayConfig } from "../../../shared/types/productAnalytics";
import { isInternalInstall } from "../../sentry/priorOptOut";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import { resolveProductAnalyticsEndpoint, type ProductAnalyticsService } from "./productAnalyticsService";

/**
 * Hands this desktop window what it needs to record a session replay
 * (`renderer/lib/sessionReplay.ts`), or null while analytics is off.
 *
 * No remote pin: a replay records the window of THIS desktop app under this
 * computer's analytics consent, so it is never about a chat, lane, session or
 * another machine. It is an IPC and not a runtime action on purpose, so the
 * hosted web client, the phone and the CLI never receive it.
 */
export function registerSessionReplayIpc(args: {
  analytics: Pick<ProductAnalyticsService, "getDistinctId">;
  appVersion: string;
  releaseChannel: string;
  logger: { warn: (event: string, data: Record<string, unknown>) => void };
}): void {
  ipcMain.handle(IPC.analyticsGetReplayConfig, async (event): Promise<ProductAnalyticsReplayConfig | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, args.logger, IPC.analyticsGetReplayConfig)) return null;
    // Null unless events are being sent: analytics off, DO_NOT_TRACK, or an
    // unconfigured build all answer null here.
    // ADE's own machines are never recorded. The project's linked recording
    // flag also skips internal accounts once signed in; the install marker
    // covers a machine before sign-in.
    if (isInternalInstall()) return null;
    const distinctId = args.analytics.getDistinctId();
    const endpoint = resolveProductAnalyticsEndpoint();
    if (!distinctId || !endpoint) return null;
    return {
      projectToken: endpoint.token,
      apiHost: endpoint.host,
      distinctId,
      appVersion: args.appVersion,
      releaseChannel: args.releaseChannel,
    };
  });
}

/**
 * The origins a recording talks to, for the renderer's `connect-src`: the
 * capture host (recordings go to `/s/`) and, for PostHog Cloud, its assets
 * host (the project's replay settings come from `/array/<token>/config`
 * there). Empty in a build with no PostHog token.
 */
export function sessionReplayConnectSources(): string[] {
  const endpoint = resolveProductAnalyticsEndpoint();
  if (!endpoint) return [];
  const sources = [endpoint.host];
  const cloud = /^https:\/\/(us|eu)\.i\.posthog\.com$/i.exec(endpoint.host);
  if (cloud) sources.push(`https://${cloud[1]!.toLowerCase()}-assets.i.posthog.com`);
  return sources;
}
