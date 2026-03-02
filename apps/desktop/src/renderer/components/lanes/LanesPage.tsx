import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { Check, CaretDown, FileCode, GitBranch, House, Stack, Link, ArrowsOutSimple, ArrowsInSimple, PushPin, Plus, MagnifyingGlass, Terminal, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { PaneTilingLayout } from "../ui/PaneTilingLayout";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, inlineBadge, outlineButton, primaryButton, conflictDotColor } from "./laneDesignTokens";
import { ResizeGutter } from "../ui/ResizeGutter";
import { LaneStackPane } from "./LaneStackPane";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { LaneDiffPane } from "./LaneDiffPane";
import { LaneWorkPane } from "./LaneWorkPane";
import { LaneInspectorPane } from "./LaneInspectorPane";
import { CreateLaneDialog } from "./CreateLaneDialog";
import { AttachLaneDialog } from "./AttachLaneDialog";
import { ManageLaneDialog } from "./ManageLaneDialog";
import { LaneContextMenu } from "./LaneContextMenu";
import { LaneRestackBanner } from "./LaneRestackBanner";
import {
  sortLanesForTabs,
  sortLanesForStackGraph,
  mergeUnique,
  laneMatchesFilter,
  chipLabel,
  LANES_TILING_TREE,
  GIT_ACTIONS_FULLSCREEN_TREE,
  RESIZE_TARGET_MINIMUM_SIZE,
  EMPTY_LANE_PANE_DETAIL,
  formatBranchCheckoutError,
  type LanePaneDetailSelection,
  type LaneBranchOption
} from "./laneUtils";
import type {
  ConflictChip,
  ConflictStatus,
  DeleteLaneArgs,
  GitCommitSummary,
  LaneSummary,
  RestackSuggestion,
  AutoRebaseLaneStatus
} from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";

/* ---- Component ---- */

