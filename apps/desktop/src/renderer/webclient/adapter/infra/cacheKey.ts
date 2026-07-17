export function stableCacheKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCacheKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableCacheKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
