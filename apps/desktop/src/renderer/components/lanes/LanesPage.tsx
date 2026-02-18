import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Group, Panel } from "react-resizable-panels";
import { Check, ChevronDown, FileCode2, GitBranch, Home, Layers3, Link2, Maximize2, Minimize2, Pin, Plus, Search, Terminal, X } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTilingLayout } from "../ui/PaneTilingLayout";
import { ResizeGutter } from "../ui/ResizeGutter";
import { LaneStackPane } from "./LaneStackPane";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { LaneDiffPane } from "./LaneDiffPane";
import { LaneWorkPane } from "./LaneWorkPane";
import { LaneInspectorPane } from "./LaneInspectorPane";
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
import { revealLabel } from "../../lib/platform";
import type { PaneSplit } from "../ui/PaneTilingLayout";

/* ---- Utility functions ---- */

function sortLanesForTabs<T extends { laneType: string; createdAt: string }>(lanes: T[]): T[] {
  return [...lanes].sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
    return 0;
  });
}

function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const primaryId = primary?.id ?? null;

  for (const lane of lanes) {
    if (lane.laneType === "primary") { roots.push(lane); continue; }
    const effectiveParentId = lane.parentLaneId && laneById.has(lane.parentLaneId) ? lane.parentLaneId : primaryId;
    if (!effectiveParentId || effectiveParentId === lane.id) { roots.push(lane); continue; }
    const children = childrenByParent.get(effectiveParentId) ?? [];
    children.push(lane);
    childrenByParent.set(effectiveParentId, children);
  }

  const byCreatedAsc = (a: LaneSummary, b: LaneSummary) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  };
  roots.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    return byCreatedAsc(a, b);
  });
  for (const [, children] of childrenByParent.entries()) {
    children.sort(byCreatedAsc);
  }

  const out: LaneSummary[] = [];
  const visit = (lane: LaneSummary) => {
    out.push(lane);
    for (const child of childrenByParent.get(lane.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const seen = new Set(out.map((lane) => lane.id));
  return out.concat(lanes.filter((lane) => !seen.has(lane.id)).sort(byCreatedAsc));
}

function mergeUnique(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function matchesLaneFilterToken(lane: LaneSummary, isPinned: boolean, token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized.length) return true;
  if (normalized.startsWith("is:")) {
    const value = normalized.slice(3);
    if (value === "dirty") return lane.status.dirty;
    if (value === "clean") return !lane.status.dirty;
    if (value === "pinned") return isPinned;
    if (value === "primary") return lane.laneType === "primary";
    if (value === "worktree") return lane.laneType === "worktree";
    if (value === "attached") return lane.laneType === "attached";
    return false;
  }
  if (normalized.startsWith("type:")) return lane.laneType === normalized.slice(5);

  const indexedText = [
    lane.name, lane.branchRef, lane.laneType, lane.description ?? "",
    lane.worktreePath,
    lane.status.dirty ? "dirty modified changed" : "clean",
    lane.status.ahead > 0 ? `ahead ahead:${lane.status.ahead}` : "ahead:0",
    lane.status.behind > 0 ? `behind behind:${lane.status.behind}` : "behind:0",
    isPinned ? "pinned" : ""
  ].join(" ").toLowerCase();
  return indexedText.includes(normalized);
}

function laneMatchesFilter(lane: LaneSummary, isPinned: boolean, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => matchesLaneFilterToken(lane, isPinned, token));
}

function conflictDotClass(status: ConflictStatus["status"] | undefined): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

function chipLabel(kind: ConflictChip["kind"]): string {
  return kind === "high-risk" ? "high risk" : "new overlap";
}

/* ---- Default tiling layout ---- */

const LANES_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "stack" }, defaultSize: 50, minSize: 15 },
          { node: { type: "pane", id: "diff-viewer" }, defaultSize: 50, minSize: 15 }
        ]
      },
      defaultSize: 28,
      minSize: 15
    },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          {
            node: {
              type: "split",
              direction: "horizontal",
              children: [
                { node: { type: "pane", id: "git-actions" }, defaultSize: 50, minSize: 20 },
                { node: { type: "pane", id: "inspector" }, defaultSize: 50, minSize: 20 }
              ]
            },
            defaultSize: 30,
            minSize: 12
          },
          { node: { type: "pane", id: "work" }, defaultSize: 70, minSize: 25 }
        ]
      },
      defaultSize: 72,
      minSize: 40
    }
  ]
};

