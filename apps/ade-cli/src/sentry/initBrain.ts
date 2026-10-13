/**
 * Sentry in the brain (`ade serve`), whether the desktop app started it or it
 * runs as a background service or on a remote machine.
 *
 * The brain outlives the desktop window and hosts every chat, terminal and
 * sync connection, so it reports on its own (project `ade-brain`) rather than
 * through the app. Uncaught exceptions and unhandled rejections are captured
 * by the SDK; ADE's logger mirrors its warnings and errors through
 * `logBridge`; the action endpoint and the provider paths add their own
 * reports. Off in source checkouts and tests (see `shared/sentry/config.ts`).
 */
import os from "node:os";
import * as Sentry from "@sentry/node";
import {
  resolveSentryDsn,
  resolveSentryEnvironment,
  sentryDist,
  sentryReleaseName,
  SENTRY_TRACES_SAMPLE_RATE,
  shouldEnableSentry,
} from "../../../desktop/src/shared/sentry/config";
import { createSentryEventHooks } from "../../../desktop/src/shared/sentry/eventFilter";
import { isSourceCheckoutRuntimeModule } from "../runtimePackaging";

declare const __ADE_VERSION__: string | undefined;

function currentModulePath(): string {
  return typeof __filename === "string" ? __filename : process.argv[1] ?? "";
}

let started = false;

/** Local variables can hold anything; ADE never sends them. */
const EXCLUDED_INTEGRATIONS = /^(?:LocalVariables)/;

export function initBrainSentry(args: { mode: "serve" | "service" }): boolean {
  if (started) return true;
  // Decided from where this bundle runs, not from ADE_RUNTIME_PACKAGED: a dev
  // brain started from an installed ADE's terminal inherits that variable and
  // would otherwise report as production.
  const packaged = !isSourceCheckoutRuntimeModule(currentModulePath());
  if (!shouldEnableSentry({ env: process.env, packaged })) return false;
  started = true;
  const version = typeof __ADE_VERSION__ === "string" ? __ADE_VERSION__ : null;
  const hooks = createSentryEventHooks();
  Sentry.init({
    dsn: resolveSentryDsn("brain", process.env),
    release: sentryReleaseName(version),
    environment: resolveSentryEnvironment({ env: process.env, packaged }),
    dist: sentryDist(process.platform, process.arch),
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Never add trace headers to provider, GitHub or other third-party requests.
    tracePropagationTargets: [],
    sendClientReports: true,
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
    process: "brain",
    "brain.mode": args.mode,
    "os.release": os.release(),
    arch: process.arch,
    "package.channel": process.env.ADE_PACKAGE_CHANNEL || "stable",
    "brain.host": process.env.ELECTRON_RUN_AS_NODE === "1" ? "electron" : "node",
  });
  Sentry.setContext("machine", {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    nodeVersion: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return true;
}
