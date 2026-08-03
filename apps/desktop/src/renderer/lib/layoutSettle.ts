/**
 * Deferred ResizeObserver delivery for short, self-resolving layout animations.
 *
 * The shell's collapsible tab rail animates its own width (52px -> 140px) as a
 * flex item, so every frame of that 200ms transition resizes <main> and every
 * pane group inside it. `react-resizable-panels` observes its group and panel
 * elements with a ResizeObserver, and its callback reads `offsetWidth` for the
 * group and each panel (a forced synchronous layout) before re-rendering every
 * pane through React. The per-frame cost is the same everywhere, but the number
 * of frames in a fixed-duration transition scales with the display refresh
 * rate: ~12 frames at 60 Hz, ~48 at 240 Hz. On a 240 Hz Windows display that
 * pinned the renderer main thread at 99.3% busy for the length of a hover.
 *
 * Nothing in that intermediate work is load bearing. `react-resizable-panels`
 * sizes panels with `flex-grow` ratios (`flexBasis: 0`), so the browser already
 * scales them correctly as the container shrinks, for free, on the compositor's
 * schedule. The observer callback only re-derives pixel constraints — which
 * only matters once, at the size the group actually comes to rest at.
 *
 * So: install a ResizeObserver wrapper that can hold delivery for observers
 * watching elements inside a scope element, and flush once the animation ends.
 * Flushing re-observes the held targets rather than replaying stale entries, so
 * consumers receive the real, final geometry instead of a size the element had
 * mid-transition.
 *
 * This keeps macOS push semantics — content genuinely moves aside as the rail
 * grows, because the browser is still laying it out every frame — while
 * removing the forced-layout-plus-React-render pass that made it expensive.
 */

type ObserverCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

type HeldTargets = Set<Element>;

let nativeResizeObserver: typeof ResizeObserver;
let installed = false;
let suspendCount = 0;
let suspendScope: Element | null = null;
const held = new Map<SettlingResizeObserver, HeldTargets>();

function isSuspended(target: Element): boolean {
  if (suspendCount <= 0) return false;
  const scope = suspendScope;
  if (!scope) return false;
  return scope === target || scope.contains(target);
}

class SettlingResizeObserver implements ResizeObserver {
  readonly #inner: ResizeObserver;
  readonly #observed = new Map<Element, ResizeObserverOptions | undefined>();

  constructor(callback: ObserverCallback) {
    const NativeObserver = nativeResizeObserver;
    this.#inner = new NativeObserver((entries) => {
      if (suspendCount <= 0) {
        callback(entries, this);
        return;
      }
      const deliver: ResizeObserverEntry[] = [];
      let holding: HeldTargets | undefined;
      for (const entry of entries) {
        if (!isSuspended(entry.target)) {
          deliver.push(entry);
          continue;
        }
        holding ??= held.get(this) ?? new Set<Element>();
        holding.add(entry.target);
      }
      if (holding) held.set(this, holding);
      if (deliver.length > 0) callback(deliver, this);
    });
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.#observed.set(target, options);
    this.#inner.observe(target, options);
  }

  unobserve(target: Element): void {
    this.#observed.delete(target);
    held.get(this)?.delete(target);
    this.#inner.unobserve(target);
  }

  disconnect(): void {
    this.#observed.clear();
    held.delete(this);
    this.#inner.disconnect();
  }

  /**
   * Re-observe every target whose callback we swallowed. A fresh `observe()`
   * always delivers an initial observation, so the consumer sees the element's
   * settled geometry rather than a stale mid-animation box.
   */
  flushHeld(targets: HeldTargets): void {
    for (const target of targets) {
      if (!this.#observed.has(target)) continue;
      if (!target.isConnected) continue;
      const options = this.#observed.get(target);
      this.#inner.unobserve(target);
      this.#inner.observe(target, options);
    }
  }
}

/**
 * Swap `window.ResizeObserver` for the settling wrapper. Must run before the
 * observers we want to be able to hold are constructed; `react-resizable-panels`
 * reads `ownerDocument.defaultView.ResizeObserver` when a group mounts, so
 * installing this at renderer boot is early enough.
 */
export function installLayoutSettleResizeObserver(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.ResizeObserver !== "function") return;
  installed = true;
  nativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = SettlingResizeObserver as unknown as typeof ResizeObserver;
}

function flushAll(): void {
  if (held.size === 0) return;
  const pending = [...held.entries()];
  held.clear();
  for (const [observer, targets] of pending) observer.flushHeld(targets);
}

/**
 * Hold ResizeObserver delivery for anything inside `scope` until the returned
 * release function runs. Reference counted, so overlapping holds are safe.
 *
 * `maxMs` is a hard backstop: if the release never arrives (a transition that
 * gets interrupted, a `transitionend` that never fires because the duration is
 * 0), observers resume anyway. It is a correctness guard, not a schedule.
 */
export function holdLayoutSettle(scope: Element | null, maxMs = 400): () => void {
  if (!installed || !scope) return () => {};
  suspendScope = scope;
  suspendCount += 1;
  let released = false;
  const timer = window.setTimeout(() => release(), maxMs);
  function release(): void {
    if (released) return;
    released = true;
    window.clearTimeout(timer);
    suspendCount = Math.max(0, suspendCount - 1);
    if (suspendCount === 0) {
      suspendScope = null;
      flushAll();
    }
  }
  return release;
}

/** Test seam. */
export function __resetLayoutSettleForTests(): void {
  installed = false;
  suspendCount = 0;
  suspendScope = null;
  held.clear();
}
