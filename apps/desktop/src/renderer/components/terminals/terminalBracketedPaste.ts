/**
 * The bracketed-paste markers (DEC mode 2004). A program that turns the mode
 * on reads everything between them as pasted text, not typed keys.
 */
export const TERMINAL_BRACKETED_PASTE_START = "\x1b[200~";
export const TERMINAL_BRACKETED_PASTE_END = "\x1b[201~";
