type AnyRecord = Record<PropertyKey, unknown>;

const honestSurfaces = new WeakSet<object>();

/**
 * Opt a namespace out of the fallback proxy, so a member it does not define
 * reads as `undefined` instead of as a callable that resolves null.
 *
 * The proxy's manufactured members are the right default for a surface whose
 * callers just invoke methods and tolerate a null: it keeps the web client
 * running against a desktop API that is still growing. It is exactly wrong for
 * a surface whose callers PROBE it — `typeof namespace.member === "function"`
 * is true for every conceivable name under the proxy, so a capability check
 * reports every capability available, and the UI offers buttons whose backing
 * call resolves null and reports success for work that never happened.
 *
 * Marked surfaces must therefore be honest on their own: define what they can
 * do, omit what they cannot, and throw on a write that has no transport rather
 * than resolving.
 */
export function markHonestSurface<T extends object>(surface: T): T {
  honestSurfaces.add(surface);
  return surface;
}

export function withFallbackProxy<T extends AnyRecord>(surface: T): T {
  const logged = new Set<string>();
  const objectCache = new WeakMap<object, unknown>();

  function wrap(value: unknown, path: string): unknown {
    if (!value || typeof value !== "object") return value;
    // Returned unwrapped, and deliberately not cached: the object is its own
    // truth, and re-wrapping it anywhere else in the surface must not
    // reintroduce the phantom members it was marked to avoid.
    if (honestSurfaces.has(value)) return value;
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
    const callable = (..._args: unknown[]) => {
      const key = `${path}.${method}`;
      if (!logged.has(key)) {
        logged.add(key);
        console.debug("[ade-web] unimplemented:", path, method);
      }
      if (method.startsWith("on")) return () => {};
      return Promise.resolve(null);
    };
    return new Proxy(callable, {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        return missing(`${path}.${method}`, prop);
      },
    });
  }

  return wrap(surface, "") as T;
}
