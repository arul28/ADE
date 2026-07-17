export function stableCacheKey(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (entry: unknown): string => {
    if (entry === null) return "null";
    if (entry === undefined) return "undefined";

    switch (typeof entry) {
      case "boolean":
        return entry ? "boolean:true" : "boolean:false";
      case "string":
        return `string:${JSON.stringify(entry)}`;
      case "number":
        if (Number.isNaN(entry)) return "number:NaN";
        if (entry === Number.POSITIVE_INFINITY) return "number:+Infinity";
        if (entry === Number.NEGATIVE_INFINITY) return "number:-Infinity";
        if (Object.is(entry, -0)) return "number:-0";
        return `number:${String(entry)}`;
      case "bigint":
        return `bigint:${entry.toString()}`;
      case "symbol":
      case "function":
        throw new TypeError(`Unsupported cache-key value: ${typeof entry}`);
      case "object": {
        if (ancestors.has(entry)) {
          throw new TypeError("Cannot build a cache key from a circular value.");
        }
        ancestors.add(entry);
        try {
          if (Array.isArray(entry)) {
            const values = Array.from({ length: entry.length }, (_, index) =>
              Object.prototype.hasOwnProperty.call(entry, index) ? encode(entry[index]) : "hole"
            );
            return `array:[${values.join(",")}]`;
          }
          const symbolKeys = Object.getOwnPropertySymbols(entry)
            .filter((key) => Object.prototype.propertyIsEnumerable.call(entry, key));
          if (symbolKeys.length > 0) {
            throw new TypeError("Unsupported cache-key value: symbol-keyed object");
          }
          const prototype = Object.getPrototypeOf(entry);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Unsupported cache-key value: non-plain object");
          }
          const record = entry as Record<string, unknown>;
          const values = Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`);
          return `object:{${values.join(",")}}`;
        } finally {
          ancestors.delete(entry);
        }
      }
    }
  };

  return encode(value);
}
