/**
 * Track first-time celebration events via localStorage.
 * Returns true the first time a given key is seen, false thereafter.
 */
export function isFirstCelebration(key: string): boolean {
  const storageKey = `ade:${key}`;
  if (localStorage.getItem(storageKey)) return false;
  localStorage.setItem(storageKey, Date.now().toString());
  return true;
}
