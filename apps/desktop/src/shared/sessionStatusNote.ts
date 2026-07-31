const MAX_STATUS_NOTE_WORDS = 6;
const MAX_STATUS_NOTE_CHARACTERS = 72;
const MAX_STATUS_NOTE_INPUT_CHARACTERS = 200;

export function normalizeSessionStatusNote(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const boundedInput = Array.from(raw)
    .slice(0, MAX_STATUS_NOTE_INPUT_CHARACTERS)
    .join("");
  const words = boundedInput.split(/\s+/);
  const wordSummary = words.slice(0, MAX_STATUS_NOTE_WORDS).join(" ");
  const characters = Array.from(wordSummary);

  if (characters.length > MAX_STATUS_NOTE_CHARACTERS) {
    return `${characters.slice(0, MAX_STATUS_NOTE_CHARACTERS - 1).join("")}…`;
  }
  return words.length > MAX_STATUS_NOTE_WORDS ? `${wordSummary}…` : wordSummary;
}
