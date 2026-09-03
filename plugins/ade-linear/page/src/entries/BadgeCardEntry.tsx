/**
 * The lane row badge's card.
 *
 * The `popover` placement the manifest's `row-badge` socket opens. The lanes row
 * still draws the chip — that is ADE's own chrome — and the host pops this over
 * it, so the entry's whole job is to turn the host's pointer into the issue the
 * compiled hover card drew.
 *
 * The compiled badge already HAD the issue: it was a prop off the lane summary.
 * A guest gets an id or a key instead, so the issue is fetched — by ID when the
 * pointer carries one, through `pageIssueById`, and by KEY otherwise, through
 * the same `pageSearchIssues` the browser uses.
 *
 * The id read is the one that closes the old failure. Linear's search does not
 * match a raw uuid, so a pointer carrying an id and no key anywhere on the lane
 * row used to draw "No Linear issue on this lane" over an issue that plainly
 * existed. Nothing about the card changes; it is simply given the issue.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearIssueBadgeCard } from "../components/LinearIssueBadgeCard";
import { linearBrowserIssueToLaneIssue } from "../components/LinearIssueBrowser";
import { getIssueById, getLanes, openChatOnIssue, searchIssues } from "../host/actions";
import { closeSurface, reportHeight, toast } from "../host/ui";
import type { LaneLinearIssue } from "../types";

function pointerString(pointer: Record<string, unknown> | undefined, key: string): string | null {
  const value = pointer?.[key];
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/**
 * Report this surface's own content height to the host.
 *
 * `ui.resize` is the ONE height channel. The page used to report the same
 * number two other ways — writing it onto `documentElement.style.height` for a
 * host that measured the guest document, and posting an
 * `ade:plugin-webview-height` frame to the parent for a host that listened —
 * and neither was a bridge verb, so neither was something a host was obliged to
 * honour. Both are gone; `host/ui.ts:reportHeight` clamps and delivers.
 *
 * The last reported height is remembered so a `ResizeObserver` firing on every
 * layout tick sends one frame per real change rather than one per tick.
 */
function useContentHeight(): (node: HTMLDivElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastRef = useRef<number | null>(null);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    lastRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the cards use
      // fractional padding, and a rounded-down height clips the last border.
      const measured = node.getBoundingClientRect().height;
      if (measured === lastRef.current) return;
      const reported = reportHeight(measured);
      if (reported !== null) lastRef.current = measured;
    };
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    observerRef.current = observer;
    apply();
  }, []);
}

export function BadgeCardEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const measure = useContentHeight();
  const subject = context.subject;
  const laneId = useMemo(() => {
    if (!subject || subject.kind !== "lane") return null;
    return typeof subject.id === "string" && subject.id.length ? subject.id : null;
  }, [subject]);
  const pointerIssueId = pointerString(context.pointer, "issueId");
  const pointerIssueKey = pointerString(context.pointer, "issueKey")
    ?? pointerString(context.pointer, "issueIdentifier");

  const [issue, setIssue] = useState<LaneLinearIssue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // An id is the direct answer and is tried first: `pageIssueById` reads
        // the stored row, then fetches the single issue from Linear, and
        // neither step needs a key. Only when it answers nothing — an id from a
        // workspace this machine cannot read — does the key path run.
        if (pointerIssueId) {
          const byId = await getIssueById(pointerIssueId);
          if (cancelled) return;
          if (byId) {
            setIssue(linearBrowserIssueToLaneIssue(byId));
            setError(null);
            return;
          }
        }

        let key = pointerIssueKey;
        if (!key && laneId) {
          // No id, or an id nothing could name. The lane row knows the key it
          // drew on the chip, so read it back.
          const lanes = await getLanes();
          const lane = lanes.find((row) => row.id === laneId);
          key = lane?.linearIssueKey?.trim()
            ?? lane?.linearIssueLinks?.find((link) => link.issueId === pointerIssueId)?.issueKey?.trim()
            ?? null;
        }
        if (!key) {
          if (!cancelled) setError("No Linear issue on this lane.");
          return;
        }
        const result = await searchIssues({ query: key, first: 1 });
        const found = result.issues.find((row) => row.id === pointerIssueId)
          ?? result.issues[0]
          ?? null;
        if (cancelled) return;
        if (!found) {
          setError(`Could not find ${key} in Linear.`);
          return;
        }
        setIssue(linearBrowserIssueToLaneIssue(found));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not read the issue.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [laneId, pointerIssueId, pointerIssueKey]);

  /**
   * `onStartChatWithIssue` was the lane row's own handler in the compiled badge.
   * Its page counterpart is `pageOpenChat`, which opens a chat in the lane with
   * the issue attached; the popover closes behind it because the reader is now
   * looking at the chat.
   */
  const handleStartChat = useCallback(() => {
    if (!issue) return;
    void (async () => {
      try {
        const result = await openChatOnIssue({ issueId: issue.id, laneId });
        if (!result?.ok) {
          void toast({
            level: "error",
            message: result?.message || `Could not start a chat on ${issue.identifier}.`,
          });
          return;
        }
        await closeSurface();
      } catch (err) {
        void toast({
          level: "error",
          message: err instanceof Error ? err.message : `Could not start a chat on ${issue.identifier}.`,
        });
      }
    })();
  }, [issue, laneId]);

  // No page-sized ground: the host paints the popover's frame, so the only box
  // the page draws is the card's own 280px column.
  return (
    <div ref={measure} className="w-[280px]">
      {issue ? (
        <LinearIssueBadgeCard issue={issue} onStartChatWithIssue={handleStartChat} />
      ) : (
        <div className="px-3 py-2.5 text-[11px] text-muted-fg/55">
          {error ?? "Loading…"}
        </div>
      )}
    </div>
  );
}
