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
import { useCollectionChanges } from "../host/useHostEntities";
import type { LaneLinearIssue } from "../types";

/**
 * Report the pane's own height to the host.
 *
 * Same reason as the badge card: the bridge has no height verb yet, so the
 * document's own height is the only channel a guest has for its measured size,
 * and the host sizes the pane's frame to it. The 4000px cap is a guard against a
 * runaway measurement asking for an unbounded frame.
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
