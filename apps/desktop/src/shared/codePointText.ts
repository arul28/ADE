/**
 * Cutting text by UTF-16 length can split an emoji in half and leave a lone
 * surrogate. A lone surrogate is not valid in the JSON a provider reads, and
 * a provider that refuses the message can leave a turn waiting on an answer
 * that never comes. These cuts stay on code point boundaries.
 */

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** `text.slice(0, maxLength)`, one code unit shorter when that would split a pair. */
export function cutTextAtCodePoint(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const end = Math.max(0, maxLength);
  return text.slice(0, end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end);
}

/** `text.slice(-maxLength)`, one code unit shorter when that would split a pair. */
export function tailTextAtCodePoint(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const start = text.length - Math.max(0, maxLength);
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}
