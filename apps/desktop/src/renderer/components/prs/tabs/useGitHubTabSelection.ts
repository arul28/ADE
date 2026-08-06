import React from "react";
import type { GitHubPrListItem, GitHubPrSnapshot } from "../../../../shared/types";
import type { PrRouteSelectionTarget } from "../prsRouteState";
import {
  buildProvisionalGithubPrItem,
  bucketForState,
  itemMatchesSelectionTarget,
  matchesFilter,
  selectionTargetForItem,
  selectionTargetKey,
  type GitHubFilter,
  type GitHubFilterSelectionMap,
} from "./githubTabModel";

type SelectPr = (id: string | null, target: PrRouteSelectionTarget | null) => void;
type SelectionState = { key: string | null; bucket: GitHubFilter | null } | undefined;

type SelectionArgs = {
  displayedItems: GitHubPrListItem[];
  filteredItems: GitHubPrListItem[];
  filter: GitHubFilter;
  onSelectPr: SelectPr;
  selectedItemId: string | null;
  selectedPrId: string | null;
  selectedPrTarget: PrRouteSelectionTarget | null | undefined;
  snapshot: GitHubPrSnapshot | null;
  setFilter: React.Dispatch<React.SetStateAction<GitHubFilter>>;
  setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedItemIdsByFilter: React.Dispatch<React.SetStateAction<GitHubFilterSelectionMap>>;
  lastHandledSelectedRef: React.MutableRefObject<SelectionState>;
  pendingSelectedItemIdRef: React.MutableRefObject<string | null>;
  pendingRestoredSelectedItemIdRef: React.MutableRefObject<string | null>;
  hasInitializedSelectionRef: React.MutableRefObject<boolean>;
};

export function useGitHubTabSelection({
  displayedItems,
  filteredItems,
  filter,
  onSelectPr,
  selectedItemId,
  selectedPrId,
  selectedPrTarget,
  snapshot,
  setFilter,
  setSelectedItemId,
  setSelectedItemIdsByFilter,
  lastHandledSelectedRef,
  pendingSelectedItemIdRef,
  pendingRestoredSelectedItemIdRef,
  hasInitializedSelectionRef,
}: SelectionArgs): {
  selectedItem: GitHubPrListItem | null;
  selectedTargetResolved: boolean;
} {
  React.useEffect(() => {
    if (!snapshot) return;

    // An explicit route target is authoritative even when its ADE row has not
    // arrived yet. Resolve by local id first, then by GitHub coordinates (and
    // the stable synthetic id used for unmapped rows).
    const targetItem = selectedPrTarget
      ? displayedItems.find((item) => itemMatchesSelectionTarget(item, selectedPrTarget)) ?? null
      : null;
    const linkedItem = targetItem
      ?? (selectedPrId
        ? displayedItems.find((item) => item.linkedPrId === selectedPrId) ?? null
        : null);
    const currentBucket = linkedItem ? bucketForState(linkedItem.state) : null;
    const nextSelectionKey = selectionTargetKey(selectedPrId, selectedPrTarget);

    const last = lastHandledSelectedRef.current;
    if (last && last.key === nextSelectionKey && last.bucket === currentBucket) return;
    const isNewSelection = !last || last.key !== nextSelectionKey;
    const bucketChanged = !isNewSelection && last!.bucket !== currentBucket;
    lastHandledSelectedRef.current = { key: nextSelectionKey, bucket: currentBucket };

    if (!linkedItem) {
      pendingSelectedItemIdRef.current = null;
      if (selectedPrTarget) {
        setSelectedItemId(null);
        setSelectedItemIdsByFilter((prev) => prev[filter] == null ? prev : { ...prev, [filter]: null });
      }
      return;
    }

    pendingSelectedItemIdRef.current = linkedItem.id;
    const linkedFilter = bucketForState(linkedItem.state);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [linkedFilter]: linkedItem.id }));
    // Follow the selection into its bucket on a fresh selection, or when the
    // already-selected PR transitions to a new bucket (so a merge/close does
    // not strand the user on a now-empty list). Never on a manual filter switch.
    if ((isNewSelection || bucketChanged) && !matchesFilter(linkedItem, filter)) {
      setFilter(linkedFilter);
    }
    setSelectedItemId(linkedItem.id);
    hasInitializedSelectionRef.current = true;
  }, [
    displayedItems,
    filter,
    hasInitializedSelectionRef,
    lastHandledSelectedRef,
    pendingSelectedItemIdRef,
    selectedPrId,
    selectedPrTarget,
    setFilter,
    setSelectedItemId,
    setSelectedItemIdsByFilter,
    snapshot,
  ]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (pendingSelectedItemIdRef.current) {
      if (selectedItemId === pendingSelectedItemIdRef.current) {
        pendingSelectedItemIdRef.current = null;
      } else {
        return;
      }
    }

    if (selectedItemId && filteredItems.some((item) => item.id === selectedItemId)) return;
    // Never replace an explicit deep-link target with the first row while the
    // snapshot is still hydrating (or when GitHub does not return that PR).
    const hasExplicitSelection = Boolean(
      selectedPrId
      || selectedPrTarget?.prId
      || selectedPrTarget?.prNumber != null,
    );
    if (hasExplicitSelection || hasInitializedSelectionRef.current) return;

    const next = filteredItems[0] ?? null;
    if (next) {
      hasInitializedSelectionRef.current = true;
      setSelectedItemId(next.id);
      setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: next.id }));
      onSelectPr(next.linkedPrId ?? null, selectionTargetForItem(next));
    }
  }, [
    filter,
    filteredItems,
    hasInitializedSelectionRef,
    onSelectPr,
    pendingSelectedItemIdRef,
    selectedItemId,
    selectedPrId,
    selectedPrTarget,
    setSelectedItemId,
    setSelectedItemIdsByFilter,
    snapshot,
  ]);

  const selectedItem = React.useMemo((): GitHubPrListItem | null => {
    if (!selectedPrTarget && !selectedItemId) return null;
    if (selectedPrTarget) {
      const byTarget = displayedItems.find((candidate) => itemMatchesSelectionTarget(candidate, selectedPrTarget)) ?? null;
      if (byTarget) return byTarget;
      // An explicit coordinate target is authoritative; never reuse the prior
      // row while its snapshot/detail is still resolving.
      return selectedPrTarget.prNumber != null
        ? buildProvisionalGithubPrItem(selectedPrTarget)
        : null;
    }
    if (selectedItemId) {
      const byId = displayedItems.find((candidate) => candidate.id === selectedItemId) ?? null;
      if (byId) return byId;
    }
    if (selectedPrId) return displayedItems.find((candidate) => candidate.linkedPrId === selectedPrId) ?? null;
    return null;
  }, [displayedItems, selectedItemId, selectedPrId, selectedPrTarget]);

  const selectedTargetResolved = !selectedPrTarget
    || displayedItems.some((item) => itemMatchesSelectionTarget(item, selectedPrTarget));

  React.useEffect(() => {
    const pending = pendingRestoredSelectedItemIdRef.current;
    if (!pending || !selectedItem || selectedItem.id !== pending) return;
    // Restore selection only once the item is actually in the active filter's
    // list — matching the original filter-scoped restore semantics.
    if (!matchesFilter(selectedItem, filter)) return;
    pendingRestoredSelectedItemIdRef.current = null;
    onSelectPr(selectedItem.linkedPrId ?? null, selectionTargetForItem(selectedItem));
  }, [filter, onSelectPr, pendingRestoredSelectedItemIdRef, selectedItem]);

  return { selectedItem, selectedTargetResolved };
}
