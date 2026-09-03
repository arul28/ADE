/**
 * The `launch` surface — an anchored popover.
 *
 * Two sockets open it and both hand it a subject: the PR toolbar button
 * (`openLaunchFromPr`, subject `{kind: "pr", id, laneId, number}`) and the
 * command palette (`palette-launch`, no subject). The first locks the form to
 * `pr` mode and `auto_publish`, which is exactly what the compiled
 * `PrRequestAiReviewDialog` did; the second is the ordinary form.
 *
 * There is no Cancel: the host's popover has its own dismissal, and a page that
 * could close a placement it merely occupies would be reaching past itself. On a
 * successful start it asks the host to close, and sends the reader to the run —
 * the compiled dialog closed itself and left the run to be found in the Review
 * tab, which is one step worse.
 *
 * The popover reports its own height so the host can size the card to it, which
 * is what `page.css` leaves the body `height: auto` for.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { ReviewLaunchForm } from "../components/ReviewLaunchForm";
import { getLaunchContext } from "../host/actions";
import { closeSurface, openLink, reportHeight } from "../host/ui";
import { laneIdFromContext, prFromContext } from "../lib/reviewRouteState";
import type { PageReviewLaunchContext } from "../types";

export function LaunchEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const [launchContext, setLaunchContext] = React.useState<PageReviewLaunchContext | null>(null);
  const [loading, setLoading] = React.useState(true);
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  const pr = React.useMemo(() => prFromContext(context), [context]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await getLaunchContext();
        if (!cancelled) setLaunchContext(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Report the card's height whenever the form grows.
   *
   * The target-mode toggle swaps a commit-range block in and out and the height
   * changes by a couple of hundred pixels; a popover sized once on open would
   * clip it. `ResizeObserver` is the same one the host's own content-sized
   * placements use, and `reportHeight` clamps and drops the call on a host with
   * no `ui.resize`.
   */
  React.useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reportHeight(node.scrollHeight));
    observer.observe(node);
    reportHeight(node.scrollHeight);
    return () => observer.disconnect();
  }, []);

  const handleStarted = React.useCallback((runId: string) => {
    // Into the run, not just out of the popover: the reader pressed Start to
    // watch a review, and the runs surface is where it is watched.
    //
    // `ctx` is the ONLY parameter `ade://plugin/<id>/<panel>` passes through —
    // every other query key is silently discarded — so the run id rides inside
    // it as JSON, capped by the host at 2 KiB.
    const ctx = encodeURIComponent(JSON.stringify({ runId }));
    void openLink(`ade://plugin/ade-review/runs?ctx=${ctx}`);
    void closeSurface();
  }, []);

  return (
    <div ref={hostRef} className="min-w-0 bg-[var(--color-bg)] p-4 text-[var(--color-fg)]">
      <div className="mb-3">
        <div className="text-sm font-semibold text-[#F5FAFF]">
          {pr ? "Request AI review" : "Launch review"}
        </div>
        <div className="mt-0.5 text-[11px] text-[#94A3B8]">
          {pr
            ? "Run a read-only review on this PR's lane and post findings to GitHub as review comments."
            : "Choose a lane and review target, then start a read-only inspection run."}
        </div>
      </div>
      <ReviewLaunchForm
        launchContext={launchContext}
        loading={loading}
        initialLaneId={laneIdFromContext(context)}
        pr={pr}
        onStarted={handleStarted}
      />
    </div>
  );
}
