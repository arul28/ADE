/**
 * What a scene remembers across mounts in this window.
 *
 * A scene mounts and unmounts as it scrolls, so a remount must not rebuild its
 * document, send it over IPC again, take another slot in main's document store,
 * replay its entrance, or open at the wrong height.
 */

/**
 * A fresh id for one built document.
 *
 * Not a security boundary — the frame is already sandboxed and origin-isolated,
 * and this only has to separate one of OUR documents from the previous one — so
 * `randomUUID` where it exists and a counter-plus-random string where it does
 * not (an older jsdom, a non-secure context) is enough.
 */
let sceneNonceCounter = 0;
export function mintSceneNonce(): string {
  sceneNonceCounter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${sceneNonceCounter}-${random}`;
}

/** Scenes that have played to a settle in this window: they come back restored. */
const playedScopes = new Set<string>();
export function markScenePlayed(scopeKey: string | null): void {
  if (scopeKey) playedScopes.add(scopeKey);
}
export function hasScenePlayed(scopeKey: string | null): boolean {
  return scopeKey !== null && playedScopes.has(scopeKey);
}

/** Last measured height per scene, so a placeholder holds the space it will take. */
const knownHeights = new Map<string, number>();
export function knownSceneHeight(scopeKey: string | null): number | null {
  return (scopeKey && knownHeights.get(scopeKey)) || null;
}
export function rememberSceneHeight(scopeKey: string | null, height: number): void {
  if (scopeKey) knownHeights.set(scopeKey, height);
}

/**
 * Built documents and their prepared URLs. A remount of the same scene in the
 * same theme reuses both. Reusing a nonce across mounts is safe: a message is
 * first matched to the frame element's own `contentWindow`, and a remount is a
 * new element.
 */
const CACHE_LIMIT = 24;
const documents = new Map<string, { html: string; nonce: string }>();
const preparedUrls = new Map<string, string>();

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** The document cached under `key`, or a new one built (and cached) with a fresh nonce. */
export function cachedSceneDocument(key: string, build: (nonce: string) => string): { html: string; nonce: string } {
  const cached = documents.get(key);
  const entry = cached ?? (() => {
    const nonce = mintSceneNonce();
    return { html: build(nonce), nonce };
  })();
  rememberBounded(documents, key, entry);
  return entry;
}

export function cachedPreparedUrl(html: string): string | null {
  return preparedUrls.get(html) ?? null;
}
export function rememberPreparedUrl(html: string, url: string): void {
  rememberBounded(preparedUrls, html, url);
}
/** A prepared URL that never came up (evicted in main: a 404 never says ready); the next mount re-prepares. */
export function forgetPreparedUrl(url: string): void {
  for (const [html, cached] of preparedUrls) if (cached === url) preparedUrls.delete(html);
}
