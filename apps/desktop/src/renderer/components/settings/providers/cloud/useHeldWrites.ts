/**
 * Remove with Undo, for writes that have no undo of their own (a removed
 * sign-in leaves a tombstone, a removed key is gone): the item hides at once,
 * a toast offers Undo, and the write runs only when the toast ends.
 *
 * A held write is never lost. It runs when its toast leaves (timed out, or
 * closed with ×), when the view that holds it unmounts, and on `pagehide`
 * (the window closes or reloads). Undo is the only way to drop it. No timer
 * of its own: the toast's timer (which pauses while pointed at) decides.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { showToast, useToasts } from "../../../app/toast/toastStore";

type HeldWrite = {
  toastId: string;
  run: () => void;
};

export type HeldWrites = {
  /** The ids whose write waits on its toast; the view hides them. */
  held: ReadonlySet<string>;
  /** Hide `id`, show the toast with Undo, and run `write` when the toast ends. */
  hold: (args: { id: string; title: string; write: () => void }) => void;
};

let toastSeq = 0;

export function useHeldWrites(): HeldWrites {
  const heldRef = useRef(new Map<string, HeldWrite>());
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const mountedRef = useRef(true);

  const sync = useCallback(() => {
    if (mountedRef.current) setHeld(new Set(heldRef.current.keys()));
  }, []);

  /** Run one held write now, once. */
  const flush = useCallback((id: string) => {
    const entry = heldRef.current.get(id);
    if (!entry) return;
    heldRef.current.delete(id);
    entry.run();
  }, []);

  const flushAll = useCallback(() => {
    for (const id of [...heldRef.current.keys()]) flush(id);
  }, [flush]);

  const hold = useCallback(({ id, title, write }: { id: string; title: string; write: () => void }) => {
    // A second Remove of the same item while one waits starts nothing new.
    if (heldRef.current.has(id)) return;
    toastSeq += 1;
    const toastId = `ade-cloud-held-${toastSeq}`;
    heldRef.current.set(id, { toastId, run: write });
    sync();
    showToast({
      id: toastId,
      tone: "success",
      title,
      actions: [{
        label: "Undo",
        onClick: () => {
          // Undo drops the write before the toast leaves, so its end runs nothing.
          if (heldRef.current.get(id)?.toastId !== toastId) return;
          heldRef.current.delete(id);
          sync();
        },
      }],
    });
  }, [sync]);

  // The toast ended (timed out, closed, or pushed out of the stack): run its write.
  const toasts = useToasts();
  useEffect(() => {
    if (heldRef.current.size === 0) return;
    const shown = new Set(toasts.map((toast) => toast.id));
    let ran = false;
    for (const [id, entry] of [...heldRef.current]) {
      if (shown.has(entry.toastId)) continue;
      flush(id);
      ran = true;
    }
    if (ran) sync();
  }, [flush, sync, toasts]);

  // The window closes or reloads: run every held write now.
  useEffect(() => {
    window.addEventListener("pagehide", flushAll);
    return () => window.removeEventListener("pagehide", flushAll);
  }, [flushAll]);

  // The view goes away: run every held write now. Its toast may still show;
  // its Undo then does nothing, since the write already ran.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushAll();
    };
  }, [flushAll]);

  return { held, hold };
}
