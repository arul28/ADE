type AnyRecord = Record<PropertyKey, unknown>;

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
