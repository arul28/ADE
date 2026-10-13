/**
 * Sentry in the desktop renderer.
 *
 * The renderer SDK has no DSN of its own: events travel to the main process
 * over the IPC bridge the preload installs, and main's client (release,
 * environment, scrubbing, budget) sends them. Main decides whether Sentry is
 * on; when it is off the preload installs no bridge and this does nothing.
 * Only the Electron renderer loads this; the web client has its own init
 * (`webclient/sentry.ts`) and the browser mock loads neither.
 */
import * as Sentry from "@sentry/electron/renderer";
import { connectSentry } from "../../shared/sentry/capture";
import { createSentryEventHooks } from "../../shared/sentry/eventFilter";
import { SENTRY_TRACES_SAMPLE_RATE } from "../../shared/sentry/config";

export function initRendererSentry(): void {
  const hooks = createSentryEventHooks();
  Sentry.init({
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Never add trace headers to provider, GitHub or other third-party requests.
    tracePropagationTargets: [],
    integrations: (defaults) => [
      ...defaults,
      Sentry.browserTracingIntegration(),
    ],
    beforeSend: hooks.beforeSend,
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendSpan: hooks.beforeSendSpan,
  });
  connectSentry(Sentry);
  // No `process` tag here: the renderer's scope is merged into main's, where
  // it would overwrite main's own. The SDK tags each event's `event.process`.
}
