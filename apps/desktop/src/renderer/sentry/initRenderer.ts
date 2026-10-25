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
import { toMegabytes } from "../../shared/sentry/diagnostics";

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
    // The window's state goes on before the hooks, so it is scrubbed with
    // the rest of the event.
    beforeSend: (event, hint) => hooks.beforeSend(addRendererState(event), hint),
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendSpan: hooks.beforeSendSpan,
  });
  connectSentry(Sentry);
  // No `process` tag here: the renderer's scope is merged into main's, where
  // it would overwrite main's own. The SDK tags each event's `event.process`.
}

/**
 * The window's own state at the moment of the error: its JavaScript heap
 * against its limit (a window close to the limit is about to be killed for
 * memory), the route, and how long it has been open. Main adds the rest.
 */
function addRendererState<T extends { contexts?: Record<string, unknown> }>(event: T): T {
  try {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    event.contexts = {
      ...(event.contexts ?? {}),
      renderer_state: {
        route: window.location.hash || window.location.pathname,
        openForSec: Math.round(performance.now() / 1000),
        visibility: document.visibilityState,
        ...(memory
          ? {
              heapUsedMb: toMegabytes(memory.usedJSHeapSize),
              heapTotalMb: toMegabytes(memory.totalJSHeapSize),
              heapLimitMb: toMegabytes(memory.jsHeapSizeLimit),
            }
          : {}),
        domNodes: document.getElementsByTagName("*").length,
      },
    };
  } catch {
    // Best effort.
  }
  return event;
}