const GIT_ACTIONS_FULLSCREEN_TREE: PaneSplit = {
  type: "split",
  direction: "vertical",
  children: [
    { node: { type: "pane", id: "git-actions" }, defaultSize: 100, minSize: 15 }
  ]
};

const RESIZE_TARGET_MINIMUM_SIZE = { coarse: 37, fine: 27 } as const;

type LanePaneDetailSelection = {
  selectedFilePath: string | null;
  selectedFileMode: "staged" | "unstaged" | null;
  selectedCommit: GitCommitSummary | null;
};

type LaneBranchOption = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
};

function formatBranchCheckoutError(input: string): string {
  const message = input.trim();
  const lowered = message.toLowerCase();
  const dirtyCheckout =
    lowered.includes("would be overwritten by checkout") ||
    lowered.includes("please commit your changes or stash them before you switch branches");
  if (!dirtyCheckout) return message;

  const touchedFiles = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/") && !line.toLowerCase().startsWith("error:"));
  const fileCount = touchedFiles.length;
  if (fileCount > 0) {
    return `Cannot switch branches: you have uncommitted primary-lane changes in ${fileCount} file${fileCount === 1 ? "" : "s"}. Commit, stash, or discard changes first.`;
  }
  return "Cannot switch branches while primary lane has uncommitted changes. Commit, stash, or discard changes first.";
}

