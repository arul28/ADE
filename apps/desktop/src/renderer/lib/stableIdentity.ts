import { createElement, memo, useRef, type ComponentType, type FunctionComponent } from "react";

/** Compare maps by key/value identity so derived values can retain identity across renders. */
export function sameMapContents<K, V>(previous: ReadonlyMap<K, V>, next: ReadonlyMap<K, V>): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return false;
  }
  return true;
}

/** Compare set contents so derived values can retain identity across renders. */
export function sameSetContents<T>(previous: ReadonlySet<T>, next: ReadonlySet<T>): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const value of next) if (!previous.has(value)) return false;
  return true;
}

/** Compare ordered key lists used by virtualized transcript rows. */
export function sameKeyList(previous: readonly string[], next: readonly string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

/** Retain a derived value's identity while its relevant contents are unchanged. */
export function useStableIdentity<T>(next: T, isSame: (previous: T, next: T) => boolean): T {
  const ref = useRef(next);
  if (ref.current !== next && !isSame(ref.current, next)) {
    ref.current = next;
  }
  return ref.current;
}

/**
 * A stable function that always calls the latest `fn`, or `undefined` while
 * `fn` is. For handlers passed into memoized subtrees: a parent that rebuilds
 * its closures on every render would otherwise re-render every memoized child
 * that receives them. Identity changes only when the handler appears or goes.
 */
export function useLatestCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const latest = useRef(fn);
  latest.current = fn;
  const stable = useRef<((...args: A) => R) | null>(null);
  stable.current ??= (...args: A) => latest.current!(...args);
  return fn ? stable.current : undefined;
}

/**
 * `memo(Component)` whose function props are stable proxies to the latest
 * handler. For a memoized component its parent renders with fresh inline
 * callbacks (a list row, a card): plain `memo` would never skip it. The thin
 * wrapper renders every time and refreshes the handlers; the component itself
 * renders only when a non-function prop changes. A handler that is absent
 * stays absent, so controls gated on its presence behave as before. Plain
 * callbacks only: a component type or render prop must not go through here.
 */
export function memoWithLatestHandlers<P extends object>(
  Component: ComponentType<P>,
): FunctionComponent<P> {
  const Inner = memo(Component) as unknown as ComponentType<P>;
  function WithLatestHandlers(props: P) {
    const latest = useRef(props);
    latest.current = props;
    const proxies = useRef(new Map<string, (...args: unknown[]) => unknown>());
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== "function") {
        forwarded[key] = value;
        continue;
      }
      let proxy = proxies.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) => (latest.current as Record<string, (...a: unknown[]) => unknown>)[key]!(...args);
        proxies.current.set(key, proxy);
      }
      forwarded[key] = proxy;
    }
    return createElement(Inner, forwarded as P);
  }
  WithLatestHandlers.displayName = `WithLatestHandlers(${Component.displayName ?? Component.name ?? "Component"})`;
  return WithLatestHandlers;
}
