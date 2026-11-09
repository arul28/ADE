/** Cuts to `max` chars without splitting a surrogate pair. No ellipsis: a cut quote must still be found in the reply. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
