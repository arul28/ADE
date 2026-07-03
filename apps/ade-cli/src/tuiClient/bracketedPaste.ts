export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

export type BracketedPasteState = {
  active: boolean;
  buffer: string;
};

export const EMPTY_BRACKETED_PASTE_STATE: BracketedPasteState = {
  active: false,
  buffer: "",
};

export function containsBracketedPasteMarker(value: string): boolean {
  return value.includes(BRACKETED_PASTE_START) || value.includes(BRACKETED_PASTE_END);
}

export function stripBracketedPasteMarkers(value: string): string {
  return value.split(BRACKETED_PASTE_START).join("").split(BRACKETED_PASTE_END).join("");
}

export function consumeBracketedPasteInput(
  state: BracketedPasteState,
  input: string,
): { state: BracketedPasteState; text: string; consumed: boolean } {
  let active = state.active;
  let buffer = state.buffer;
  let remaining = input;
  let text = "";
  let consumed = active || containsBracketedPasteMarker(input);

  while (remaining.length > 0) {
    if (active) {
      const end = remaining.indexOf(BRACKETED_PASTE_END);
      if (end < 0) {
        buffer += remaining;
        remaining = "";
        continue;
      }
      text += buffer + remaining.slice(0, end);
      buffer = "";
      active = false;
      remaining = remaining.slice(end + BRACKETED_PASTE_END.length);
      continue;
    }

    const start = remaining.indexOf(BRACKETED_PASTE_START);
    if (start < 0) {
      text += consumed ? stripBracketedPasteMarkers(remaining) : remaining;
      remaining = "";
      continue;
    }
    text += stripBracketedPasteMarkers(remaining.slice(0, start));
    active = true;
    remaining = remaining.slice(start + BRACKETED_PASTE_START.length);
  }

  return {
    state: { active, buffer },
    text: text.replace(/\r\n?/g, "\n"),
    consumed,
  };
}

export function formatTerminalControlForwardedInput(input: string): string {
  if (!input) return input;
  if (containsBracketedPasteMarker(input)) return input;
  const normalized = input.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\n")) return input;
  if (normalized === "\n") return input;
  return `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`;
}
