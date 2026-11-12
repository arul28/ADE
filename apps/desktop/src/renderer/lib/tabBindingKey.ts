/**
 * The key of the copy this window's project tab is bound to, kept in step with
 * the root app store. A pin with this key names the tab's own copy, and preload
 * gives it the bound path's caches (`isBoundCopyPin`).
 *
 * Renderer caches key such a pin as they keyed no pin, so a caller that names
 * the tab's copy and one that does not share one entry, one in-flight read and
 * one invalidation. In a file of its own: the caches must not import the store.
 */
let tabBindingKey: string | null = null;

export function setTabBindingKey(key: string | null): void {
  tabBindingKey = key;
}

/** The pin a renderer cache keys on: null when it names the tab's own copy. */
export function cacheScopePin<T extends { key: string }>(pin: T | null | undefined): T | null {
  if (!pin) return null;
  return pin.key === tabBindingKey ? null : pin;
}
