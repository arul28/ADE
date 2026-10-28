import { useId } from "react";
import { useWindowFocused } from "../../lib/windowFocus";
import { cn } from "./cn";

/**
 * A working status: a sparkle that melts into a circle and back, a small star
 * that twinkles at the turn, and a sheen that sweeps the label. Adapted from
 * the 21st.dev "thinking-indicator", but every loop is stepped CSS (index.css,
 * `.ade-thinking-*`) instead of a per-frame Motion morph, so the stepped loop
 * clock drives it 30 times a second rather than at the display rate.
 *
 * The label is keyed, so a new label slides in once. The glyph takes
 * `currentColor`; the label is the theme's foreground at rest with a full
 * foreground sheen. Reduced motion leaves a still glyph and label.
 *
 * While ADE is not the focused app the loops are taken off (`data-resting`):
 * nobody is watching, so a long turn in the background costs no frames and no
 * clock timers. The glyph rests as a still sparkle and starts again on focus.
 */
export function ThinkingIndicator({ label, className }: { label: string; className?: string }) {
  // A bare token: React ids carry punctuation that `url(#…)` does not need.
  const gradientId = `ade-thinking-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const focused = useWindowFocused();
  return (
    <span
      className={cn("ade-thinking-indicator inline-flex min-w-0 items-center gap-[0.5em]", className)}
      data-resting={focused ? undefined : "true"}
    >
      <span className="relative inline-block h-[1.3em] w-[1.3em] shrink-0" aria-hidden>
        <span className="ade-thinking-glyph absolute inset-0">
          <svg viewBox="0 0 24 24" className="h-full w-full" fill="none">
            <defs>
              <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="5" x2="20" y1="4" y2="20">
                <stop offset="0" stopColor="currentColor" stopOpacity="1" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0.4" />
              </linearGradient>
            </defs>
            <path
              className="ade-thinking-glyph-shape"
              d="M 12 3 C 12.9 7.4 16.6 11.1 21 12 C 16.6 12.9 12.9 16.6 12 21 C 11.1 16.6 7.4 12.9 3 12 C 7.4 11.1 11.1 7.4 12 3 Z"
              fill={`url(#${gradientId})`}
            />
          </svg>
        </span>
        <span className="ade-thinking-twinkle absolute inset-0">
          <svg viewBox="0 0 24 24" className="h-full w-full" fill="none">
            <path
              d="M 19 2.5 C 19.18 4.32 19.68 4.82 21.5 5 C 19.68 5.18 19.18 5.68 19 7.5 C 18.82 5.68 18.32 5.18 16.5 5 C 18.32 4.82 18.82 4.32 19 2.5 Z"
              fill="currentColor"
            />
          </svg>
        </span>
      </span>
      <span key={label} className="ade-thinking-label min-w-0 truncate font-medium">{label}</span>
    </span>
  );
}
