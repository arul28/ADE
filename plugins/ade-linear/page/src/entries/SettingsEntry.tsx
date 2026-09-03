/**
 * The Linear settings section, as a guest.
 *
 * The manifest's `settings-section` socket answers this surface, and the host
 * draws the section FRAME around it — the Linear mark, the "Linear integration"
 * heading, the one-line description — exactly as `LinearIntegrationSection`
 * wrapped the compiled `LinearSection` in a `SettingsSectionShell`. So this
 * entry draws neither: it renders `<LinearSection embedded />`, which is the
 * same call the compiled wrapper made, and nothing else.
 *
 * Two things it does own, and both are about being a guest rather than a page.
 *
 * ## 1. The guest is sized to its CONTENT
 *
 * A settings section is not a viewport. It is a band in a scrolling column that
 * the host owns, so the host has to be told how tall this one is — and the
 * bridge has no height verb yet. Until it grows one, the height is reported
 * BOTH ways, because the two live hosts measure differently and neither is
 * wrong:
 *
 *  - `document.documentElement.style.height` / `document.body.style.height` are
 *    set to the measured pixel height, which a host that measures the guest's
 *    DOCUMENT (an iframe auto-sizer reading `scrollHeight`) picks up with no
 *    cooperation at all.
 *  - `postMessage({type: "ade:plugin-webview-height", height})` is sent to the
 *    parent, for a host that listens for a frame instead of measuring.
 *
 * A host that does neither is unharmed: `page.css` already gives the
 * `settings-section` placement `height: auto`, so an unmeasured guest still
 * lays out correctly; it just does not resize its own frame.
 *
 * The report is capped at 4000px. A runaway measurement — a mid-layout read, a
 * font swap, a `ResizeObserver` loop — must not hand the host a section taller
 * than the settings page itself.
 *
 * ## 2. No page-sized ground
 *
 * The host paints the section's background. The root here is transparent and
 * carries no padding beyond what the compiled section already had, so the guest
 * is invisible except for the cards it draws.
 */

import React, { useEffect, useRef } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearSection } from "../components/LinearSection";

/** The tallest height this page will ever report. */
const MAX_REPORTED_HEIGHT = 4000;

/** The frame a listening host reads. Named once, here and in the host. */
const HEIGHT_MESSAGE_TYPE = "ade:plugin-webview-height";

export function SettingsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastReportedRef = useRef<number>(0);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof window === "undefined") return;

    const report = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the section's cards
      // use fractional padding, and a rounded-down height clips the last border.
      const measured = Math.ceil(node.getBoundingClientRect().height);
      if (!Number.isFinite(measured) || measured <= 0) return;
      const height = Math.min(measured, MAX_REPORTED_HEIGHT);
      if (height === lastReportedRef.current) return;
      lastReportedRef.current = height;

      const px = `${height}px`;
      document.documentElement.style.height = px;
      document.body.style.height = px;

      try {
        window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height }, "*");
      } catch {
        // A host that refuses the frame still has the document height above.
      }
    };

    report();
    const observer = new ResizeObserver(() => report());
    observer.observe(node);
    return () => {
      observer.disconnect();
      // Hand the document back the way `page.css` left it, so a placement that
      // reuses this frame is not stuck at the settings section's height.
      document.documentElement.style.removeProperty("height");
      document.body.style.removeProperty("height");
    };
  }, []);

  return (
    <div ref={rootRef} style={{ background: "transparent" }}>
      <LinearSection context={context} embedded />
    </div>
  );
}
