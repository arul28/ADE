import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  NormalizedLinearIssue,
  OpenProjectBinding,
} from "../../../../shared/types";
import { subscribeIssueCreated } from "../../../lib/issueCreateRequests";
import { showToast } from "../toast/toastStore";
import { applyIssueEdit, type BrowserIssue, type LinearIssueEdit } from "../linearIssueBrowserModel";
import {
  LINEAR_BROWSER_CACHE_MAX_DETAILS,
  cacheIsFresh,
  getBrowserCacheEntry,
  trimMap,
} from "./linearIssueBrowserData";

type EditSnapshot = {
  list: NormalizedLinearIssue | null;
  detail: NormalizedLinearIssue | null;
  external: NormalizedLinearIssue | null;
};

/**
 * Full issue reads (with relations) for the Linear window, issues opened from
 * outside the list (a relation, a favorite, a just-created issue), and
 * optimistic edits. Reads and writes go to `pin`, the Linear reader machine.
 */
export function useLinearIssueDetails({
  cacheKey,
  pin,
  catalog,
  patchIssue,
  listedIssues,
  onOpened,
  onEdited,
}: {
  cacheKey: string;
  pin: OpenProjectBinding | null;
  catalog: CtoGetLinearIssuePickerDataResult;
  /** Patches the list's copy of an issue; returns the copy it replaced. */
  patchIssue: (issueId: string, apply: (current: NormalizedLinearIssue) => NormalizedLinearIssue) => NormalizedLinearIssue | null;
  /** What the list shows; an issue opened from there is selected without a read. */
  listedIssues: BrowserIssue[];
  /** Selects an issue (listed, read, or just created) in the window. */
  onOpened: (issueId: string) => void;
  /** Linear took an edit: counts may have moved. */
  onEdited: () => void;
}) {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // An issue opened from a relation that is not in the current list.
  const [externalIssue, setExternalIssue] = useState<NormalizedLinearIssue | null>(null);
  const [detailIssues, setDetailIssues] = useState<Map<string, NormalizedLinearIssue>>(() => new Map());
  const [loadingRelationId, setLoadingRelationId] = useState<string | null>(null);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;

  const showDetail = useCallback((issue: NormalizedLinearIssue) => {
    setDetailIssues((current) => {
      if (current.get(issue.id) === issue) return current;
      const next = new Map(current);
      next.set(issue.id, issue);
      return next;
    });
  }, []);

  const rememberDetail = useCallback((issue: NormalizedLinearIssue) => {
    const entry = getBrowserCacheEntry(cacheKey);
    entry.details.set(issue.id, { issue, fetchedAt: Date.now() });
    trimMap(entry.details, LINEAR_BROWSER_CACHE_MAX_DETAILS);
    showDetail(issue);
  }, [cacheKey, showDetail]);

  const fetchIssueDetail = useCallback(async (issueId: string): Promise<NormalizedLinearIssue | null> => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cached = entry.details.get(issueId);
    if (cached && cacheIsFresh(cached.fetchedAt)) {
      showDetail(cached.issue);
      return cached.issue;
    }
    const fn = window.ade?.cto?.getLinearIssue;
    const readPin = pinRef.current;
    if (!fn || !readPin) return null;
    const issue = await fn({ issueId }, readPin);
    if (issue) rememberDetail(issue);
    return issue;
  }, [cacheKey, rememberDetail, showDetail]);

  /**
   * Another project or machine: forget what this window shows. The module
   * cache is per project and machine, so its reads stay for a switch back.
   */
  const resetDetails = useCallback(() => {
    setDetailIssues(new Map());
    setExternalIssue(null);
  }, []);

  /** A refresh press: drop every detail read so the next selection reads Linear again. */
  const refreshDetails = useCallback(() => {
    getBrowserCacheEntry(cacheKey).details.clear();
    setDetailIssues(new Map());
  }, [cacheKey]);

  // An issue made from the pane's "New" is selected at once; the list gains it
  // at its next refresh.
  useEffect(() => subscribeIssueCreated((event) => {
    if (event.provider !== "linear") return;
    rememberDetail(event.issue);
    setExternalIssue(event.issue);
    onOpenedRef.current(event.issue.id);
  }), [rememberDetail]);

  const openIssueById = useCallback(async (idOrIdentifier: string, label: string) => {
    const listed = listedIssues.find((issue) => issue.id === idOrIdentifier || issue.identifier === idOrIdentifier);
    if (listed) {
      onOpenedRef.current(listed.id);
      return;
    }
    setLoadingRelationId(idOrIdentifier);
    try {
      const issue = await fetchIssueDetail(idOrIdentifier);
      if (!issue) {
        showToast({ tone: "warning", title: `Couldn't open ${label}`, message: "Linear did not return that issue." });
        return;
      }
      setExternalIssue(issue);
      onOpenedRef.current(issue.id);
    } catch (err) {
      showToast({
        tone: "error",
        title: `Couldn't open ${label}`,
        message: err instanceof Error ? err.message : "Linear request failed.",
      });
    } finally {
      setLoadingRelationId(null);
    }
  }, [fetchIssueDetail, listedIssues]);

  // Optimistic edit: patch every local copy, send one issueUpdate, then take
  // Linear's copy on success or restore the snapshot and toast on failure.
  // The list model regroups at once, so a status edit moves the row.
  const canEditIssues = typeof window !== "undefined" && typeof window.ade?.cto?.updateLinearIssue === "function";
  const editSequenceRef = useRef(new Map<string, number>());
  // One chain of quick edits per issue: the copy from before its first edit,
  // and whether an earlier edit in it failed, so the last failure restores
  // the starting copy instead of a failed edit's optimistic one.
  const editChainRef = useRef(new Map<string, { snapshot: EditSnapshot; earlierFailed: boolean }>());
  const editIssue = useCallback(async (issue: BrowserIssue, edit: LinearIssueEdit) => {
    const update = window.ade?.cto?.updateLinearIssue;
    const writePin = pinRef.current;
    if (!update || !writePin) return;
    const issueId = issue.id;
    // Two quick edits on one issue: only the newest one's result (or rollback) lands.
    const sequence = (editSequenceRef.current.get(issueId) ?? 0) + 1;
    editSequenceRef.current.set(issueId, sequence);
    const isLatest = () => editSequenceRef.current.get(issueId) === sequence;
    const snapshot: EditSnapshot = {
      list: null,
      detail: detailIssues.get(issueId) ?? null,
      external: externalIssue?.id === issueId ? externalIssue : null,
    };
    let chain = editChainRef.current.get(issueId);
    if (!chain) {
      chain = { snapshot, earlierFailed: false };
      editChainRef.current.set(issueId, chain);
    }
    // Returns the list copy it replaced.
    const patchLocal = (apply: (current: NormalizedLinearIssue) => NormalizedLinearIssue) => {
      const replaced = patchIssue(issueId, apply);
      setDetailIssues((current) => {
        const existing = current.get(issueId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(issueId, apply(existing));
        return next;
      });
      setExternalIssue((current) => (current && current.id === issueId ? apply(current) : current));
      return replaced;
    };
    snapshot.list = patchLocal((current) => applyIssueEdit(current, edit, catalog));
    setPendingEditIds((current) => new Set(current).add(issueId));
    const entry = getBrowserCacheEntry(cacheKey);
    try {
      const updated = await update({ issueId, ...edit }, writePin);
      entry.searches.clear();
      entry.counts.clear();
      if (!isLatest()) return;
      if (updated) {
        rememberDetail(updated);
        patchLocal(() => updated);
      } else {
        entry.details.delete(issueId);
      }
      onEdited();
    } catch (err) {
      showToast({
        tone: "error",
        title: `Couldn't update ${issue.identifier}`,
        message: err instanceof Error ? err.message : "Linear rejected the change.",
      });
      if (!isLatest()) {
        chain.earlierFailed = true;
        return;
      }
      const restore = chain.earlierFailed ? chain.snapshot : snapshot;
      const listBefore = restore.list;
      if (listBefore) patchIssue(issueId, () => listBefore);
      setDetailIssues((current) => {
        const next = new Map(current);
        if (restore.detail) next.set(issueId, restore.detail);
        else next.delete(issueId);
        return next;
      });
      setExternalIssue((current) => (current && current.id === issueId && restore.external ? restore.external : current));
    } finally {
      if (isLatest()) {
        // Keep the sequence counting up so an older edit still in flight never
        // matches a new chain's number; only the chain itself ends here.
        if (editChainRef.current.get(issueId) === chain) editChainRef.current.delete(issueId);
        setPendingEditIds((current) => {
          const next = new Set(current);
          next.delete(issueId);
          return next;
        });
      }
    }
  }, [cacheKey, catalog, detailIssues, externalIssue, onEdited, patchIssue, rememberDetail]);

  return {
    externalIssue,
    detailIssues,
    loadingRelationId,
    pendingEditIds,
    canEditIssues,
    fetchIssueDetail,
    resetDetails,
    refreshDetails,
    openIssueById,
    editIssue,
  };
}
