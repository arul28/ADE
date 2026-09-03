/**
 * The transcript's Linear issue context.
 *
 * The pane the compiled `UserMessageIssueContext` drew under a user message.
 * The app read the turn's own `contextAttachments`; a guest cannot see a
 * transcript, so the same fact arrives the other way round — the lane rows carry
 * `linearIssueLinks`, each `{issueId, issueKey, sessionId}`, and the links whose
 * `sessionId` is this subject's session are exactly the issues that turn
 * carried.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { IssueContextPane } from "../components/IssueContextPane";
import { linearBrowserIssueToLaneIssue } from "../components/LinearIssueBrowser";
import { getLanes, searchIssues } from "../host/actions";
import { reportHeight } from "../host/ui";
import { useCollectionChanges } from "../host/useHostEntities";
import type { LaneLinearIssue } from "../types";

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

export function IssueContextEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const measure = useContentHeight();
  const subject = context.subject;
  const sessionId = useMemo(() => {
    if (!subject || subject.kind !== "session") return null;
    return typeof subject.id === "string" && subject.id.length ? subject.id : null;
  }, [subject]);

  const [issues, setIssues] = useState<LaneLinearIssue[]>([]);
  const [laneId, setLaneId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    if (!sessionId) {
      setIssues([]);
      setLaneId(null);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    void (async () => {
      try {
        const lanes = await getLanes();
        const lane = lanes.find((row) => (row.linearIssueLinks ?? []).some((link) => link.sessionId === sessionId));
        const links = (lane?.linearIssueLinks ?? []).filter((link) => link.sessionId === sessionId);
        if (requestRef.current !== requestId) return;
        setLaneId(lane?.id ?? null);
        if (!links.length) {
          setIssues([]);
          return;
        }
        // One search per link, by the key the link carries — `pageSearchIssues`
        // is the only read the page has that answers a whole issue, and the
        // links carry identity only.
        const resolved = await Promise.all(links.map(async (link) => {
          const key = link.issueKey?.trim();
          if (!key) return null;
          try {
            const result = await searchIssues({ query: key, first: 1 });
            const found = result.issues.find((row) => row.id === link.issueId) ?? result.issues[0] ?? null;
            return found ? linearBrowserIssueToLaneIssue(found) : null;
          } catch {
            return null;
          }
        }));
        if (requestRef.current !== requestId) return;
        setIssues(resolved.filter((row): row is LaneLinearIssue => row != null));
      } catch {
        if (requestRef.current === requestId) setIssues([]);
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);
  useCollectionChanges(load);

  // Content sizing, and no page-sized ground: the host draws the transcript row
  // around this, so the page paints only the chips.
  return (
    <div ref={measure}>
      <IssueContextPane issues={issues} laneId={laneId} />
    </div>
  );
}
