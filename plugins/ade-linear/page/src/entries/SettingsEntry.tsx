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
 * the host owns, so the host has to be told how tall this one is — and
 * `ui.resize` is the verb that tells it. One channel, and only one.
 *
 * It used to be two, and neither was a bridge verb: the measured height was
 * written onto `document.documentElement.style.height` and `document.body`
 * for a host that measured the guest DOCUMENT, and posted to the parent as an
 * `ade:plugin-webview-height` frame for a host that listened for one. A page
 * cannot rely on a channel the host never promised to read, and a host cannot
 * be asked to honour two. Both are gone.
 *
 * A host too old to answer `ui.resize` is unharmed: `page.css` gives the
 * `settings-section` placement `height: auto`, so an unmeasured guest still
 * lays out correctly; it just does not resize its own frame.
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
import { reportHeight } from "../host/ui";

export function SettingsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastReportedRef = useRef<number | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const report = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the section's cards
      // use fractional padding, and a rounded-down height clips the last border.
      const measured = node.getBoundingClientRect().height;
      // One frame per real change, not one per layout tick.
      if (measured === lastReportedRef.current) return;
      if (reportHeight(measured) !== null) lastReportedRef.current = measured;
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} style={{ background: "transparent" }}>
      <LinearSection context={context} embedded />
    </div>
  );
}
