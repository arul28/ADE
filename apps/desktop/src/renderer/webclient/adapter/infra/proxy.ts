import { ADE_UNAVAILABLE, AdeUnavailableError } from "../../../lib/adeAvailability";

type AnyRecord = Record<PropertyKey, unknown>;

/**
 * Wraps the web surface so a member it does not implement is never a silent
 * success. A missing method rejects with `AdeUnavailableError` (an `on*`
 * subscription returns a no-op unsubscribe), and the stand-in carries
 * `ADE_UNAVAILABLE` so `isAdeAvailable` reports it absent. It used to resolve
 * `null`, which callers read as real data and crashed on, and which made every
 * desktop-only feature check pass on web.
 */
export function withFallbackProxy<T extends AnyRecord>(surface: T): T {
  const logged = new Set<string>();
  const objectCache = new WeakMap<object, unknown>();

  function wrap(value: unknown, path: string): unknown {
    if (!value || typeof value !== "object") return value;
    const cached = objectCache.get(value);
    if (cached) return cached;
    const proxy = new Proxy(value as AnyRecord, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        if (prop in target) {
          return wrap(Reflect.get(target, prop, receiver), path ? `${path}.${prop}` : prop);
        }
        return missing(path || "ade", prop);
      },
    });
    objectCache.set(value, proxy);
    return proxy;
  }

  function missing(path: string, method: string): (...args: unknown[]) => unknown {
    const key = `${path}.${method}`;
    const callable = (..._args: unknown[]) => {
      if (!logged.has(key)) {
        logged.add(key);
        console.debug("[ade-web] unimplemented:", key);
      }
      if (method.startsWith("on")) return () => {};
      return Promise.reject(new AdeUnavailableError(key));
    };
    return new Proxy(callable, {
      get(_target, prop) {
        if (prop === ADE_UNAVAILABLE) return true;
        if (typeof prop === "symbol") return undefined;
        return missing(key, prop);
      },
    });
  }

  return wrap(surface, "") as T;
}
