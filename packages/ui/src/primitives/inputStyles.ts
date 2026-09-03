/**
 * The single-line text input's chrome.
 *
 * `INPUT_CLS` is the app's Tailwind string, unchanged, so a desktop call site
 * renders exactly as before. `ade-input` is appended for plugin pages, where
 * the injected stylesheet implements the same box. `INPUT_STYLE` is empty and
 * stays empty: it exists because call sites spread it, and removing it would
 * touch every one of them.
 */

import type { CSSProperties } from "react";

export const INPUT_CLS =
  "h-8 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs text-fg outline-none transition-colors placeholder:text-muted-fg/55 hover:border-white/[0.14] focus:border-accent/45 focus:ring-1 focus:ring-accent/20 ade-input";

export const INPUT_STYLE: CSSProperties = {};

export const CARD_STYLE: CSSProperties = {};
