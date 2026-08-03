import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Single owner of the "copy, then flash Copied for a moment" interaction.
 *
 * Adapted from interior.dev's `useCopyToClipboard` (MIT). The parts worth
 * keeping are the ones every hand-rolled copy button gets wrong: a run ticket
 * so a slow copy that resolves after a newer one cannot clobber it, a mounted
 * guard so a resolve after unmount is a no-op, and a single timer that is
 * always cleared rather than left to fire into a dead component.
 *
 * Supports both shapes found in the renderer: an unkeyed button (`copied`) and
 * a list where only one row may flash at a time (`copiedKey` / `isCopied`).
 */

type CopyStatus = "idle" | "copied" | "error";

export type UseCopyToClipboardOptions = {
  /** How long the copied/error state stays visible, in ms. */
  timeout?: number;
  /**
   * Overrides the clipboard transport for callers that must not use
   * `navigator.clipboard` — e.g. panes that write through the main process.
   * Must report the outcome explicitly: resolving `false` or throwing is a
   * failed copy. `void` is deliberately not accepted, because the natural
   * preload shape (`await window.ade.app.writeClipboardText(t)`) resolves
   * `undefined` and would otherwise be scored as success.
   */
  write?: (text: string) => boolean | Promise<boolean>;
  onCopy?: (value: string) => void;
};

export type UseCopyToClipboardResult = {
  /** Writes `text`, then flashes state. `key` scopes the flash to one row. */
  copy: (text: string, key?: string) => Promise<boolean>;
  /** Clears any pending flash immediately (e.g. the row was deleted). */
  reset: () => void;
  copied: boolean;
  copiedKey: string | null;
  isCopied: (key: string) => boolean;
};

/**
 * `navigator.clipboard` rejects when the document is not focused, which happens
 * routinely in Electron when a copy is triggered from a menu or a native
 * dialog. The textarea path keeps those cases working.
 */
function writeFallback(text: string): boolean {
  if (typeof document === "undefined") return false;

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(area);
  if (selection && previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

export function useCopyToClipboard(
  options: UseCopyToClipboardOptions = {},
): UseCopyToClipboardResult {
  const { timeout = 1500, write, onCopy } = options;

  const [status, setStatus] = useState<CopyStatus>("idle");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  // Kept in refs so a caller passing inline callbacks does not force `copy` to
  // change identity on every render.
  const onCopyRef = useRef(onCopy);
  const writeRef = useRef(write);
  useEffect(() => {
    onCopyRef.current = onCopy;
    writeRef.current = write;
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    clearTimer();
    setStatus("idle");
    setCopiedKey(null);
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const copy = useCallback(async (text: string, key?: string): Promise<boolean> => {
    if (!text) return false;

    const id = ++runIdRef.current;

    let ok = false;
    const custom = writeRef.current;
    try {
      if (custom) {
        // A bespoke transport owns the whole write; the textarea fallback would
        // silently route around it, so a failure here is just a failure.
        ok = await custom(text);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = writeFallback(text);
      }
    } catch {
      if (custom) {
        ok = false;
      } else {
        try {
          ok = writeFallback(text);
        } catch {
          ok = false;
        }
      }
    }

    // A newer copy started while this one was in flight, or we unmounted:
    // report the result to the caller but never touch state.
    if (!mountedRef.current || id !== runIdRef.current) return ok;

    if (ok) onCopyRef.current?.(text);

    clearTimer();
    setStatus(ok ? "copied" : "error");
    setCopiedKey(ok ? key ?? null : null);

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!mountedRef.current || id !== runIdRef.current) return;
      setStatus("idle");
      setCopiedKey(null);
    }, timeout);

    return ok;
  }, [clearTimer, timeout]);

  const isCopied = useCallback(
    (key: string) => status === "copied" && copiedKey === key,
    [status, copiedKey],
  );

  return {
    copy,
    reset,
    copied: status === "copied",
    copiedKey,
    isCopied,
  };
}
