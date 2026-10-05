import {
  Browser,
  Compass,
  GoogleChromeLogo,
  type Icon,
} from "@phosphor-icons/react";

import type { BrowserTarget } from "../../../shared/browserTargets";

/**
 * The few browsers Phosphor draws a real mark for. Everything else falls back
 * to a browser window, which at least says "this is a browser" rather than
 * "this is a letter".
 */
const BROWSER_GLYPH: Partial<Record<BrowserTarget, Icon>> = {
  chrome: GoogleChromeLogo,
  chromium: GoogleChromeLogo,
  safari: Compass,
};

/**
 * The icon for one browser row.
 *
 * The real app icon is read from the installed application on the machine, so
 * every browser the user actually has shows its own logo without ADE shipping
 * (and maintaining) a copy of it. When the OS would not hand one over — a
 * browser with no resolvable path, or Linux — a per-browser glyph stands in.
 */
export function BrowserTargetLogo({
  browserId,
  iconDataUrl,
  size = 16,
}: {
  browserId: BrowserTarget | string;
  iconDataUrl?: string | null;
  size?: number;
}) {
  if (iconDataUrl) {
    return (
      <span
        aria-hidden
        data-browser-logo={browserId}
        className="inline-flex shrink-0 items-center justify-center"
      >
        <img
          src={iconDataUrl}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="shrink-0 object-contain"
        />
      </span>
    );
  }
  const Glyph = BROWSER_GLYPH[browserId as BrowserTarget] ?? Browser;
  return (
    <span
      aria-hidden
      data-browser-logo={browserId}
      className="inline-flex shrink-0 text-fg/55"
    >
      <Glyph size={size} weight="duotone" />
    </span>
  );
}
