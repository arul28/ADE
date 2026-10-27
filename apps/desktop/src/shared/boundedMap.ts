/**
 * Sets `key` as the newest entry of an insertion-ordered Map and drops the
 * oldest entries past `cap`. Re-setting a key moves it to the newest end, so
 * the map evicts the least recently written entry first.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