export function LanesPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const keybindings = useAppStore((s) => s.keybindings);
  const project = useAppStore((s) => s.project);
  const terminalAttention = useAppStore((s) => s.terminalAttention);

  const [activeLaneIds, setActiveLaneIds] = useState<string[]>([]);
  const [pinnedLaneIds, setPinnedLaneIds] = useState<Set<string>>(new Set());
  const [laneFilter, setLaneFilter] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLaneName, setCreateLaneName] = useState("");
  const [createParentLaneId, setCreateParentLaneId] = useState<string>("");
  const [createAsChild, setCreateAsChild] = useState(false);
  const [createBaseBranch, setCreateBaseBranch] = useState("");
  const [createBranches, setCreateBranches] = useState<LaneBranchOption[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachPath, setAttachPath] = useState("");
  const canCreateLane = Boolean(project?.rootPath);
  const [deleteMode, setDeleteMode] = useState<"worktree" | "local_branch" | "remote_branch">("worktree");
  const [deleteRemoteName, setDeleteRemoteName] = useState("origin");
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [conflictStatusByLane, setConflictStatusByLane] = useState<Record<string, ConflictStatus>>({});
  const [conflictChipsByLane, setConflictChipsByLane] = useState<Record<string, ConflictChip[]>>({});
  const chipTimersRef = useRef<Map<string, number>>(new Map());
  const [restackSuggestions, setRestackSuggestions] = useState<RestackSuggestion[]>([]);
  const [autoRebaseStatuses, setAutoRebaseStatuses] = useState<AutoRebaseLaneStatus[]>([]);
  const [autoRebaseEnabled, setAutoRebaseEnabled] = useState(false);
  const [restackBusyLaneId, setRestackBusyLaneId] = useState<string | null>(null);
  const [restackSuggestionError, setRestackSuggestionError] = useState<string | null>(null);

  const [primaryBranches, setPrimaryBranches] = useState<LaneBranchOption[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchCheckoutBusy, setBranchCheckoutBusy] = useState(false);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const [addLaneDropdownOpen, setAddLaneDropdownOpen] = useState(false);
  const addLaneDropdownRef = useRef<HTMLDivElement>(null);

  const [lanePaneDetails, setLanePaneDetails] = useState<Record<string, LanePaneDetailSelection>>({});
  const [laneContextMenu, setLaneContextMenu] = useState<{ laneId: string; x: number; y: number } | null>(null);
  const [expandedLaneId, setExpandedLaneId] = useState<string | null>(null);
  const [expandedGitActionsLaneId, setExpandedGitActionsLaneId] = useState<string | null>(null);

  const sortedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const lanesById = useMemo(() => new Map(sortedLanes.map((lane) => [lane.id, lane])), [sortedLanes]);
  const restackByLaneId = useMemo(
    () => new Map(restackSuggestions.map((s) => [s.laneId, s] as const)),
    [restackSuggestions]
  );
  const autoRebaseByLaneId = useMemo(
    () => new Map(autoRebaseStatuses.map((s) => [s.laneId, s] as const)),
    [autoRebaseStatuses]
  );

  const filteredLanes = useMemo(() => {
    return sortedLanes.filter((lane) => laneMatchesFilter(lane, pinnedLaneIds.has(lane.id), laneFilter));
  }, [sortedLanes, laneFilter, pinnedLaneIds]);
  const stackGraphLanes = useMemo(() => sortLanesForStackGraph(filteredLanes), [filteredLanes]);

  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);
  const filteredSet = useMemo(() => new Set(filteredLaneIds), [filteredLaneIds]);
  const visibleRestackSuggestions = useMemo(() => {
    const laneIdSet = new Set(filteredLaneIds);
    return restackSuggestions.filter((s) => laneIdSet.has(s.laneId));
  }, [restackSuggestions, filteredLaneIds]);
  const visibleAutoRebaseNeedsAttention = useMemo(() => {
    const laneIdSet = new Set(filteredLaneIds);
    return autoRebaseStatuses.filter((s) => laneIdSet.has(s.laneId) && s.state !== "autoRebased");
  }, [autoRebaseStatuses, filteredLaneIds]);
  const showAutoRebaseSettingsHint = !autoRebaseEnabled && (visibleRestackSuggestions.length > 0 || visibleAutoRebaseNeedsAttention.length > 0);

  const activeWithPins = useMemo(
    () => mergeUnique(activeLaneIds, Array.from(pinnedLaneIds).filter((id) => lanesById.has(id))),
    [activeLaneIds, pinnedLaneIds, lanesById]
  );
  const visibleLaneIds = useMemo(
    () => activeWithPins.filter((id) => lanesById.has(id) && filteredSet.has(id)),
    [activeWithPins, lanesById, filteredSet]
  );

  const managedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
  const deletePhrase = managedLane ? `delete ${managedLane.name}` : "";

  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  /* ---- Primary branch management ---- */

  useEffect(() => {
    if (!primaryLane) return;
    window.ade.git.listBranches({ laneId: primaryLane.id })
      .then(setPrimaryBranches)
      .catch(() => {});
  }, [primaryLane?.id, primaryLane?.branchRef]);

  useEffect(() => {
    if (!primaryLane) return;
    const current = primaryBranches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null;
    if (!current || current === primaryLane.branchRef) return;
    refreshLanes().catch(() => {});
  }, [primaryBranches, primaryLane?.id, primaryLane?.branchRef, refreshLanes]);

  useClickOutside(branchDropdownRef, () => setBranchDropdownOpen(false), branchDropdownOpen);
  useClickOutside(addLaneDropdownRef, () => setAddLaneDropdownOpen(false), addLaneDropdownOpen);

  /* ---- Conflict loading ---- */

  const loadConflictStatuses = useCallback(async () => {
    try {
      const assessment = await window.ade.conflicts.getBatchAssessment();
      const next: Record<string, ConflictStatus> = {};
      for (const status of assessment.lanes) next[status.laneId] = status;
      setConflictStatusByLane(next);
    } catch { /* best effort */ }
  }, []);

  const refreshRestackSuggestions = useCallback(async () => {
    try {
      const next = await window.ade.lanes.listRestackSuggestions();
      setRestackSuggestions(next);
    } catch { /* best effort */ }
  }, []);

  const refreshAutoRebaseStatuses = useCallback(async () => {
    try {
      const next = await window.ade.lanes.listAutoRebaseStatuses();
      setAutoRebaseStatuses(next);
    } catch { /* best effort */ }
  }, []);

  const refreshAutoRebaseEnabled = useCallback(async () => {
    try {
      const snapshot = await window.ade.projectConfig.get();
      const enabled =
        typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
          ? snapshot.effective.git.autoRebaseOnHeadChange
          : false;
      setAutoRebaseEnabled(enabled);
    } catch {
      setAutoRebaseEnabled(false);
    }
  }, []);

  const pushConflictChips = useCallback((chips: ConflictChip[]) => {
    if (chips.length === 0) return;
    setConflictChipsByLane((prev) => {
      const next: Record<string, ConflictChip[]> = { ...prev };
      for (const chip of chips) {
        const laneList = next[chip.laneId] ? [...next[chip.laneId]!] : [];
        laneList.unshift(chip);
        next[chip.laneId] = laneList.slice(0, 3);
      }
      return next;
    });
    for (const chip of chips) {
      const key = `${chip.laneId}:${chip.peerId ?? "base"}:${chip.kind}`;
      const existing = chipTimersRef.current.get(key);
      if (existing) window.clearTimeout(existing);
      const now = Date.now();
      const timer = window.setTimeout(() => {
        setConflictChipsByLane((prev) => {
          const laneChips = prev[chip.laneId] ?? [];
          const filtered = laneChips.filter((entry) => {
            return !(entry.kind === chip.kind && entry.peerId === chip.peerId && entry.overlapCount === chip.overlapCount);
          });
          if (filtered.length === laneChips.length) return prev;
          return { ...prev, [chip.laneId]: filtered };
        });
        chipTimersRef.current.delete(key);
      }, Math.max(8_000, 12_000 - (Date.now() - now)));
      chipTimersRef.current.set(key, timer);
    }
  }, []);

  /* ---- Effects ---- */

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    const inspectorTab = params.get("inspectorTab");
    if (laneId) {
      selectLane(laneId);
      if (inspectorTab === "terminals" || inspectorTab === "context" || inspectorTab === "stack" || inspectorTab === "merge") {
        setLaneInspectorTab(laneId, inspectorTab);
      }
      if (params.get("focus") === "single") {
        setActiveLaneIds([laneId]);
      }
    }
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, setLaneInspectorTab, focusSession]);

  useEffect(() => { void loadConflictStatuses(); }, [loadConflictStatuses, lanes.length]);

  useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type !== "prediction-complete") return;
      void loadConflictStatuses();
      pushConflictChips(event.chips);
    });
    return unsubscribe;
  }, [loadConflictStatuses, pushConflictChips]);

  useEffect(() => {
    void refreshRestackSuggestions();
    const unsubscribe = window.ade.lanes.onRestackSuggestionsEvent((event) => {
      if (event.type !== "restack-suggestions-updated") return;
      setRestackSuggestions(event.suggestions);
    });
    return unsubscribe;
  }, [refreshRestackSuggestions]);

  useEffect(() => {
    void refreshAutoRebaseStatuses();
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      setAutoRebaseStatuses(event.statuses);
    });
    return unsubscribe;
  }, [refreshAutoRebaseStatuses]);

  useEffect(() => { void refreshAutoRebaseEnabled(); }, [refreshAutoRebaseEnabled]);

  useEffect(() => {
    const onFocus = () => { void refreshAutoRebaseEnabled(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAutoRebaseEnabled();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshAutoRebaseEnabled]);

  useEffect(() => {
    return () => {
      for (const timer of chipTimersRef.current.values()) window.clearTimeout(timer);
      chipTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!laneContextMenu) return;
    const onPointerDown = () => setLaneContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [laneContextMenu]);

  useEffect(() => {
    setPinnedLaneIds((prev) => {
      const next = new Set<string>();
      for (const laneId of prev) {
        if (lanesById.has(laneId)) next.add(laneId);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [lanesById]);

  useEffect(() => {
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => lanesById.has(laneId));
    setActiveLaneIds((prev) => {
      const validPrev = prev.filter((laneId) => lanesById.has(laneId));
      const selected = selectedLaneId && lanesById.has(selectedLaneId) ? [selectedLaneId] : [];
      const fallback = selected.length
        ? []
        : validPrev.length
          ? [validPrev[0]!]
          : sortedLanes[0]?.id
            ? [sortedLanes[0]!.id]
            : [];
      return mergeUnique(selected, fallback, validPrev, pinned);
    });
  }, [selectedLaneId, lanesById, sortedLanes, pinnedLaneIds]);

  useEffect(() => {
    setLanePaneDetails((prev) => {
      const next: Record<string, LanePaneDetailSelection> = {};
      for (const [laneId, detail] of Object.entries(prev)) {
        if (lanesById.has(laneId)) next[laneId] = detail;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById]);

  /* ---- Keyboard navigation ---- */

  const stepLaneSelection = useCallback((direction: -1 | 1) => {
    if (filteredLaneIds.length === 0) return;
    const currentId = selectedLaneId && filteredSet.has(selectedLaneId) ? selectedLaneId : filteredLaneIds[0]!;
    const currentIdx = filteredLaneIds.indexOf(currentId);
    const nextIdx = (currentIdx + direction + filteredLaneIds.length) % filteredLaneIds.length;
    const nextId = filteredLaneIds[nextIdx];
    if (!nextId) return;
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => laneId !== nextId && lanesById.has(laneId));
    setActiveLaneIds(mergeUnique([nextId], pinned));
    selectLane(nextId);
  }, [filteredLaneIds, selectedLaneId, filteredSet, pinnedLaneIds, lanesById, selectLane]);

  const kbFilterFocus = useMemo(() => getEffectiveBinding(keybindings, "lanes.filter.focus", "/,Mod+F"), [keybindings]);
  const kbNext = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.next", "J,ArrowDown"), [keybindings]);
  const kbPrev = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prev", "K,ArrowUp"), [keybindings]);
  const kbNextTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.nextTab", "]"), [keybindings]);
  const kbPrevTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prevTab", "["), [keybindings]);
  const kbConfirm = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.confirm", "Enter"), [keybindings]);

  useEffect(() => {
    if (expandedGitActionsLaneId && !lanesById.has(expandedGitActionsLaneId)) {
      setExpandedGitActionsLaneId(null);
    }
  }, [expandedGitActionsLaneId, lanesById]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTyping = isTypingTarget(event.target);
      if (!targetIsTyping && eventMatchesBinding(event, kbFilterFocus)) {
        event.preventDefault();
        const input = document.getElementById("lanes-filter-input");
        if (input instanceof HTMLInputElement) { input.focus(); input.select(); }
        return;
      }
      if (event.key === "Escape" && expandedGitActionsLaneId) {
        event.preventDefault();
        setExpandedGitActionsLaneId(null);
        return;
      }
      if (event.key === "Escape" && expandedLaneId) {
        event.preventDefault();
        setExpandedLaneId(null);
        return;
      }
      if (targetIsTyping) {
        if (event.key === "Escape") {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.id === "lanes-filter-input") {
            event.preventDefault();
            if (laneFilter.length > 0) setLaneFilter("");
            else active.blur();
          }
        }
        return;
      }
      if (eventMatchesBinding(event, kbPrevTab) || eventMatchesBinding(event, kbNextTab)) {
        event.preventDefault();
        stepLaneSelection(eventMatchesBinding(event, kbNextTab) ? 1 : -1);
        return;
      }
      if (eventMatchesBinding(event, kbNext)) { event.preventDefault(); stepLaneSelection(1); return; }
      if (eventMatchesBinding(event, kbPrev)) { event.preventDefault(); stepLaneSelection(-1); return; }
      if (eventMatchesBinding(event, kbConfirm) && filteredLaneIds.length > 0) {
        event.preventDefault();
        const laneId = selectedLaneId && filteredSet.has(selectedLaneId) ? selectedLaneId : filteredLaneIds[0]!;
        const pinned = Array.from(pinnedLaneIds).filter((lane) => lane !== laneId && lanesById.has(lane));
        setActiveLaneIds(mergeUnique([laneId], pinned));
        selectLane(laneId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredLaneIds, filteredSet, selectedLaneId, pinnedLaneIds, lanesById, selectLane, laneFilter, stepLaneSelection, kbFilterFocus, kbNext, kbPrev, kbNextTab, kbPrevTab, kbConfirm, expandedLaneId, expandedGitActionsLaneId]);

  /* ---- Lane management actions ---- */

  const currentPrimaryBranch = useMemo(
    () => primaryBranches.find((branch) => branch.isCurrent)?.name ?? primaryLane?.branchRef ?? "",
    [primaryBranches, primaryLane?.branchRef]
  );
  const localPrimaryBranches = useMemo(
    () => primaryBranches.filter((branch) => !branch.isRemote),
    [primaryBranches]
  );
  const remotePrimaryBranches = useMemo(
    () => primaryBranches.filter((branch) => branch.isRemote),
    [primaryBranches]
  );

  const runLaneAction = async (fn: () => Promise<void>) => {
    setLaneActionBusy(true);
    setLaneActionError(null);
    try {
      await fn();
      await refreshLanes();
      setManageOpen(false);
    } catch (err) {
      setLaneActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaneActionBusy(false);
    }
  };

  const checkoutPrimaryBranch = useCallback(async (branchName: string) => {
    if (!primaryLane) return;
    if (primaryLane.status.dirty) {
      setBranchCheckoutError("Cannot switch branches while primary lane has uncommitted changes. Commit, stash, or discard changes first.");
      return;
    }
    setBranchCheckoutBusy(true);
    setBranchCheckoutError(null);
    let succeeded = false;
    try {
      await window.ade.git.checkoutBranch({ laneId: primaryLane.id, branchName });
      await refreshLanes();
      const updated = await window.ade.git.listBranches({ laneId: primaryLane.id });
      setPrimaryBranches(updated);
      succeeded = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setBranchCheckoutError(formatBranchCheckoutError(raw));
    } finally {
      setBranchCheckoutBusy(false);
      if (succeeded) setBranchDropdownOpen(false);
    }
  }, [primaryLane, refreshLanes]);

  const archiveManagedLane = async () => {
    if (!managedLane || managedLane.laneType === "primary") return;
    await runLaneAction(async () => {
      await window.ade.lanes.archive({ laneId: managedLane.id });
    });
  };

  const deleteManagedLane = async () => {
    if (!managedLane || managedLane.laneType === "primary") return;
    if (deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()) return;
    await runLaneAction(async () => {
      const args: DeleteLaneArgs = { laneId: managedLane.id, force: deleteForce };
      if (deleteMode === "worktree") {
        args.deleteBranch = false;
      } else {
        args.deleteBranch = true;
        if (deleteMode === "remote_branch") {
          args.deleteRemoteBranch = true;
          args.remoteName = deleteRemoteName.trim() || "origin";
        }
      }
      await window.ade.lanes.delete(args);
      if (selectedLaneId === managedLane.id) selectLane(null);
    });
  };

  const handleLaneSelect = useCallback((laneId: string, args: { extend: boolean }) => {
    const lane = lanesById.get(laneId);
    if (!lane) return;

    if (!args.extend) {
      const pinned = Array.from(pinnedLaneIds).filter((id) => id !== laneId && lanesById.has(id));
      setActiveLaneIds(mergeUnique([laneId], pinned));
      selectLane(laneId);
      return;
    }

    const isPinned = pinnedLaneIds.has(laneId);
    const isActive = activeWithPins.includes(laneId);
    if (isPinned && isActive) {
      selectLane(laneId);
      return;
    }

    const next = isActive ? activeWithPins.filter((id) => id !== laneId) : [...activeWithPins, laneId];
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    setActiveLaneIds(mergeUnique(next.length ? next : [laneId], pinned));
    selectLane(laneId);
  }, [lanesById, pinnedLaneIds, activeWithPins, selectLane]);

  const removeSplitLane = useCallback((laneId: string) => {
    if (pinnedLaneIds.has(laneId)) return;
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    const next = activeWithPins.filter((id) => id !== laneId);
    const normalized = mergeUnique(next, pinned);
    setActiveLaneIds(normalized);
    if (!normalized.includes(selectedLaneId ?? "")) {
      selectLane(normalized[0] ?? null);
    }
  }, [pinnedLaneIds, lanesById, activeWithPins, selectedLaneId, selectLane]);

  const togglePinnedLane = useCallback((laneId: string) => {
    const lane = lanesById.get(laneId);
    if (!lane || lane.laneType === "primary") return;
    const isPinned = pinnedLaneIds.has(laneId);
    setPinnedLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
    if (!isPinned) {
      setActiveLaneIds((prev) => mergeUnique(prev, [laneId]));
    }
  }, [lanesById, pinnedLaneIds]);

  const restackNow = async (laneId: string) => {
    setRestackSuggestionError(null);
    setRestackBusyLaneId(laneId);
    try {
      const result = await window.ade.lanes.restack({ laneId, recursive: true });
      if (result.error) throw new Error(result.failedLaneId ? `${result.error} (failed: ${result.failedLaneId})` : result.error);
      await Promise.all([refreshLanes(), refreshRestackSuggestions()]);
    } catch (err) {
      setRestackSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestackBusyLaneId(null);
    }
  };

  const dismissRestackSuggestion = async (laneId: string) => {
    setRestackSuggestionError(null);
    setRestackBusyLaneId(laneId);
    try {
      await window.ade.lanes.dismissRestackSuggestion({ laneId });
      await refreshRestackSuggestions();
    } catch (err) {
      setRestackSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestackBusyLaneId(null);
    }
  };

  const deferRestackSuggestion = async (laneId: string, minutes: number) => {
    setRestackSuggestionError(null);
    setRestackBusyLaneId(laneId);
    try {
      await window.ade.lanes.deferRestackSuggestion({ laneId, minutes });
      await refreshRestackSuggestions();
    } catch (err) {
      setRestackSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestackBusyLaneId(null);
    }
  };

  const openAutoRebaseSettings = useCallback(() => { navigate("/settings"); }, [navigate]);

  const openRebaseConflictResolver = useCallback((laneId: string, parentLaneId: string | null) => {
    const search = new URLSearchParams({ tab: "merge-one", laneAId: laneId });
    if (parentLaneId) search.set("laneBId", parentLaneId);
    navigate(`/conflicts?${search.toString()}`);
  }, [navigate]);

  /* ---- Detail handlers ---- */

  const handleSelectFile = useCallback((laneId: string, path: string, mode: "staged" | "unstaged") => {
    setLanePaneDetails((prev) => ({
      ...prev,
      [laneId]: { selectedFilePath: path, selectedFileMode: mode, selectedCommit: null }
    }));
  }, []);

  const handleSelectCommit = useCallback((laneId: string, commit: GitCommitSummary | null) => {
    setLanePaneDetails((prev) => {
      const prevDetail = prev[laneId] ?? EMPTY_LANE_PANE_DETAIL;
      const nextDetail: LanePaneDetailSelection = commit
        ? { selectedFilePath: null, selectedFileMode: null, selectedCommit: commit }
        : { ...prevDetail, selectedCommit: null };
      return { ...prev, [laneId]: nextDetail };
    });
  }, []);

  /* ---- Create/Attach lane submit handlers ---- */

  const handleCreateSubmit = useCallback(() => {
    const name = createLaneName.trim();
    if (createAsChild && createParentLaneId) {
      window.ade.lanes.createChild({ name, parentLaneId: createParentLaneId })
        .then(async (lane) => {
          await refreshLanes();
          setCreateOpen(false);
          setCreateLaneName("");
          setCreateParentLaneId("");
          setCreateAsChild(false);
          navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
        }).catch(() => {});
    } else {
      const primary = lanes.find((l) => l.laneType === "primary");
      const promise = primary
        ? window.ade.lanes.create({ name, parentLaneId: primary.id })
        : window.ade.lanes.create({ name });
      promise.then(async (lane) => {
        await refreshLanes();
        setCreateOpen(false);
        setCreateLaneName("");
        setCreateParentLaneId("");
        setCreateAsChild(false);
        setCreateBaseBranch("");
        navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
      }).catch(() => {});
    }
  }, [createLaneName, createAsChild, createParentLaneId, lanes, refreshLanes, navigate]);

  const handleAttachSubmit = useCallback(() => {
    const name = attachName.trim();
    const attachedPath = attachPath.trim();
    window.ade.lanes.attach({ name, attachedPath }).then(async (lane) => {
      await refreshLanes();
      setAttachOpen(false);
      setAttachName("");
      setAttachPath("");
      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
    }).catch(() => {});
  }, [attachName, attachPath, refreshLanes, navigate]);

  const openManageDialog = useCallback((laneId: string) => {
    selectLane(laneId);
    setLaneActionError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
  }, [selectLane]);

  /* ---- Pane configs ---- */

  const getPaneConfigs = useCallback((laneId: string | null) => {
    const laneDetail = laneId ? lanePaneDetails[laneId] ?? EMPTY_LANE_PANE_DETAIL : EMPTY_LANE_PANE_DETAIL;
    return {
      "stack": {
        title: "Stack",
        icon: Stack,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneStackPane
            lanes={stackGraphLanes}
            selectedLaneId={laneId}
            onSelect={(id) => handleLaneSelect(id, { extend: false })}
          />
        )
      },
      "git-actions": {
        title: "Git Actions",
        icon: FileCode,
        headerActions: laneId ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title={expandedGitActionsLaneId === laneId ? "Minimize Git Actions pane" : "Expand Git Actions pane"}
            onClick={(event) => {
              event.stopPropagation();
              setExpandedLaneId(null);
              setExpandedGitActionsLaneId((prev) => (prev === laneId ? null : laneId));
            }}
          >
            {expandedGitActionsLaneId === laneId ? <ArrowsInSimple size={12} /> : <ArrowsOutSimple size={12} />}
          </Button>
        ) : null,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneGitActionsPane
            laneId={laneId}
            autoRebaseEnabled={autoRebaseEnabled}
            onOpenSettings={openAutoRebaseSettings}
            onResolveRebaseConflict={openRebaseConflictResolver}
            selectedPath={laneDetail.selectedFilePath}
            selectedMode={laneDetail.selectedFileMode}
            selectedCommitSha={laneDetail.selectedCommit?.sha ?? null}
            onSelectFile={(path, mode) => { if (laneId) handleSelectFile(laneId, path, mode); }}
            onSelectCommit={(commit) => { if (laneId) handleSelectCommit(laneId, commit); }}
          />
        )
      },
      "diff-viewer": {
        title: "Diff",
        icon: FileCode,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneDiffPane
            laneId={laneId}
            selectedPath={laneDetail.selectedFilePath}
            selectedFileMode={laneDetail.selectedFileMode}
            selectedCommit={laneDetail.selectedCommit}
          />
        )
      },
      "work": {
        title: "Work",
        icon: Terminal as any,
        bodyClassName: "overflow-hidden",
        children: <LaneWorkPane laneId={laneId} />
      },
      "inspector": {
        title: "Inspector",
        icon: MagnifyingGlass,
        bodyClassName: "overflow-hidden",
        children: <LaneInspectorPane laneId={laneId} />
      }
    };
  }, [lanePaneDetails, stackGraphLanes, handleLaneSelect, handleSelectFile, handleSelectCommit, expandedGitActionsLaneId, autoRebaseEnabled, openAutoRebaseSettings, openRebaseConflictResolver]);

  /* ---- Render ---- */

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header bar */}
      <div style={{ padding: "0 24px", height: 64, display: "flex", alignItems: "center", gap: 24, background: COLORS.pageBg, borderBottom: `1px solid ${COLORS.border}` }}>
        {/* Numbered title group */}
        <div className="flex items-center gap-2 shrink-0">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.accent }}>05</span>
          <GitBranch size={18} style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>LANES</span>
          <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{filteredLanes.length}</span>
        </div>

        {/* Branch selector */}
        {primaryLane && selectedLaneId === primaryLane.id ? (
          <div className="relative shrink-0" ref={branchDropdownRef}>
            <button
              type="button"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "0 12px", height: 32, fontSize: 12, fontFamily: MONO_FONT, fontWeight: 600,
                color: COLORS.success, background: "#18151F",
                border: `1px solid ${COLORS.outlineBorder}`, cursor: "pointer",
              }}
              onClick={() => setBranchDropdownOpen((prev) => !prev)}
              disabled={branchCheckoutBusy}
            >
              <GitBranch size={14} />
              <span>{currentPrimaryBranch || primaryLane.branchRef}</span>
              <CaretDown size={12} style={{ opacity: 0.6 }} />
            </button>
            {branchDropdownOpen ? (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-80 overflow-auto" style={{ width: 288, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "2px 0" }}>
                <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>LOCAL BRANCHES</div>
                {localPrimaryBranches.map((branch) => (
                  <button
                    key={`local:${branch.name}`}
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    style={{
                      padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                      color: branch.isCurrent ? COLORS.success : COLORS.textMuted,
                      fontWeight: branch.isCurrent ? 600 : 400,
                      background: "transparent", border: "none", cursor: "pointer",
                    }}
                    disabled={branchCheckoutBusy || branch.isCurrent}
                    onClick={async () => {
                      if (branch.isCurrent) return;
                      await checkoutPrimaryBranch(branch.name);
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {branch.isCurrent ? <Check size={12} className="shrink-0" /> : <span className="shrink-0" style={{ width: 12 }} />}
                    <span className="truncate">{branch.name}</span>
                    {branch.upstream ? <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.textDim }}>tracked</span> : null}
                  </button>
                ))}
                {remotePrimaryBranches.length > 0 ? (
                  <>
                    <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                    <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>REMOTE BRANCHES</div>
                    {remotePrimaryBranches.map((branch) => (
                      <button
                        key={`remote:${branch.name}`}
                        type="button"
                        className="flex w-full items-center gap-2 text-left"
                        style={{
                          padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                          color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer",
                        }}
                        disabled={branchCheckoutBusy}
                        onClick={async () => { await checkoutPrimaryBranch(branch.name); }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <span className="shrink-0" style={{ width: 12 }} />
                        <span className="truncate">{branch.name}</span>
                        <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.info }}>remote</span>
                      </button>
                    ))}
                  </>
                ) : null}
                {localPrimaryBranches.length === 0 && remotePrimaryBranches.length === 0 ? (
                  <div style={{ padding: "6px 12px", fontSize: 12, color: COLORS.textMuted }}>No branches found.</div>
                ) : null}
                {branchCheckoutError ? (
                  <div style={{ padding: "6px 12px", fontSize: 11, color: COLORS.danger }}>{branchCheckoutError}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {branchCheckoutError && primaryLane && selectedLaneId === primaryLane.id ? (
          <div className="inline-flex items-center gap-2 shrink-0" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, padding: "4px 8px", fontSize: 12, color: COLORS.danger }}>
            <span>{branchCheckoutError}</span>
            <button
              type="button"
              style={{ background: "transparent", border: "none", padding: "0 4px", color: COLORS.danger, cursor: "pointer", fontSize: 14 }}
              onClick={() => setBranchCheckoutError(null)}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {/* Filter input */}
        <div className="relative flex items-center shrink-0">
          <MagnifyingGlass size={14} className="pointer-events-none absolute" style={{ left: 8, color: COLORS.textDim }} />
          <input
            id="lanes-filter-input"
            value={laneFilter}
            onChange={(event) => setLaneFilter(event.target.value)}
            placeholder="FILTER LANES"
            title="Filter lanes (is:dirty is:pinned type:worktree)"
            style={{
              height: 32, width: 200, padding: "0 28px 0 28px", fontSize: 11,
              fontFamily: MONO_FONT, background: "#18151F",
              border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textSecondary,
              outline: "none", textTransform: "uppercase", letterSpacing: "1px",
            }}
          />
          {laneFilter.trim().length > 0 ? (
            <button
              type="button"
              className="absolute"
              style={{ right: 4, top: "50%", transform: "translateY(-50%)", display: "inline-flex", width: 20, height: 20, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={() => setLaneFilter("")}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        {/* NEW LANE button + dropdown */}
        <div className="relative shrink-0" ref={addLaneDropdownRef}>
          <button type="button" style={primaryButton({ height: 32, padding: "0 12px", fontSize: 10 })} disabled={!canCreateLane} onClick={() => setAddLaneDropdownOpen((prev) => !prev)}>
            <Plus size={12} /> NEW LANE
          </button>
          {addLaneDropdownOpen ? (
            <div className="absolute left-0 top-full z-50 mt-1" style={{ width: 224, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "2px 0" }}>
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                style={{ padding: "8px 12px", fontSize: 12, color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  setCreateLaneName("");
                  setCreateParentLaneId("");
                  setCreateAsChild(false);
                  setCreateBaseBranch("");
                  const primary = lanes.find((l) => l.laneType === "primary");
                  if (primary) {
                    window.ade.git.listBranches({ laneId: primary.id })
                      .then((branches) => {
                        setCreateBranches(branches);
                        const current = branches.find((b) => b.isCurrent && !b.isRemote);
                        if (current) setCreateBaseBranch(current.name);
                      })
                      .catch(() => {});
                  }
                  setCreateOpen(true);
                }}
              >
                <Plus size={14} />
                Create new lane
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                style={{ padding: "8px 12px", fontSize: 12, color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  setAttachName("");
                  setAttachPath("");
                  setAttachOpen(true);
                }}
              >
                <Link size={14} />
                Add existing worktree as lane
              </button>
            </div>
          ) : null}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, height: 1 }} />

        {/* Stats */}
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {filteredLanes.length}/{sortedLanes.length} LANES
        </span>
      </div>

      {/* Lane tabs — horizontal numbered tab bar */}
      <div className="flex overflow-x-auto" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
        {filteredLanes.map((lane, index) => {
          const isVisible = visibleLaneIds.includes(lane.id);
          const isSelected = selectedLaneId === lane.id;
          const isPrimary = lane.laneType === "primary";
          const isPinned = pinnedLaneIds.has(lane.id);
          const closable = isVisible && visibleLaneIds.length > 1 && !isPinned;
          const conflictStatus = conflictStatusByLane[lane.id];
          const chips = conflictChipsByLane[lane.id] ?? [];
          const laneTerminalAttention = terminalAttention.byLaneId[lane.id];
          const restackSuggestion = restackByLaneId.get(lane.id) ?? null;
          const autoRebaseStatus = autoRebaseByLaneId.get(lane.id) ?? null;
          const tabNumber = String(index + 1).padStart(2, "0");

          return (
            <div
              key={lane.id}
              role="button"
              tabIndex={0}
              className="group flex items-center gap-2 cursor-pointer shrink-0"
              style={{
                padding: "0 16px",
                height: 44,
                borderLeft: isSelected
                  ? `2px solid ${COLORS.accent}`
                  : "2px solid transparent",
                background: isSelected ? COLORS.accentSubtle : "transparent",
              }}
              onClick={(event) => {
                handleLaneSelect(lane.id, {
                  extend: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setLaneContextMenu({ laneId: lane.id, x: event.clientX, y: event.clientY });
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = "transparent";
              }}
            >
              {/* Tab number */}
              <span style={{
                fontFamily: MONO_FONT, fontSize: 10, fontWeight: 600, letterSpacing: "1px",
                color: isSelected ? COLORS.accent : COLORS.textDim,
              }}>{tabNumber}</span>
              {/* Primary: house icon; Non-primary: conflict status dot */}
              {isPrimary ? (
                <House size={12} className="shrink-0" style={{ color: COLORS.accent }} />
              ) : (
                <span className="shrink-0" style={{ width: 10, height: 10, borderRadius: "50%", background: conflictDotColor(conflictStatus?.status) }} />
              )}
              {/* Terminal attention spinner */}
              {laneTerminalAttention?.indicator && laneTerminalAttention.indicator !== "none" ? (
                <span
                  title={
                    laneTerminalAttention.indicator === "running-needs-attention"
                      ? `${laneTerminalAttention.needsAttentionCount} terminal${laneTerminalAttention.needsAttentionCount === 1 ? "" : "s"} need input`
                      : `${laneTerminalAttention.runningCount} terminal${laneTerminalAttention.runningCount === 1 ? "" : "s"} running`
                  }
                  className="shrink-0 animate-spin"
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    border: `1.5px solid ${laneTerminalAttention.indicator === "running-needs-attention" ? COLORS.warning : COLORS.success}`,
                    borderTopColor: "transparent",
                  }}
                />
              ) : null}
              {/* Lane name */}
              <span className="truncate" style={{
                maxWidth: 180,
                fontFamily: MONO_FONT, fontSize: 11, letterSpacing: "1px", textTransform: "uppercase",
                fontWeight: isSelected ? 600 : 500,
                color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
              }}>{lane.name}</span>
              {/* Branch ref pill for primary */}
              {isPrimary ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px",
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px",
                  color: COLORS.accent, background: `${COLORS.accent}30`,
                }}>{lane.branchRef}</span>
              ) : null}
              {/* Behind badge (restack suggestion) */}
              {restackSuggestion ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px",
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
                  color: COLORS.warning, background: `${COLORS.warning}18`,
                }} title={`Behind parent by ${restackSuggestion.behindCount} commit(s)`}>
                  ↑{restackSuggestion.behindCount}
                </span>
              ) : null}
              {/* Pinned badge */}
              {!isPrimary && isPinned ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px",
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
                  color: COLORS.textMuted, background: COLORS.outlineBorder,
                }}>PINNED</span>
              ) : null}
              {/* Auto-rebase status badges */}
              {autoRebaseStatus?.state === "autoRebased" ? (
                <span style={inlineBadge(COLORS.success, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Lane was rebased automatically."}>
                  REBASED
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebasePending" ? (
                <span style={inlineBadge(COLORS.warning, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Auto-rebase is pending manual action."}>
                  PENDING
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebaseConflict" ? (
                <span
                  style={inlineBadge(COLORS.danger, { fontSize: 9 })}
                  title={autoRebaseStatus.message ?? "Auto-rebase stopped due to conflicts."}
                >
                  CONFLICT{autoRebaseStatus.conflictCount > 0 ? ` ${autoRebaseStatus.conflictCount}` : ""}
                </span>
              ) : null}
              {chips.slice(0, 1).map((chip, chipIndex) => (
                <span
                  key={`${chip.kind}:${chip.peerId ?? "base"}:${chipIndex}`}
                  style={inlineBadge(chip.kind === "high-risk" ? COLORS.danger : COLORS.warning, { fontSize: 9 })}
                >
                  {chipLabel(chip.kind)}
                </span>
              ))}
              {/* Pin toggle — appears on hover */}
              {!isPrimary ? (
                <button
                  type="button"
                  className="shrink-0 transition-opacity"
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: isPinned ? `${COLORS.warning}25` : "transparent",
                    color: isPinned ? COLORS.warning : COLORS.textDim,
                    border: "none", cursor: "pointer",
                    opacity: isPinned ? 1 : 0,
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedLane(lane.id);
                  }}
                  title={isPinned ? "Unpin lane" : "Pin lane"}
                >
                  <PushPin size={10} />
                </button>
              ) : null}
              {/* Close from split — appears on hover */}
              {closable ? (
                <button
                  type="button"
                  className="shrink-0 transition-opacity opacity-0 group-hover:opacity-100"
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: "transparent", color: COLORS.textDim, border: "none", cursor: "pointer",
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSplitLane(lane.id);
                  }}
                  title="Remove from split"
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Restack / auto-rebase banners */}
      <LaneRestackBanner
        visibleRestackSuggestions={visibleRestackSuggestions}
        visibleAutoRebaseNeedsAttention={visibleAutoRebaseNeedsAttention}
        showAutoRebaseSettingsHint={showAutoRebaseSettingsHint}
        lanesById={lanesById}
        restackBusyLaneId={restackBusyLaneId}
        restackSuggestionError={restackSuggestionError}
        onRestackNow={(laneId) => { void restackNow(laneId); }}
        onDismissRestack={(laneId) => { void dismissRestackSuggestion(laneId); }}
        onDeferRestack={(laneId, minutes) => { void deferRestackSuggestion(laneId, minutes); }}
        onOpenAutoRebaseSettings={openAutoRebaseSettings}
        onOpenRebaseConflictResolver={openRebaseConflictResolver}
      />

      {/* Floating pane tiling layout */}
      {visibleLaneIds.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          {sortedLanes.length === 0 ? (
            <EmptyState
              title="No lanes created yet"
              description="Lanes let you work on multiple features in parallel."
            >
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                disabled={!canCreateLane}
                onClick={() => {
                  setCreateLaneName("");
                  setCreateParentLaneId("");
                  setCreateAsChild(false);
                  setCreateBaseBranch("");
                  const primary = lanes.find((l) => l.laneType === "primary");
                  if (primary) {
                    window.ade.git.listBranches({ laneId: primary.id })
                      .then((branches) => {
                        setCreateBranches(branches);
                        const current = branches.find((b) => b.isCurrent && !b.isRemote);
                        if (current) setCreateBaseBranch(current.name);
                      })
                      .catch(() => {});
                  }
                  setCreateOpen(true);
                }}
              >
                Create Lane
              </Button>
            </EmptyState>
          ) : (
            <EmptyState
              title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
              description={filteredLanes.length === 0 ? "Adjust the lane filter." : "Select a lane tab to begin."}
            />
          )}
        </div>
      ) : visibleLaneIds.length === 1 ? (
        <PaneTilingLayout
          layoutId={`lanes:tiling:v3:${visibleLaneIds[0]}`}
          tree={LANES_TILING_TREE}
          panes={getPaneConfigs(visibleLaneIds[0] ?? null)}
          className="flex-1 min-h-0"
        />
      ) : (
        <Group
          key={`lanes-split-columns:${visibleLaneIds.join(",")}`}
          id="lanes-split-columns"
          orientation="horizontal"
          resizeTargetMinimumSize={RESIZE_TARGET_MINIMUM_SIZE}
          className="flex-1 min-h-0 min-w-0"
        >
          {visibleLaneIds.map((laneId, index) => {
            const defaultSize = Math.max(20, 100 / Math.max(1, visibleLaneIds.length));
            return (
              <React.Fragment key={laneId}>
                <Panel id={`lane-column:${laneId}`} minSize="18%" defaultSize={`${defaultSize}%`} className="min-h-0 min-w-0">
                  <PaneTilingLayout
                    layoutId={`lanes:tiling:v3:${laneId}`}
                    tree={LANES_TILING_TREE}
                    panes={getPaneConfigs(laneId)}
                    className="h-full min-h-0"
                  />
                </Panel>
                {index < visibleLaneIds.length - 1 ? <ResizeGutter orientation="vertical" laneDivider /> : null}
              </React.Fragment>
            );
          })}
        </Group>
      )}

      {/* Fullscreen Git Actions pane overlay */}
      {expandedGitActionsLaneId && lanesById.has(expandedGitActionsLaneId) ? (
        <div className="fixed inset-0 z-[110] flex flex-col" style={{ background: COLORS.pageBg }}>
          <PaneTilingLayout
            layoutId={`lanes:git-actions:fullscreen:v1:${expandedGitActionsLaneId}`}
            tree={GIT_ACTIONS_FULLSCREEN_TREE}
            panes={getPaneConfigs(expandedGitActionsLaneId)}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Fullscreen lane overlay */}
      {expandedLaneId && lanesById.has(expandedLaneId) ? (
        <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: COLORS.pageBg }}>
          <div className="absolute top-2 right-3 z-10">
            <button
              type="button"
              style={outlineButton({ height: 28, padding: "0 8px" })}
              onClick={() => setExpandedLaneId(null)}
              title="Exit fullscreen (Esc)"
            >
              <X size={16} />
            </button>
          </div>
          <PaneTilingLayout
            layoutId={`lanes:tiling:v3:${expandedLaneId}`}
            tree={LANES_TILING_TREE}
            panes={getPaneConfigs(expandedLaneId)}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Lane tab context menu */}
      {laneContextMenu ? (
        <LaneContextMenu
          laneContextMenu={laneContextMenu}
          lanesById={lanesById}
          onClose={() => setLaneContextMenu(null)}
          onManage={openManageDialog}
          selectLane={selectLane}
        />
      ) : null}

      {/* Manage Lane dialog */}
      <ManageLaneDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        managedLane={managedLane}
        deleteMode={deleteMode}
        setDeleteMode={setDeleteMode}
        deleteRemoteName={deleteRemoteName}
        setDeleteRemoteName={setDeleteRemoteName}
        deleteForce={deleteForce}
        setDeleteForce={setDeleteForce}
        deleteConfirmText={deleteConfirmText}
        setDeleteConfirmText={setDeleteConfirmText}
        deletePhrase={deletePhrase}
        laneActionBusy={laneActionBusy}
        laneActionError={laneActionError}
        onArchive={() => { archiveManagedLane().catch(() => {}); }}
        onDelete={() => { deleteManagedLane().catch(() => {}); }}
      />

      {/* Create Lane dialog */}
      <CreateLaneDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        createLaneName={createLaneName}
        setCreateLaneName={setCreateLaneName}
        createAsChild={createAsChild}
        setCreateAsChild={setCreateAsChild}
        createParentLaneId={createParentLaneId}
        setCreateParentLaneId={setCreateParentLaneId}
        createBaseBranch={createBaseBranch}
        setCreateBaseBranch={setCreateBaseBranch}
        createBranches={createBranches}
        lanes={lanes}
        onSubmit={handleCreateSubmit}
      />

      {/* Attach Lane dialog */}
      <AttachLaneDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        attachName={attachName}
        setAttachName={setAttachName}
        attachPath={attachPath}
        setAttachPath={setAttachPath}
        onSubmit={handleAttachSubmit}
      />
    </div>
  );
}
