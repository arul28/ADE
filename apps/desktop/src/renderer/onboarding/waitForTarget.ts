// Shared utility used by the tour engine to wait for a selector to appear in
// the DOM. Uses a MutationObserver (best-effort, avoids busy-polling) plus a
// setInterval fallback so late-mounting portals or off-tree elements still
// resolve promptly.

export type WaitForSelectorOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;

export function waitForSelector(
  selector: string,
  opts: WaitForSelectorOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const { signal } = opts;

  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    if (typeof document === "undefined") {
      resolve(false);
      return;
    }

    // Fast path: already in the DOM.
    if (document.querySelector(selector)) {
      resolve(true);
      return;
    }

    let settled = false;
    let observer: MutationObserver | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    function cleanup(): void {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (pollId != null) {
        clearInterval(pollId);
        pollId = null;
      }
      if (timeoutId != null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    }

    function settle(result: boolean): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function check(): void {
      if (settled) return;
      if (document.querySelector(selector)) {
        settle(true);
      }
    }

    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => check());
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    pollId = setInterval(check, pollMs);
    timeoutId = setTimeout(() => settle(false), timeoutMs);

    if (signal) {
      abortHandler = () => settle(false);
      signal.addEventListener("abort", abortHandler);
    }
  });
}
