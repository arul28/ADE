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
import os from "node:os";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import {
  resolveSentryDsn,
  resolveSentryEnvironment,
  sentryDist,
  sentryReleaseName,
  SENTRY_TRACES_SAMPLE_RATE,
  shouldEnableSentry,
} from "../../shared/sentry/config";
import { createSentryEventHooks } from "../../shared/sentry/eventFilter";
import { installIpcErrorCapture } from "./ipcCapture";

let started = false;

/** Integrations ADE leaves out: local variables can hold anything, and ADE wires its own preload. */
const EXCLUDED_INTEGRATIONS = /^(?:LocalVariables|PreloadInjection|Screenshots)/;

export function initMainSentry(): boolean {
  if (started) return true;
  const packaged = app.isPackaged;
  if (!shouldEnableSentry({ env: process.env, packaged })) return false;
  started = true;
  const hooks = createSentryEventHooks();
  Sentry.init({
    dsn: resolveSentryDsn("desktop", process.env),
    release: sentryReleaseName(app.getVersion()),
    environment: resolveSentryEnvironment({ env: process.env, packaged }),
    dist: sentryDist(process.platform, process.arch),
    // Classic IPC: no custom protocol scheme, and only ADE's own preload
    // carries the bridge (see `src/preload/preload.ts`).
    ipcMode: Sentry.IPCMode.Classic,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Never add trace headers to provider, GitHub or other third-party requests.
    tracePropagationTargets: [],
    sendClientReports: true,
    maxBreadcrumbs: 100,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    integrations: (defaults) => defaults.filter((integration) => !EXCLUDED_INTEGRATIONS.test(integration.name)),
    beforeSend: hooks.beforeSend,
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendLog: hooks.beforeSendLog,
  });
  Sentry.setTags({
    process: "main",
    "os.release": os.release(),
    arch: process.arch,
    "package.channel": process.env.ADE_PACKAGE_CHANNEL || "stable",
  });
  Sentry.setContext("machine", {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    locale: app.getLocale?.() ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  installIpcErrorCapture();
  return true;
}

export function isMainSentryStarted(): boolean {
  return started;
}
