import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BrowserIssue } from "../linearIssueBrowserModel";
import type { LinearListRow } from "./linearListModel";
import { safeLoadSelection, safeSaveSelection } from "./linearIssueBrowserData";

/**
 * The list's checked issues (multi-select). The set survives a remount (the
 * launch modal opening over the pane) through localStorage, and persists
 * across searches: a selection is built up by searching for each issue, so
 * picks are resolved from every issue this window has shown, not just the
 * current page.
 */
export function useLinearCheckedIssues({
  projectRoot,
  enabled,
  rows,
  navigable,
  displayIssues,
  visibleIssues,
}: {
  projectRoot: string | null | undefined;
  enabled: boolean;
  rows: LinearListRow[];
  navigable: number[];
  displayIssues: BrowserIssue[];
  /** The issues the list shows, once each; "select all" takes these. */
  visibleIssues: BrowserIssue[];
}): {
  checkedIds: Set<string>;
  setCheckedIds: Dispatch<SetStateAction<Set<string>>>;
  checkedIssues: BrowserIssue[];
  allVisibleChecked: boolean;
  toggleChecked: (issueId: string, rowKey: string | null, shiftKey: boolean) => void;
  toggleAllVisible: () => void;
} {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => safeLoadSelection(projectRoot));
  // The row a Shift-click range starts from (a row key: an issue can show twice).
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const seenIssuesRef = useRef<Map<string, BrowserIssue>>(new Map());
  const [seenVersion, setSeenVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    safeSaveSelection(projectRoot, checkedIds);
  }, [checkedIds, enabled, projectRoot]);

  // Remember every issue shown, so an earlier pick still resolves (and launches)
  // once it is off the current filtered page.
  useEffect(() => {
    if (displayIssues.length === 0) return;
    const map = seenIssuesRef.current;
    let changed = false;
    for (const issue of displayIssues) {
      if (map.get(issue.id) !== issue) {
        map.set(issue.id, issue);
        changed = true;
      }
    }
    if (changed) setSeenVersion((v) => v + 1);
  }, [displayIssues]);

  const checkedIssues = useMemo(() => {
    void seenVersion;
    const out: BrowserIssue[] = [];
    for (const id of checkedIds) {
      const issue = seenIssuesRef.current.get(id) ?? displayIssues.find((entry) => entry.id === id);
      if (issue) out.push(issue);
    }
    return out;
  }, [checkedIds, displayIssues, seenVersion]);

  // Shift extends from the anchor row to this row in the order rows show (by
  // row key, since label grouping can list an issue twice); ids are kept once.
  const toggleChecked = useCallback((issueId: string, rowKey: string | null, shiftKey: boolean) => {
    const positionOfKey = (key: string | null) => (key == null ? -1 : navigable.findIndex((index) => rows[index]?.key === key));
    const endPosition = rowKey != null
      ? positionOfKey(rowKey)
      : navigable.findIndex((index) => {
        const row = rows[index];
        return row?.kind === "issue" && row.issue.id === issueId;
      });
    const startPosition = positionOfKey(anchorKey);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && startPosition !== -1 && endPosition !== -1) {
        const [lo, hi] = startPosition < endPosition ? [startPosition, endPosition] : [endPosition, startPosition];
        for (let position = lo; position <= hi; position += 1) {
          const row = rows[navigable[position]!];
          if (row?.kind === "issue") next.add(row.issue.id);
        }
        return next;
      }
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
    const anchorRow = endPosition !== -1 ? rows[navigable[endPosition]!] : null;
    setAnchorKey(anchorRow?.key ?? rowKey);
  }, [anchorKey, navigable, rows]);

  const allVisibleChecked = visibleIssues.length > 0 && visibleIssues.every((issue) => checkedIds.has(issue.id));
  const toggleAllVisible = useCallback(() => {
    setCheckedIds(allVisibleChecked ? new Set() : new Set(visibleIssues.map((issue) => issue.id)));
  }, [allVisibleChecked, visibleIssues]);

  return { checkedIds, setCheckedIds, checkedIssues, allVisibleChecked, toggleChecked, toggleAllVisible };
}
