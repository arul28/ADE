/**
 * The status line the Work list shows. Six words is the guideline agents are
 * given, not an enforced cap: amputating word seven silently deletes the
 * decisive half of a note, so the only hard bound is the display budget of 72
 * characters.
 */
export const STATUS_NOTE_GUIDELINE_WORDS = 6;
export const MAX_STATUS_NOTE_CHARACTERS = 72;

export function normalizeSessionStatusNote(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const summary = raw.split(/\s+/).join(" ");
  const characters = Array.from(summary);
  if (characters.length > MAX_STATUS_NOTE_CHARACTERS) {
    return `${characters.slice(0, MAX_STATUS_NOTE_CHARACTERS - 1).join("")}…`;
  }
  return summary;
}
