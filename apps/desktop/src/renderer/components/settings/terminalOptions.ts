import { DEFAULT_TERMINAL_FONT_FAMILY } from "../../state/appStore";

export const TERMINAL_FONT_SIZE_OPTIONS = [11, 11.5, 12, 12.5, 13, 13.5, 14, 15];
export const TERMINAL_LINE_HEIGHT_OPTIONS = [1.1, 1.15, 1.2, 1.25, 1.3, 1.35];
export const TERMINAL_SCROLLBACK_OPTIONS = [5000, 10000, 20000, 30000];

export const TERMINAL_FONT_FAMILY_OPTIONS = [
  { label: "ADE default", value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "JetBrains Mono", value: "\"JetBrains Mono\", " + DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "Geist Mono", value: "\"Geist Mono\", " + DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "Cascadia Mono", value: "\"Cascadia Mono\", " + DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "Menlo", value: "Menlo, " + DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "Monaco", value: "Monaco, " + DEFAULT_TERMINAL_FONT_FAMILY },
];
