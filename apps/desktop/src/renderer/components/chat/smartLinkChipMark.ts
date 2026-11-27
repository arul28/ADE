import type { SmartLinkProvider } from "../../../shared/smartLinks";
import { JIRA_LOGO_PATH } from "../lanes/jiraBrand";
import { LINEAR_LOGO_PATH } from "../lanes/linearBrand";

// Inline SVG brand marks for composer smart-link chips. The chips are built
// imperatively (document.createElement) inside the contenteditable, so we hand
// back raw SVG markup that the composer assigns to the icon span's innerHTML
// rather than React nodes.
//
// Marks render in `currentColor` so they inherit the chip's violet-tinted
// foreground and stay cohesive with the pill. GitHub's and Linear's marks are
// monochrome by design; the generic globe is the offline fallback for web
// pages that have not yet resolved a real favicon (a resolved favicon <img>
// always takes precedence over this mark in the composer).

// GitHub Octocat mark (simple-icons canonical path, 24x24).
const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

// Linear mark reuses the canonical path exported from lanes/linearBrand.tsx so
// LinearMark and this imperative renderer stay in lockstep.

// Daex mark: the app icon's "æ" glyph (assets/brand/daex/glyph-mask.png)
// drawn as two round-capped strokes, which reads cleaner at chip size than a
// traced outline. One stroke runs from the top-left arch down through the
// crossing into the e's tail; the other draws the a's bowl, the diagonal, the
// e's top and its crossbar.
const DAEX_MARK_PATHS = [
  "M4.6 8.6C5.5 6.7 6.9 5.8 8.5 5.8C10.3 5.8 11.3 7.6 12.1 10.2C13 13.4 14 18.3 16.6 18.3C18.4 18.3 19.7 16.9 20.5 15.4",
  "M12.6 10.8C8.6 10.8 3.4 12.2 3.4 15.6C3.4 17.3 4.4 18.3 5.6 18.3C6.7 18.3 7.6 17.6 8.4 16.5L14.4 8.3C15.6 6.6 17 5.6 18.6 5.6C20.4 5.6 21.6 6.8 21.6 8.3C21.6 9.8 20.6 10.8 19 10.8L12.6 10.8",
];

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true" focusable="false" style="display:block">${inner}</svg>`;
}

/**
 * Inline SVG brand mark for a smart-link chip, or `null` when the provider has
 * no dedicated mark and the caller should fall back to a text glyph.
 */
export function smartLinkChipMarkSvg(provider: SmartLinkProvider): string | null {
  switch (provider) {
    case "github":
      return svg(`<path fill-rule="evenodd" clip-rule="evenodd" d="${GITHUB_PATH}" />`);
    case "linear":
      return svg(`<path d="${LINEAR_LOGO_PATH}" />`);
    case "jira":
      return svg(`<path d="${JIRA_LOGO_PATH}" />`);
    case "ade":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:block">${DAEX_MARK_PATHS.map((d) => `<path d="${d}" />`).join("")}</svg>`;
    case "generic":
      // Globe (lucide-style, stroke-based) as the offline fallback for web
      // pages. A resolved favicon replaces this in the composer.
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:block"><circle cx="12" cy="12" r="9.2" /><path d="M2.8 12h18.4" /><path d="M12 2.8a14 14 0 0 1 3.6 9.2 14 14 0 0 1-3.6 9.2 14 14 0 0 1-3.6-9.2A14 14 0 0 1 12 2.8Z" /></svg>`;
    default:
      return null;
  }
}
