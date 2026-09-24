/** `1 tool`, `2 tools`, `0 files`. */
export function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
