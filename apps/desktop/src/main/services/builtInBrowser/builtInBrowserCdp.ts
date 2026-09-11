import type { WebContents } from "electron";

/**
 * The one way ADE evaluates an expression inside a browser tab.
 *
 * Three call sites grew the same six lines independently — the agent DOM
 * collector and the element-map overlay in `builtInBrowserService.ts`, and the
 * focused-element scripts in `builtInBrowserTabCapabilities.ts` — differing only
 * in the expression they build and the sentence they throw. That is a fork
 * waiting to happen the next time evaluation needs a timeout, an
 * `executionContextId`, or a retry, so it lives here instead: a plain function
 * of the two debugger primitives, importable from either side of the
 * service/capability seam without an import cycle.
 */

export type CdpRuntimeEvaluateResponse = {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: unknown;
};

export type BuiltInBrowserCdpEvaluateDeps = {
  sendDebuggerCommand: <T = unknown>(
    wc: WebContents,
    command: string,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  withTemporaryDebugger: <T>(wc: WebContents, fn: () => Promise<T>) => Promise<T>;
};

/**
 * Evaluates `expression` in the tab and returns its value.
 *
 * `silent` keeps a thrown page-side error from pausing the debugger, so the
 * failure comes back as `exceptionDetails` and is reported with the caller's
 * own `failureMessage` — the page's message is never surfaced, because it is
 * attacker-controlled text on a page an agent was told to visit.
 */
export async function evaluateInTab(
  deps: BuiltInBrowserCdpEvaluateDeps,
  wc: WebContents,
  expression: string,
  failureMessage: string,
): Promise<unknown> {
  const response = await deps.withTemporaryDebugger(wc, async () => {
    await deps.sendDebuggerCommand(wc, "Runtime.enable");
    return deps.sendDebuggerCommand<CdpRuntimeEvaluateResponse>(wc, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
  });
  if (response.exceptionDetails) throw new Error(failureMessage);
  return response.result?.value;
}
