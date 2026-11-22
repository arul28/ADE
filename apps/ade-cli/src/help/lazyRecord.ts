/**
 * A record that builds its contents on the first read.
 *
 * The brain imports the command line's help pages with the rest of `cli.ts`
 * but never prints them; built at import, the pages held 368 KB of strings in
 * a brain at rest. Every read (a key, `in`, `Object.keys`, a spread or a rest
 * pattern) sees the same record that the literal made before, and a write
 * goes to that record too.
 */
export function lazyRecord<T>(build: () => Record<string, T>): Record<string, T> {
  let built: Record<string, T> | null = null;
  const record = (): Record<string, T> => (built ??= build());
  return new Proxy({} as Record<string, T>, {
    get: (_target, key) => Reflect.get(record(), key),
    has: (_target, key) => Reflect.has(record(), key),
    ownKeys: () => Reflect.ownKeys(record()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(record(), key),
    set: (_target, key, value) => Reflect.set(record(), key, value),
    deleteProperty: (_target, key) => Reflect.deleteProperty(record(), key),
    defineProperty: (_target, key, descriptor) => Reflect.defineProperty(record(), key, descriptor),
  });
}
