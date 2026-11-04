import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

/**
 * How long the last viewer's stop waits for another viewer to arrive.
 *
 * A handover is one viewer replacing another, and the order is not always
 * "arrive, then leave": `apple show` hides the floating player a beat before
 * the pane mounts, and a tools pane tab switch remounts the pane. Stopping at
 * once cut the capture in that gap, and the new viewer had to open a new one
 * (new port, a wait for a keyframe) instead of joining.
 */
export const STREAM_STOP_GRACE_MS = 1_000;

export type UseGracefulStreamLeaseArgs<Lease, Scope> = {
  /** Gives the lease back to its table. `last` is true when this viewer was the last one. */
  release: (lease: Lease) => { last: boolean };
  /** True when another viewer took the stream up during the grace: theirs now. */
  heldAgain: (lease: Lease) => boolean;
  /** Stops the stream on the machine that holds it. */
  stop: (lease: Lease, scope: Scope) => void;
  /**
   * The scope an unmount and a page hide stop with. A ref because the cleanup
   * runs after the props are gone, and a stop aimed at a stale lane misses.
   */
  scopeRef: { readonly current: Scope };
};

export type GracefulStreamLease<Lease, Scope> = {
  /** The lease this viewer holds, or null. Set it when the viewer acquires one. */
  leaseRef: MutableRefObject<Lease | null>;
  /** Give the lease back; stop the stream only when this was the last viewer. */
  releaseLease: (scope: Scope, immediate?: boolean) => void;
};

/**
 * A viewer's hold on a device stream: the last viewer out stops it after
 * `STREAM_STOP_GRACE_MS`, unmount gives the lease back, and a page hide (a
 * reload, a closed window) stops at once, because no grace timer outlives
 * the page. A renderer crash still skips the stop.
 */
export function useGracefulStreamLease<Lease, Scope>(
  args: UseGracefulStreamLeaseArgs<Lease, Scope>,
): GracefulStreamLease<Lease, Scope> {
  const leaseRef = useRef<Lease | null>(null);
  const argsRef = useRef(args);
  argsRef.current = args;

  const releaseLease = useCallback((scope: Scope, immediate = false) => {
    const lease = leaseRef.current;
    if (!lease) return;
    leaseRef.current = null;
    const { release, heldAgain, stop } = argsRef.current;
    if (!release(lease).last) return;
    if (immediate) {
      stop(lease, scope);
      return;
    }
    window.setTimeout(() => {
      if (heldAgain(lease)) return;
      stop(lease, scope);
    }, STREAM_STOP_GRACE_MS);
  }, []);

  useEffect(() => () => {
    releaseLease(argsRef.current.scopeRef.current);
  }, [releaseLease]);

  useEffect(() => {
    const onPageHide = () => releaseLease(argsRef.current.scopeRef.current, true);
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [releaseLease]);

  return { leaseRef, releaseLease };
}
