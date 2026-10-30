/**
 * Sentry in the Electron main process.
 *
 * Covers main itself (uncaught exceptions, unhandled rejections, logger
 * warnings and errors), the renderer (its events arrive here over IPC, so the
 * packaged CSP never has to allow Sentry's host), native crashes of every
 * Electron process as minidumps, unresponsive windows, renderer freezes, and
 * child processes that die. Must run after `app.setPath("userData")`, because
 * the offline queue and the crash dumps live there, and before `app` is ready.
 */
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import { resolveReleaseChannel } from "../../shared/packageChannel";
import { connectSentry } from "../../shared/sentry/capture";
import {
  resolveSentryDsn,
  resolveSentryEnvironment,
  SENTRY_DATA_COLLECTION,
  sentryDist,
  sentryReleaseName,
  SENTRY_TRACES_SAMPLE_RATE,
  shouldEnableSentry,
} from "../../shared/sentry/config";
import { createSentryEventHooks } from "../../shared/sentry/eventFilter";
import { registerDesktopSentryDiagnostics } from "./desktopDiagnostics";
import { installIpcErrorCapture } from "./ipcCapture";
import { sentryMachineContext, sentryProcessTags, startNodeSentryDiagnostics } from "./machineContext";
import { hasPriorTelemetryOptOut } from "./priorOptOut";

let started = false;

/** Integrations ADE leaves out: local variables can hold anything, and ADE wires its own preload. */
const EXCLUDED_INTEGRATIONS = /^(?:LocalVariables|PreloadInjection|Screenshots)/;

export function initMainSentry(options: {
  /** Names an IPC call for its issue and breadcrumb; see `installIpcErrorCapture`. */
  ipcLabel: (channel: string, args: readonly unknown[]) => string;
}): boolean {
  if (started) return true;
  const packaged = app.isPackaged;
  if (!shouldEnableSentry({ env: process.env, packaged, priorOptOut: hasPriorTelemetryOptOut() })) return false;
  started = true;
  const hooks = createSentryEventHooks();
  const releaseChannel = resolveReleaseChannel({ env: process.env, packaged, version: app.getVersion() });
  Sentry.init({
    dsn: resolveSentryDsn("desktop", process.env),
    release: sentryReleaseName(app.getVersion()),
    environment: resolveSentryEnvironment({ env: process.env, packaged, version: app.getVersion() }),
    dist: sentryDist(process.platform, process.arch),
    // Classic IPC: no custom protocol scheme, and only ADE's own preload
    // carries the bridge (see `src/preload/preload.ts`).
    ipcMode: Sentry.IPCMode.Classic,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Never add trace headers to provider, GitHub or other third-party requests.
    tracePropagationTargets: [],
    sendClientReports: true,
    maxBreadcrumbs: 100,
    dataCollection: SENTRY_DATA_COLLECTION,
    integrations: (defaults) => defaults.filter((integration) => !EXCLUDED_INTEGRATIONS.test(integration.name)),
    beforeSend: hooks.beforeSend,
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendSpan: hooks.beforeSendSpan,
    beforeSendLog: hooks.beforeSendLog,
  });
  connectSentry(Sentry);
  Sentry.setTags(sentryProcessTags({ processName: "main", surface: "desktop", releaseChannel }));
  Sentry.setContext("machine", { ...sentryMachineContext(), locale: app.getLocale?.() ?? null });
  startNodeSentryDiagnostics();
  registerDesktopSentryDiagnostics();
  installIpcErrorCapture(options.ipcLabel);
  return true;
}

export function isMainSentryStarted(): boolean {
  return started;
}
