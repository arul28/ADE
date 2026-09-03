/**
 * The launch form, as a `composer-picker`.
 *
 * A composer picker is not a viewport. It is a popover the host draws AROUND
 * this guest, anchored to the machine row that opened it, so the host has to be
 * told how tall the form is — and `ui.resize` is the verb that tells it. One
 * channel, and only one.
 *
 * A host too old to answer `ui.resize` is unharmed: `page.css` gives the
 * `composer-picker` placement `height: auto`, so an unmeasured guest still lays
 * out correctly; it just does not resize its own frame. And the root here is
 * transparent with no page-sized ground behind it, because the popover's own
 * surface is what the reader sees around the fields.
 */

import React, { useEffect, useRef } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LaunchForm } from "../components/LaunchForm";
import { reportHeight } from "../host/ui";
import { readDraft, readLaneId } from "../lib/subject";

export function LaunchEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastReportedRef = useRef<number | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const report = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the form's rows use
      // fractional padding, and a rounded-down height clips the last border.
      const measured = node.getBoundingClientRect().height;
      // One frame per real change, not one per layout tick. The form grows and
      // shrinks as the secrets list opens and as a model with reasoning rungs
      // is chosen, so this fires often and each report costs a host relayout.
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
      <LaunchForm initialLaneId={readLaneId(context)} initialDraft={readDraft(context)} />
    </div>
  );
}