const EMPTY_LANE_PANE_DETAIL: LanePaneDetailSelection = {
  selectedFilePath: null,
  selectedFileMode: null,
  selectedCommit: null
};

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
  const baseRef = project?.baseRef;

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
  const canManageLane = Boolean(managedLane && managedLane.laneType !== "primary");
  const deletePhrase = managedLane ? `delete ${managedLane.name}` : "";

  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

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

  useEffect(() => {
    if (!branchDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [branchDropdownOpen]);

  useEffect(() => {
    if (!addLaneDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (addLaneDropdownRef.current && !addLaneDropdownRef.current.contains(e.target as Node)) {
        setAddLaneDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addLaneDropdownOpen]);

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

  useEffect(() => {
    void refreshAutoRebaseEnabled();
  }, [refreshAutoRebaseEnabled]);

  useEffect(() => {
    const onFocus = () => {
      void refreshAutoRebaseEnabled();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshAutoRebaseEnabled();
      }
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
      if (succeeded) {
        setBranchDropdownOpen(false);
      }
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

  const openAutoRebaseSettings = useCallback(() => {
    navigate("/settings");
  }, [navigate]);

  const openRebaseConflictResolver = useCallback((laneId: string, parentLaneId: string | null) => {
    const search = new URLSearchParams({ tab: "merge-one", laneAId: laneId });
    if (parentLaneId) search.set("laneBId", parentLaneId);
    navigate(`/conflicts?${search.toString()}`);
  }, [navigate]);

  /* ---- Detail handlers ---- */

  const handleSelectFile = useCallback((laneId: string, path: string, mode: "staged" | "unstaged") => {
    setLanePaneDetails((prev) => ({
      ...prev,
      [laneId]: {
        selectedFilePath: path,
        selectedFileMode: mode,
        selectedCommit: null
      }
    }));
  }, []);

  const handleSelectCommit = useCallback((laneId: string, commit: GitCommitSummary | null) => {
    setLanePaneDetails((prev) => {
      const prevDetail = prev[laneId] ?? EMPTY_LANE_PANE_DETAIL;
      const nextDetail: LanePaneDetailSelection = commit
        ? {
            selectedFilePath: null,
            selectedFileMode: null,
            selectedCommit: commit
          }
        : {
            ...prevDetail,
            selectedCommit: null
          };
      return { ...prev, [laneId]: nextDetail };
    });
  }, []);

  /* ---- Pane configs ---- */

  const getPaneConfigs = useCallback((laneId: string | null) => {
    const laneDetail = laneId ? lanePaneDetails[laneId] ?? EMPTY_LANE_PANE_DETAIL : EMPTY_LANE_PANE_DETAIL;
    return {
      "stack": {
        title: "Stack",
        icon: Layers3,
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
        icon: FileCode2,
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
            {expandedGitActionsLaneId === laneId ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
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
            onSelectFile={(path, mode) => {
              if (!laneId) return;
              handleSelectFile(laneId, path, mode);
            }}
            onSelectCommit={(commit) => {
              if (!laneId) return;
              handleSelectCommit(laneId, commit);
            }}
          />
        )
      },
      "diff-viewer": {
        title: "Diff",
        icon: FileCode2,
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
        icon: Terminal,
        bodyClassName: "overflow-hidden",
        children: <LaneWorkPane laneId={laneId} />
      },
      "inspector": {
        title: "Inspector",
        icon: Search,
        bodyClassName: "overflow-hidden",
        children: <LaneInspectorPane laneId={laneId} />
      }
    };
  }, [lanePaneDetails, stackGraphLanes, handleLaneSelect, handleSelectFile, handleSelectCommit, expandedGitActionsLaneId, autoRebaseEnabled, openAutoRebaseSettings, openRebaseConflictResolver]);

  /* ---- Render ---- */

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Header bar */}
      <div className="border-b border-border/15 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-semibold text-muted-fg">Lanes</div>
          {primaryLane && selectedLaneId === primaryLane.id ? (
            <div className="relative" ref={branchDropdownRef}>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-[--color-surface-overlay] px-2.5 py-1 text-xs font-medium text-fg shadow-card transition-colors hover:bg-emerald-500/12"
                onClick={() => setBranchDropdownOpen((prev) => !prev)}
                disabled={branchCheckoutBusy}
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span>{currentPrimaryBranch || primaryLane.branchRef}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {branchDropdownOpen ? (
                <div className="absolute left-0 top-full z-50 mt-1 w-72 max-h-80 overflow-auto rounded-xl border border-border/60 bg-[--color-surface-overlay] py-1 shadow-float backdrop-blur-xl">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-fg">Local branches</div>
                  {localPrimaryBranches.map((branch) => (
                    <button
                      key={`local:${branch.name}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50",
                        branch.isCurrent && "font-medium text-emerald-700"
                      )}
                      disabled={branchCheckoutBusy || branch.isCurrent}
                      onClick={async () => {
                        if (branch.isCurrent) return;
                        await checkoutPrimaryBranch(branch.name);
                      }}
                    >
                      {branch.isCurrent ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                      <span className="truncate">{branch.name}</span>
                      {branch.upstream ? <span className="ml-auto shrink-0 text-[10px] text-muted-fg">tracked</span> : null}
                    </button>
                  ))}
                  {remotePrimaryBranches.length > 0 ? (
                    <>
                      <div className="my-1 h-px bg-border/20" />
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-fg">Remote branches</div>
                      {remotePrimaryBranches.map((branch) => (
                        <button
                          key={`remote:${branch.name}`}
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                          disabled={branchCheckoutBusy}
                          onClick={async () => {
                            await checkoutPrimaryBranch(branch.name);
                          }}
                        >
                          <span className="w-3 shrink-0" />
                          <span className="truncate">{branch.name}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-sky-700">remote</span>
                        </button>
                      ))}
                    </>
                  ) : null}
                  {localPrimaryBranches.length === 0 && remotePrimaryBranches.length === 0 ? (
                    <div className="px-3 py-1.5 text-[11px] text-muted-fg">No branches found.</div>
                  ) : null}
                  {branchCheckoutError ? (
                    <div className="px-3 py-1.5 text-[10px] text-red-400">{branchCheckoutError}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {branchCheckoutError && primaryLane && selectedLaneId === primaryLane.id ? (
            <div className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-800">
              <span>{branchCheckoutError}</span>
              <button
                type="button"
                className="rounded px-1 text-red-900/70 transition-colors hover:bg-red-500/15 hover:text-red-900"
                onClick={() => setBranchCheckoutError(null)}
                title="Dismiss"
              >
                ×
              </button>
            </div>
          ) : null}
          <div className="relative">
            <input
              id="lanes-filter-input"
              value={laneFilter}
              onChange={(event) => setLaneFilter(event.target.value)}
              placeholder="Filter lanes (is:dirty is:pinned type:worktree)"
              className="h-7 min-w-[280px] rounded-xl bg-muted/30 shadow-card px-2 pr-7 text-xs outline-none placeholder:text-muted-fg"
            />
            {laneFilter.trim().length > 0 ? (
              <button
                type="button"
                className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-lg text-muted-fg transition-colors hover:bg-muted/70 hover:text-fg"
                onClick={() => setLaneFilter("")}
                title="Clear filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          {/* Add Lane dropdown */}
          <div className="relative" ref={addLaneDropdownRef}>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={!canCreateLane} onClick={() => setAddLaneDropdownOpen((prev) => !prev)}>
              <Plus className="h-3 w-3 mr-0.5" /> Lane <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
            </Button>
            {addLaneDropdownOpen ? (
              <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-xl border border-border/60 bg-[--color-surface-overlay] py-1 shadow-float backdrop-blur-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
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
                  <Plus className="h-3.5 w-3.5" />
                  Create new lane
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                  onClick={() => {
                    setAddLaneDropdownOpen(false);
                    setAttachName("");
                    setAttachPath("");
                    setAttachOpen(true);
                  }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Add existing worktree as lane
                </button>
              </div>
            ) : null}
          </div>

          <div className="ml-auto text-[11px] text-muted-fg">
            {filteredLanes.length}/{sortedLanes.length} · shift-click split
          </div>
        </div>
      </div>

      {/* Lane tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/15 px-2 py-1.5">
        {filteredLanes.map((lane) => {
          const isVisible = visibleLaneIds.includes(lane.id);
          const isSelected = selectedLaneId === lane.id;
          const isPrimary = lane.laneType === "primary";
          const isPinned = pinnedLaneIds.has(lane.id);
          const closable = isVisible && visibleLaneIds.length > 1 && !isPinned;
          const conflictStatus = conflictStatusByLane[lane.id];
          const chips = conflictChipsByLane[lane.id] ?? [];
          const restackSuggestion = restackByLaneId.get(lane.id) ?? null;
          const autoRebaseStatus = autoRebaseByLaneId.get(lane.id) ?? null;

          return (
            <button
              key={lane.id}
              type="button"
              className={cn(
                "group inline-flex max-w-[320px] shrink-0 items-center gap-1 rounded-xl px-2 py-1 text-xs transition-colors",
                isSelected
                  ? "bg-accent/20 text-fg shadow-card ring-1 ring-accent/40 font-semibold"
                  : isVisible
                    ? "bg-accent/10 text-fg"
                    : "bg-muted/30 text-muted-fg hover:bg-muted/50 hover:text-fg",
                isPrimary && !isSelected && "bg-emerald-500/15"
              )}
              onClick={(event) => {
                handleLaneSelect(lane.id, {
                  extend: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setLaneContextMenu({ laneId: lane.id, x: event.clientX, y: event.clientY });
              }}
            >
              {isPrimary ? (
                <Home className="h-3.5 w-3.5 text-emerald-700" />
              ) : null}
              <span className={cn("h-2.5 w-2.5 rounded-full", conflictDotClass(conflictStatus?.status))} />
              <span className="truncate">{lane.name}</span>
              {isPrimary ? <span className="rounded-lg bg-emerald-500/15 px-1 text-[10px] text-emerald-700">{lane.branchRef}</span> : null}
              {!isPrimary && isPinned ? <span className="rounded-lg bg-amber-500/15 px-1 text-[10px] text-amber-800">PINNED</span> : null}
              {restackSuggestion ? (
                <span className="rounded-lg bg-amber-500/10 px-1 text-[10px] text-amber-800" title={`Behind parent by ${restackSuggestion.behindCount} commit(s)`}>
                  RESTACK {restackSuggestion.behindCount}
                </span>
              ) : null}
              {autoRebaseStatus?.state === "autoRebased" ? (
                <span className="rounded-lg bg-emerald-500/12 px-1 text-[10px] text-emerald-700" title={autoRebaseStatus.message ?? "Lane was rebased automatically."}>
                  AUTO REBASED
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebasePending" ? (
                <span className="rounded-lg bg-amber-500/12 px-1 text-[10px] text-amber-800" title={autoRebaseStatus.message ?? "Auto-rebase is pending manual action."}>
                  REBASE PENDING
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebaseConflict" ? (
                <span
                  className="rounded-lg bg-red-500/12 px-1 text-[10px] text-red-200"
                  title={autoRebaseStatus.message ?? "Auto-rebase stopped due to conflicts."}
                >
                  REBASE CONFLICT{autoRebaseStatus.conflictCount > 0 ? ` ${autoRebaseStatus.conflictCount}` : ""}
                </span>
              ) : null}
              {chips.slice(0, 1).map((chip, index) => (
                <span
                  key={`${chip.kind}:${chip.peerId ?? "base"}:${index}`}
                  className={cn("rounded-lg px-1 text-[10px] uppercase", chip.kind === "high-risk" ? "bg-red-500/10 text-red-200" : "bg-amber-500/10 text-amber-200")}
                >
                  {chipLabel(chip.kind)}
                </span>
              ))}
              {!isPrimary ? (
                <span
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-lg transition-opacity",
                    isPinned
                      ? "bg-amber-100 text-amber-800 opacity-100"
                      : "text-muted-fg hover:text-fg opacity-0 group-hover:opacity-100"
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedLane(lane.id);
                  }}
                  title={isPinned ? "Unpin lane" : "Pin lane"}
                >
                  <Pin className="h-2.5 w-2.5" />
                </span>
              ) : null}
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded-lg hover:bg-muted/60"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedGitActionsLaneId(null);
                    setExpandedLaneId(lane.id === expandedLaneId ? null : lane.id);
                  }}
                  title="Expand lane fullscreen"
                >
                  <Maximize2 className="h-2.5 w-2.5" />
              </span>
              {closable ? (
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded-lg hover:bg-muted/60"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSplitLane(lane.id);
                  }}
                  title="Remove from split"
                >
                  <X className="h-3 w-3" />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Restack suggestions */}
      {visibleRestackSuggestions.length > 0 ? (
        <div className="border-b border-border/15 bg-amber-500/5 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-fg/70">Restack suggested</div>
            <div className="text-[11px] text-muted-fg">{visibleRestackSuggestions.length} lane(s) behind parent</div>
          </div>
          {showAutoRebaseSettingsHint ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/25 bg-sky-500/8 px-2 py-1.5">
              <div className="text-[11px] text-sky-700">
                Auto-rebase is off. Enable it in Settings to auto-restack child lanes after parent updates.
              </div>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={openAutoRebaseSettings}>
                Open settings
              </Button>
            </div>
          ) : null}
          <div className="mt-2 space-y-2">
            {visibleRestackSuggestions.slice(0, 3).map((s) => {
              const lane = lanesById.get(s.laneId) ?? null;
              if (!lane) return null;
              const busy = restackBusyLaneId === s.laneId;
              return (
                <div key={`restack:${s.laneId}`} className="flex flex-wrap items-start justify-between gap-2 rounded-xl shadow-card bg-card/40 p-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                      {s.hasPr ? <span className="rounded-lg bg-sky-500/10 px-1 text-[10px] text-sky-700">PR</span> : null}
                      <span className="text-[11px] text-muted-fg">{s.behindCount} behind</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-fg">Rebase this lane onto its parent to pick up new commits.</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={Boolean(restackBusyLaneId)} onClick={() => void deferRestackSuggestion(s.laneId, 60)}>
                      Defer 1h
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={Boolean(restackBusyLaneId)} onClick={() => void dismissRestackSuggestion(s.laneId)}>
                      Dismiss
                    </Button>
                    <Button size="sm" variant="primary" className="h-7 px-2 text-[11px]" disabled={Boolean(restackBusyLaneId)} onClick={() => void restackNow(s.laneId)}>
                      <Layers3 className="mr-1 h-3 w-3" />
                      {busy ? "Restacking..." : "Restack now"}
                    </Button>
                  </div>
                </div>
              );
            })}
            {visibleRestackSuggestions.length > 3 ? (
              <div className="text-[11px] text-muted-fg">+ {visibleRestackSuggestions.length - 3} more suggestions.</div>
            ) : null}
            {restackSuggestionError ? (
              <div className="rounded-xl bg-red-500/10 p-2 text-[11px] text-red-200">{restackSuggestionError}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showAutoRebaseSettingsHint && visibleRestackSuggestions.length === 0 ? (
        <div className="border-b border-border/15 bg-sky-500/8 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/25 bg-card/30 px-2 py-1.5">
            <div className="text-[11px] text-sky-700">
              Auto-rebase is off. Enable it in Settings to auto-restack child lanes after parent updates.
            </div>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={openAutoRebaseSettings}>
              Open settings
            </Button>
          </div>
        </div>
      ) : null}

      {visibleAutoRebaseNeedsAttention.length > 0 ? (
        <div className="border-b border-border/15 bg-amber-500/5 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-fg/70">Auto-rebase needs attention</div>
            <div className="text-[11px] text-muted-fg">{visibleAutoRebaseNeedsAttention.length} lane(s)</div>
          </div>
          <div className="mt-2 space-y-2">
            {visibleAutoRebaseNeedsAttention.slice(0, 3).map((status) => {
              const lane = lanesById.get(status.laneId) ?? null;
              if (!lane) return null;
              return (
                <div key={`auto-rebase:${status.laneId}`} className="flex flex-wrap items-start justify-between gap-2 rounded-xl bg-card/40 p-2 shadow-card">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                      {status.state === "rebaseConflict" ? (
                        <span className="rounded-lg bg-red-500/12 px-1 text-[10px] text-red-200">conflict</span>
                      ) : (
                        <span className="rounded-lg bg-amber-500/12 px-1 text-[10px] text-amber-800">pending</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-fg">
                      {status.message ?? "Manual rebase and publish may be required for this lane."}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {status.state === "rebaseConflict" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => openRebaseConflictResolver(status.laneId, status.parentLaneId ?? lane.parentLaneId ?? null)}
                      >
                        Resolve in Conflicts
                      </Button>
                    ) : (
                      <Button size="sm" variant="primary" className="h-7 px-2 text-[11px]" onClick={() => void restackNow(status.laneId)}>
                        <Layers3 className="mr-1 h-3 w-3" />
                        Restack now
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {visibleAutoRebaseNeedsAttention.length > 3 ? (
              <div className="text-[11px] text-muted-fg">+ {visibleAutoRebaseNeedsAttention.length - 3} more lanes.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Floating pane tiling layout */}
      {visibleLaneIds.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
            description={filteredLanes.length === 0 ? "Adjust the lane filter." : "Select a lane tab to begin."}
          />
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
        <div className="fixed inset-0 z-[110] bg-bg flex flex-col">
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
        <div className="fixed inset-0 z-[100] bg-bg flex flex-col">
          <div className="absolute top-2 right-3 z-10">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl bg-bg/80 backdrop-blur-sm shadow-card hover:bg-muted/60"
              onClick={() => setExpandedLaneId(null)}
              title="Exit fullscreen (Esc)"
            >
              <X className="h-4 w-4" />
            </Button>
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
      {laneContextMenu ? (() => {
        const ctxLane = lanesById.get(laneContextMenu.laneId) ?? null;
        return (
          <div
            className="fixed z-40 min-w-[190px] rounded-xl bg-[--color-surface-overlay] p-1 shadow-float backdrop-blur-xl"
            style={{ left: laneContextMenu.x, top: laneContextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {ctxLane?.worktreePath ? (
              <>
                <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
                  setLaneContextMenu(null);
                  window.ade.app.revealPath(ctxLane.worktreePath).catch(() => {});
                }}>{revealLabel}</button>
                <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
                  setLaneContextMenu(null);
                  navigator.clipboard.writeText(ctxLane.worktreePath).catch(() => {});
                }}>Copy Path</button>
              </>
            ) : null}
            {ctxLane && ctxLane.laneType !== "primary" ? (
              <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
                const ctxLaneId = laneContextMenu.laneId;
                setLaneContextMenu(null);
                selectLane(ctxLaneId);
                setLaneActionError(null);
                setDeleteForce(false);
                setDeleteMode("worktree");
                setDeleteRemoteName("origin");
                setDeleteConfirmText("");
                setManageOpen(true);
              }}>Manage Lane</button>
            ) : null}
          </div>
        );
      })() : null}

      {/* Manage Lane dialog */}
      <Dialog.Root open={manageOpen} onOpenChange={setManageOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
          <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-card/95 backdrop-blur-xl p-4 shadow-float focus:outline-none">
            <div className="mb-4 flex items-center justify-between gap-3">
              <Dialog.Title className="text-lg font-semibold">Manage lane</Dialog.Title>
              <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
            </div>
            {!managedLane ? (
              <div className="text-sm text-muted-fg">Select a lane first.</div>
            ) : managedLane.laneType === "primary" ? (
              <div className="text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-xl shadow-card bg-bg/40 p-3 text-xs">
                  <div><span className="text-muted-fg">Lane:</span> {managedLane.name}</div>
                  <div><span className="text-muted-fg">Branch:</span> {managedLane.branchRef}</div>
                  <div className="truncate"><span className="text-muted-fg">Worktree:</span> {managedLane.worktreePath}</div>
                </div>
                <div className="rounded-xl shadow-card bg-bg/40 p-3">
                  <div className="mb-2 text-xs font-semibold">Archive</div>
                  <div className="mb-2 text-xs text-muted-fg">Hide lane from ADE without deleting worktree or branches.</div>
                  <Button size="sm" variant="outline" disabled={laneActionBusy} onClick={() => { archiveManagedLane().catch(() => {}); }}>
                    Archive lane from ADE
                  </Button>
                </div>
                <div className="rounded-xl shadow-card bg-red-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-red-900">Delete</div>
                  <div className="mb-2 text-xs text-red-800">This removes the lane worktree from disk.</div>
                  <div className="mb-2 grid gap-2 md:grid-cols-3">
                    <label className="inline-flex items-center gap-2 rounded-xl bg-card/60 shadow-card px-2 py-1 text-xs">
                      <input type="radio" name="lane-delete-mode" checked={deleteMode === "worktree"} onChange={() => setDeleteMode("worktree")} />
                      Worktree only
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-xl bg-card/60 shadow-card px-2 py-1 text-xs">
                      <input type="radio" name="lane-delete-mode" checked={deleteMode === "local_branch"} onChange={() => setDeleteMode("local_branch")} />
                      + local branch
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-xl bg-card/60 shadow-card px-2 py-1 text-xs">
                      <input type="radio" name="lane-delete-mode" checked={deleteMode === "remote_branch"} onChange={() => setDeleteMode("remote_branch")} />
                      + local + remote
                    </label>
                  </div>
                  {deleteMode === "remote_branch" ? (
                    <div className="mb-2">
                      <label className="mb-1 block text-xs text-muted-fg">Remote name</label>
                      <input value={deleteRemoteName} onChange={(event) => setDeleteRemoteName(event.target.value)} className="h-8 w-full rounded-xl bg-card/60 shadow-card px-2 text-xs outline-none" placeholder="origin" />
                    </div>
                  ) : null}
                  <label className="mb-2 inline-flex items-center gap-2 rounded-xl bg-card/60 shadow-card px-2 py-1 text-xs">
                    <input type="checkbox" checked={deleteForce} onChange={(event) => setDeleteForce(event.target.checked)} />
                    Force delete
                  </label>
                  <div className="mb-2">
                    <label className="mb-1 block text-xs text-muted-fg">
                      Type <span className="font-semibold text-red-900">{deletePhrase}</span> to confirm
                    </label>
                    <input value={deleteConfirmText} onChange={(event) => setDeleteConfirmText(event.target.value)} className="h-8 w-full rounded-xl bg-card/60 shadow-card px-2 text-xs outline-none" />
                  </div>
                  {laneActionError ? <div className="mb-2 rounded-xl bg-red-100 shadow-card px-2 py-1 text-xs text-red-900">{laneActionError}</div> : null}
                  <Button size="sm" variant="primary" disabled={laneActionBusy || deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()} onClick={() => { deleteManagedLane().catch(() => {}); }}>
                    {laneActionBusy ? "Working..." : "Delete lane"}
                  </Button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Create Lane dialog */}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
          <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-bg/95 backdrop-blur-xl p-3 shadow-float focus:outline-none">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold">Create lane</Dialog.Title>
              <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
            </div>
            <div className="mt-3 space-y-3">
              {/* Lane name */}
              <div>
                <div className="text-xs text-muted-fg">Name</div>
                <input
                  value={createLaneName}
                  onChange={(e) => setCreateLaneName(e.target.value)}
                  placeholder="e.g. feature/auth-refresh"
                  className="mt-1 h-10 w-full rounded-xl bg-muted/30 shadow-card px-3 text-sm outline-none placeholder:text-muted-fg"
                  autoFocus
                />
              </div>

              {/* Child lane toggle */}
              <label className="flex items-center gap-2 rounded-xl bg-muted/20 px-3 py-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={createAsChild}
                  onChange={(e) => {
                    setCreateAsChild(e.target.checked);
                    if (!e.target.checked) setCreateParentLaneId("");
                  }}
                />
                <span className="text-muted-fg">Create as child of another lane</span>
              </label>

              {/* Conditional: Child lane parent selector OR branch selector */}
              {createAsChild ? (
                <div className="space-y-1">
                  <div className="text-xs text-muted-fg">Parent lane</div>
                  <select
                    value={createParentLaneId}
                    onChange={(event) => setCreateParentLaneId(event.target.value)}
                    className="h-10 w-full rounded-xl bg-muted/30 shadow-card px-3 text-sm outline-none"
                  >
                    <option value="">Select a parent lane...</option>
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name} ({lane.branchRef})</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs text-muted-fg">Base branch on primary</div>
                  <select
                    value={createBaseBranch}
                    onChange={(event) => setCreateBaseBranch(event.target.value)}
                    className="h-10 w-full rounded-xl bg-muted/30 shadow-card px-3 text-sm outline-none"
                  >
                    {createBranches.filter((b) => !b.isRemote).map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}{branch.isCurrent ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                  <div className="text-[10px] text-muted-fg/70 px-1">
                    Lane will be created from primary/{createBaseBranch || "..."}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setCreateOpen(false); setCreateLaneName(""); setCreateParentLaneId(""); setCreateAsChild(false); setCreateBaseBranch(""); }}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!createLaneName.trim().length || (createAsChild && !createParentLaneId)}
                onClick={() => {
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
                    const primaryLane = lanes.find((l) => l.laneType === "primary");
                    const promise = primaryLane
                      ? window.ade.lanes.create({ name, parentLaneId: primaryLane.id })
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
                }}
              >
                {createAsChild && createParentLaneId ? "Create child lane" : `Create from ${createBaseBranch || "primary"}`}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Attach Lane dialog */}
      <Dialog.Root open={attachOpen} onOpenChange={setAttachOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
          <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-bg/95 backdrop-blur-xl p-3 shadow-float focus:outline-none">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold">Attach lane</Dialog.Title>
              <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <div className="mb-1 text-xs text-muted-fg">Lane name</div>
                <input value={attachName} onChange={(e) => setAttachName(e.target.value)} placeholder="e.g. bugfix/from-other-worktree" className="h-10 w-full rounded-xl bg-muted/30 shadow-card px-3 text-sm outline-none placeholder:text-muted-fg" autoFocus />
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-fg">Attached path</div>
                <input value={attachPath} onChange={(e) => setAttachPath(e.target.value)} placeholder="/absolute/path/to/existing/worktree" className="h-10 w-full rounded-xl bg-muted/30 shadow-card px-3 font-mono text-xs outline-none placeholder:text-muted-fg" />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setAttachOpen(false); setAttachName(""); setAttachPath(""); }}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!attachPath.trim().length || !attachName.trim().length}
                onClick={() => {
                  const name = attachName.trim();
                  const attachedPath = attachPath.trim();
                  window.ade.lanes.attach({ name, attachedPath }).then(async (lane) => {
                    await refreshLanes();
                    setAttachOpen(false);
                    setAttachName("");
                    setAttachPath("");
                    navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                  }).catch(() => {});
                }}
              >
                Attach
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
