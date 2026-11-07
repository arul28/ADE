/** Small helpers the Android browser-preview mocks share. */

/** One query parameter of the preview's URL, or null. */
export function mockParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** Answers `value` after `ms`, as a slow brain would. */
export function mockDelay<T>(value: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));
}
