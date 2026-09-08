import type { WebContents } from "electron";

/**
 * The `found-in-page` waiter, lifted out of the browser service.
 *
 * This is the densest piece of hard-won Chromium knowledge in the browser
 * surface — an inverted `findNext` flag, a 400 ms debounce that silently
 * discards request ids, and a result that can be emitted synchronously before
 * `findInPage` has even returned the id to compare it against. It depends on
 * nothing in the 6k-line service closure except the `WebContents` and the tab's
 * waiter set, so it lives here where it can be read and tested on its own.
 */

/** The `Electron.Result` payload of a `found-in-page` event. */
export type BuiltInBrowserFindResult = {
  requestId: number;
  activeMatchOrdinal?: number;
  matches?: number;
  finalUpdate?: boolean;
};

/**
 * Cross-waiter adoption hooks. A find that is superseded inside Chromium's
 * short-query debounce never gets an answer for its own request id, so
 * in-flight waiters re-point at the request that replaced them.
 */
export type BuiltInBrowserFindWaiters = Set<(requestId: number) => void>;

export type AwaitFoundInPageArgs = {
  text: string;
  forward: boolean;
  matchCase: boolean;
  /** `false` (the default) clears the selection first, so the search restarts. */
  findNext: boolean;
  timeoutMs: number;
};

/**
 * Issue a find and resolve on the first result that belongs to it.
 *
 * Chromium streams `found-in-page`: incremental results first, and a
 * `finalUpdate` only once the whole document has been walked — which for a find
 * superseded by the next keystroke never arrives at all. Waiting for
 * `finalUpdate` therefore timed out on searches that had already produced
 * correct counts, so this resolves on the first result for the request and lets
 * later updates keep flowing as events.
 *
 * Resolves with the result and its request id; rejects only when the timeout
 * elapses with nothing at all, or when issuing the find throws.
 */
export function awaitFoundInPage(
  wc: WebContents,
  waiters: BuiltInBrowserFindWaiters,
  args: AwaitFoundInPageArgs,
): Promise<BuiltInBrowserFindResult> {
  return new Promise<BuiltInBrowserFindResult>((resolve, reject) => {
    let requestId: number | null = null;
    // A synchronous emit lands before `wc.findInPage` has even returned the id,
    // so hold that first result until there is an id to compare with.
    let pendingBeforeRequestId: BuiltInBrowserFindResult | null = null;
    let lastResult: BuiltInBrowserFindResult | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      const arrived = lastResult ?? pendingBeforeRequestId;
      finish();
      // Never surface a raw timeout when results actually arrived: the find bar
      // has counts on screen, and an error banner over working counts is the
      // bug this replaced.
      if (arrived) {
        resolve(arrived);
        return;
      }
      reject(new Error(`Timed out waiting for browser find results after ${args.timeoutMs}ms.`));
    }, args.timeoutMs);
    timer.unref?.();

    const listener = (_event: Electron.Event, found: Electron.Result): void => {
      if (requestId == null) {
        pendingBeforeRequestId = found;
        return;
      }
      if (found.requestId !== requestId) return;
      lastResult = found;
      finish();
      resolve(found);
    };

    function adoptRequestId(nextRequestId: number): void {
      if (settled) return;
      requestId = nextRequestId;
    }

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(adoptRequestId);
      try {
        wc.removeListener("found-in-page", listener);
      } catch {
        // ignore listener detach races
      }
    }

    try {
      wc.on("found-in-page", listener);
      // Electron's `findNext` is NOT "advance to the next match" — it is
      // assigned straight onto Chromium's `FindOptions::new_session`
      // (`dict.Get("findNext", &options->new_session)`), so `true` STARTS a
      // session and `false` continues one. Electron's own docs invert this.
      // Chromium then drops a continuation that has no live session
      // (`FindRequestManager::FindInternal` → `AdvanceQueue` and return)
      // without ever sending anything to the renderer: the request id comes
      // back, no `found-in-page` is emitted, and the caller sat there until the
      // 5s timeout. Verified live on Electron 41 — this path answers in ~3ms,
      // the old one never answered at all.
      //
      // So every find we issue starts a session. Blink resumes from the
      // document's current selection, which is what makes a repeat search
      // advance; clearing the selection first is therefore what "new search"
      // means (first match), and leaving it is "find next".
      if (!args.findNext) {
        try {
          wc.stopFindInPage("clearSelection");
        } catch {
          // A tab with no live find session throws nothing useful here.
        }
      }
      const issuedRequestId = wc.findInPage(args.text, {
        forward: args.forward,
        findNext: true,
        matchCase: args.matchCase,
      });
      requestId = issuedRequestId;
      // Chromium delays a new session for a query under 4 characters by 400ms,
      // and a second find inside that window RESETS the delayed task — the
      // earlier request id is discarded and never answered. A find bar being
      // typed into hits this constantly, so an in-flight waiter follows the
      // request that superseded it rather than waiting out its own timeout on a
      // request Chromium threw away.
      for (const adopt of waiters) adopt(issuedRequestId);
      waiters.add(adoptRequestId);
      // Replay a result that raced ahead of the request id. Read through a
      // callback so TypeScript does not narrow away the listener's write.
      const buffered = ((): BuiltInBrowserFindResult | null => pendingBeforeRequestId)();
      if (buffered && (buffered.requestId == null || buffered.requestId === issuedRequestId)) {
        lastResult = buffered;
        finish();
        resolve(buffered);
      }
    } catch (error) {
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
