/**
 * The lane row badge's card.
 *
 * The `popover` placement the manifest's `row-badge` socket opens. The lanes row
 * still draws the chip — that is ADE's own chrome — and the host pops this over
 * it, so the entry's whole job is to turn the host's pointer into the issue the
 * compiled hover card drew.
 *
 * The compiled badge already HAD the issue: it was a prop off the lane summary.
 * A guest gets an id or a key instead, so the issue is fetched through the
 * plugin's own `pageSearchIssues`, which is the same search the browser uses.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearIssueBadgeCard } from "../components/LinearIssueBadgeCard";
import { linearBrowserIssueToLaneIssue } from "../components/LinearIssueBrowser";
import { getLanes, openChatOnIssue, searchIssues } from "../host/actions";
import { closeSurface, toast } from "../host/ui";
import type { LaneLinearIssue } from "../types";

function pointerString(pointer: Record<string, unknown> | undefined, key: string): string | null {
  const value = pointer?.[key];
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/**
 * Report the card's own height to the host.
 *
 * The bridge has no height verb yet — `AdePluginBridge` carries `surface.close`
 * and nothing that says "I am this tall" — so the only channel a guest has for
 * its measured size is the document itself: the host sizes the popover frame to
 * the guest document, and `documentElement.style.height` is what it reads. The
 * cap is a guard, not a layout: a runaway measurement would otherwise ask the
 * host for an unbounded frame.
 */
function useContentHeight(): (node: HTMLDivElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const height = Math.min(4000, Math.ceil(node.getBoundingClientRect().height));
      if (height > 0) document.documentElement.style.height = `${height}px`;
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
        let key = pointerIssueKey;
        if (!key && laneId) {
          // The pointer carried only an id. The lane row knows the key it drew
          // on the chip, so read it back rather than searching for a raw id
          // Linear's own search does not match on.
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
