import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import * as Dialog from "@radix-ui/react-dialog";
import { GripHorizontal, GripVertical, Home, Link2, Pin, Play, Plus, X } from "lucide-react";
import { LaneDetail } from "./LaneDetail";
import { LaneInspector } from "./LaneInspector";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import type { ConflictChip, ConflictStatus, DeleteLaneArgs, LaneSummary } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";

function sortLanesForTabs<T extends { laneType: string; createdAt: string }>(lanes: T[]): T[] {
  return [...lanes].sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;

    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) {
      return bTs - aTs;
    }
    return 0;
  });
}

function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];

  for (const lane of lanes) {
    if (!lane.parentLaneId || !laneById.has(lane.parentLaneId)) {
      roots.push(lane);
      continue;
    }
    const children = childrenByParent.get(lane.parentLaneId) ?? [];
    children.push(lane);
    childrenByParent.set(lane.parentLaneId, children);
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
  for (const [parentId, children] of childrenByParent.entries()) {
    childrenByParent.set(parentId, [...children].sort(byCreatedAsc));
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

function toggleFilterToken(query: string, token: string): string {
  const normalizedToken = token.toLowerCase().trim();
  if (!normalizedToken.length) return query;

  const tokens = query
    .trim()
    .split(/\s+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  const next = new Set(tokens);
  if (next.has(normalizedToken)) {
    next.delete(normalizedToken);
  } else {
    next.add(normalizedToken);
  }
  return Array.from(next).join(" ");
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

  if (normalized.startsWith("type:")) {
    const value = normalized.slice(5);
    return lane.laneType === value;
  }

  const indexedText = [
    lane.name,
    lane.branchRef,
    lane.laneType,
    lane.description ?? "",
    lane.worktreePath,
    lane.status.dirty ? "dirty modified changed" : "clean",
    lane.status.ahead > 0 ? `ahead ahead:${lane.status.ahead}` : "ahead:0",
    lane.status.behind > 0 ? `behind behind:${lane.status.behind}` : "behind:0",
    isPinned ? "pinned" : ""
  ].join(" ").toLowerCase();

  return indexedText.includes(normalized);
}

function laneMatchesFilter(lane: LaneSummary, isPinned: boolean, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
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

// --- SVG Stack Graph (Tree-style) ---

const TREE_ROW_H = 28;
const TREE_INDENT = 22;
const TREE_LEFT_PAD = 16;
const TREE_DOT_R = 4;

type TreeNodeLayout = {
  lane: LaneSummary;
  row: number;
  depth: number;
  dotX: number;
  dotY: number;
};

function computeTreeLayout(lanes: LaneSummary[]): TreeNodeLayout[] {
  return lanes.map((lane, idx) => ({
    lane,
    row: idx,
    depth: lane.stackDepth,
    dotX: TREE_LEFT_PAD + lane.stackDepth * TREE_INDENT,
    dotY: idx * TREE_ROW_H + TREE_ROW_H / 2
  }));
}

function StackGraph({
  lanes,
  selectedLaneId,
  onSelect
}: {
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = React.useMemo(() => computeTreeLayout(lanes), [lanes]);
  const layoutById = React.useMemo(() => new Map(layout.map((n) => [n.lane.id, n])), [layout]);

  const totalHeight = layout.length * TREE_ROW_H + 4;

  // Build parent → children map
  const childrenByParent = React.useMemo(() => {
    const map = new Map<string, TreeNodeLayout[]>();
    for (const node of layout) {
      if (!node.lane.parentLaneId) continue;
      const arr = map.get(node.lane.parentLaneId) ?? [];
      arr.push(node);
      map.set(node.lane.parentLaneId, arr);
    }
    return map;
  }, [layout]);

  // Build tree-style SVG connectors: vertical line from parent down, horizontal branches to children
  const connectors: React.ReactNode[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = layoutById.get(parentId);
    if (!parent || children.length === 0) continue;

    const lastChild = children[children.length - 1]!;

    // Vertical line from below parent dot to last child's row
    connectors.push(
      <line
        key={`v:${parentId}`}
        x1={parent.dotX}
        y1={parent.dotY + TREE_DOT_R + 2}
        x2={parent.dotX}
        y2={lastChild.dotY}
        stroke="currentColor"
        className="text-muted-fg/35"
        strokeWidth={1.5}
      />
    );

    // Horizontal branch from vertical line to each child's dot
    for (const child of children) {
      connectors.push(
        <line
          key={`h:${child.lane.id}`}
          x1={parent.dotX}
          y1={child.dotY}
          x2={child.dotX - TREE_DOT_R - 3}
          y2={child.dotY}
          stroke="currentColor"
          className="text-muted-fg/35"
          strokeWidth={1.5}
        />
      );
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="relative py-1" style={{ height: totalHeight, minWidth: "100%" }}>
        {/* SVG layer: connectors + dots */}
        <svg className="absolute inset-0 pointer-events-none" width="100%" height={totalHeight}>
          {connectors}
          {layout.map((node) => (
            <circle
              key={`dot:${node.lane.id}`}
              cx={node.dotX}
              cy={node.dotY}
              r={TREE_DOT_R}
              className={cn(
                node.lane.laneType === "primary"
                  ? "fill-emerald-500"
                  : node.lane.status.dirty
                    ? "fill-amber-500"
                    : "fill-sky-500"
              )}
            />
          ))}
        </svg>

        {/* HTML layer: clickable labels */}
        {layout.map((node) => {
          const { lane } = node;
          const isSelected = selectedLaneId === lane.id;
          return (
            <button
              key={`label:${lane.id}`}
              type="button"
              className={cn(
                "absolute flex items-center gap-1.5 rounded px-1.5 text-[11px] transition-colors whitespace-nowrap",
                isSelected
                  ? "bg-accent/15 text-fg ring-1 ring-accent/50"
                  : "text-muted-fg hover:bg-muted/60 hover:text-fg"
              )}
              style={{
                left: node.dotX + TREE_DOT_R + 5,
                top: node.dotY - (TREE_ROW_H - 6) / 2,
                height: TREE_ROW_H - 6
              }}
              onClick={() => onSelect(lane.id)}
              title={lane.parentLaneId ? `Child of ${layoutById.get(lane.parentLaneId)?.lane.name ?? "parent"}` : "Root"}
            >
              <span className="truncate max-w-[160px]">{lane.name}</span>
              {(lane.status.ahead > 0 || lane.status.behind > 0) && (
                <span className="shrink-0 font-mono text-[9px] text-muted-fg/70">
                  {lane.status.ahead > 0 ? `${lane.status.ahead}↑` : ""}
                  {lane.status.behind > 0 ? `${lane.status.behind}↓` : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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

  // Create lane dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createLaneName, setCreateLaneName] = useState("");
  const [createParentLaneId, setCreateParentLaneId] = useState<string>("");

  // Attach lane dialog state
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

  const sortedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const lanesById = useMemo(() => new Map(sortedLanes.map((lane) => [lane.id, lane])), [sortedLanes]);

  const filteredLanes = useMemo(() => {
    return sortedLanes.filter((lane) => laneMatchesFilter(lane, pinnedLaneIds.has(lane.id), laneFilter));
  }, [sortedLanes, laneFilter, pinnedLaneIds]);
  const stackGraphLanes = useMemo(() => sortLanesForStackGraph(filteredLanes), [filteredLanes]);

  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);

  const loadConflictStatuses = useCallback(async () => {
    try {
      const assessment = await window.ade.conflicts.getBatchAssessment();
      const next: Record<string, ConflictStatus> = {};
      for (const status of assessment.lanes) {
        next[status.laneId] = status;
      }
      setConflictStatusByLane(next);
    } catch {
      // best effort: lane rendering should still work without conflict data
    }
  }, []);

  const pushConflictChips = useCallback((chips: ConflictChip[]) => {
    if (chips.length === 0) return;
    const now = Date.now();
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
      const timer = window.setTimeout(() => {
        setConflictChipsByLane((prev) => {
          const laneChips = prev[chip.laneId] ?? [];
          const filtered = laneChips.filter((entry) => {
            return !(
              entry.kind === chip.kind &&
              entry.peerId === chip.peerId &&
              entry.overlapCount === chip.overlapCount
            );
          });
          if (filtered.length === laneChips.length) return prev;
          return {
            ...prev,
            [chip.laneId]: filtered
          };
        });
        chipTimersRef.current.delete(key);
      }, Math.max(8_000, 12_000 - (Date.now() - now)));
      chipTimersRef.current.set(key, timer);
    }
  }, []);

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    const inspectorTab = params.get("inspectorTab");
    if (laneId) {
      selectLane(laneId);
      if (inspectorTab === "terminals" || inspectorTab === "packs" || inspectorTab === "stack" || inspectorTab === "conflicts" || inspectorTab === "pr") {
        setLaneInspectorTab(laneId, inspectorTab);
      }
      if (params.get("focus") === "single") {
        setActiveLaneIds([laneId]);
      }
    }
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, setLaneInspectorTab, focusSession]);

  useEffect(() => {
    void loadConflictStatuses();
  }, [loadConflictStatuses, lanes.length]);

  useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type !== "prediction-complete") return;
      void loadConflictStatuses();
      pushConflictChips(event.chips);
    });
    return unsubscribe;
  }, [loadConflictStatuses, pushConflictChips]);

  useEffect(() => {
    return () => {
      for (const timer of chipTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      chipTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setPinnedLaneIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (lanesById.has(id)) next.add(id);
      }
      return next;
    });
  }, [lanesById]);

  useEffect(() => {
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    setActiveLaneIds((prev) => {
      const validPrev = prev.filter((id) => lanesById.has(id));
      const selected = selectedLaneId && lanesById.has(selectedLaneId) ? [selectedLaneId] : [];
      const fallback = selected.length ? [] : validPrev.length ? [validPrev[0]!] : sortedLanes[0]?.id ? [sortedLanes[0]!.id] : [];
      return mergeUnique(selected, fallback, validPrev, pinned);
    });
  }, [selectedLaneId, lanesById, sortedLanes, pinnedLaneIds]);

  const activeWithPins = useMemo(
    () => mergeUnique(activeLaneIds, Array.from(pinnedLaneIds).filter((id) => lanesById.has(id))),
    [activeLaneIds, pinnedLaneIds, lanesById]
  );

  const filteredSet = useMemo(() => new Set(filteredLaneIds), [filteredLaneIds]);
  const visibleLaneIds = useMemo(
    () => activeWithPins.filter((id) => lanesById.has(id) && filteredSet.has(id)),
    [activeWithPins, lanesById, filteredSet]
  );
  const managedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
  const canManageLane = Boolean(managedLane && managedLane.laneType !== "primary");
  const deletePhrase = managedLane ? `delete ${managedLane.name}` : "";

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
      const args: DeleteLaneArgs = {
        laneId: managedLane.id,
        force: deleteForce
      };
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
      if (selectedLaneId === managedLane.id) {
        selectLane(null);
      }
    });
  };

  const handleLaneSelect = (laneId: string, args: { extend: boolean }) => {
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
    if (isActive && isPinned) {
      selectLane(laneId);
      return;
    }

    const next = isActive ? activeWithPins.filter((id) => id !== laneId) : [...activeWithPins, laneId];
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    setActiveLaneIds(mergeUnique(next.length ? next : [laneId], pinned));
    selectLane(laneId);
  };

  const removeSplitLane = (laneId: string) => {
    if (pinnedLaneIds.has(laneId)) return;

    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    const next = activeWithPins.filter((id) => id !== laneId);
    const normalized = mergeUnique(next, pinned);
    setActiveLaneIds(normalized);
    if (!normalized.includes(selectedLaneId ?? "")) {
      selectLane(normalized[0] ?? null);
    }
  };

  const togglePinnedLane = (laneId: string) => {
    const lane = lanesById.get(laneId);
    if (!lane || lane.laneType === "primary") return;

    setPinnedLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });

    setActiveLaneIds((prev) => {
      if (pinnedLaneIds.has(laneId)) return prev;
      return mergeUnique(prev, [laneId]);
    });
  };

  const stepLaneSelection = useCallback((direction: -1 | 1) => {
    if (filteredLaneIds.length === 0) return;

    const currentId = selectedLaneId && filteredSet.has(selectedLaneId) ? selectedLaneId : filteredLaneIds[0]!;
    const currentIdx = filteredLaneIds.indexOf(currentId);
    const nextIdx = (currentIdx + direction + filteredLaneIds.length) % filteredLaneIds.length;
    const nextId = filteredLaneIds[nextIdx];
    if (!nextId) return;

    const pinned = Array.from(pinnedLaneIds).filter((id) => id !== nextId && lanesById.has(id));
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
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTyping = isTypingTarget(event.target);

      if (!targetIsTyping && eventMatchesBinding(event, kbFilterFocus)) {
        event.preventDefault();
        const input = document.getElementById("lanes-filter-input");
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
        return;
      }

      if (targetIsTyping) {
        if (event.key === "Escape") {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.id === "lanes-filter-input") {
            event.preventDefault();
            if (laneFilter.length > 0) {
              setLaneFilter("");
            } else {
              active.blur();
            }
          }
        }
        return;
      }

      if (eventMatchesBinding(event, kbPrevTab) || eventMatchesBinding(event, kbNextTab)) {
        event.preventDefault();
        stepLaneSelection(eventMatchesBinding(event, kbNextTab) ? 1 : -1);
        return;
      }

      if (eventMatchesBinding(event, kbNext)) {
        event.preventDefault();
        stepLaneSelection(1);
        return;
      }
      if (eventMatchesBinding(event, kbPrev)) {
        event.preventDefault();
        stepLaneSelection(-1);
        return;
      }

      if (eventMatchesBinding(event, kbConfirm) && filteredLaneIds.length > 0) {
        event.preventDefault();
        const laneId = selectedLaneId && filteredSet.has(selectedLaneId)
          ? selectedLaneId
          : filteredLaneIds[0]!;
        const pinned = Array.from(pinnedLaneIds).filter((id) => id !== laneId && lanesById.has(id));
        setActiveLaneIds(mergeUnique([laneId], pinned));
        selectLane(laneId);
      }

    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    filteredLaneIds,
    filteredSet,
    selectedLaneId,
    selectLane,
    pinnedLaneIds,
    lanesById,
    laneFilter,
    stepLaneSelection,
    kbFilterFocus,
    kbNext,
    kbPrev,
    kbNextTab,
    kbPrevTab,
    kbConfirm
  ]);

  const activeFilterTokens = useMemo(() => {
    return new Set(
      laneFilter
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
    );
  }, [laneFilter]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-semibold text-muted-fg">Lanes</div>
          <div className="relative">
            <input
              id="lanes-filter-input"
              value={laneFilter}
              onChange={(event) => setLaneFilter(event.target.value)}
              placeholder="Filter lanes (is:dirty is:pinned type:worktree)"
              className="h-7 min-w-[280px] rounded border border-border bg-card/70 px-2 pr-7 text-xs outline-none placeholder:text-muted-fg"
            />
            {laneFilter.trim().length > 0 ? (
              <button
                type="button"
                className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-fg transition-colors hover:bg-muted/70 hover:text-fg"
                onClick={() => setLaneFilter("")}
                title="Clear filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            size="sm"
            variant={activeFilterTokens.has("is:dirty") ? "primary" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setLaneFilter((prev) => toggleFilterToken(prev, "is:dirty"))}
            title="Toggle dirty lanes filter"
          >
            dirty
          </Button>
          <Button
            size="sm"
            variant={activeFilterTokens.has("is:pinned") ? "primary" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setLaneFilter((prev) => toggleFilterToken(prev, "is:pinned"))}
            title="Toggle pinned lanes filter"
          >
            pinned
          </Button>
          <Button
            size="sm"
            variant={activeFilterTokens.has("type:worktree") ? "primary" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setLaneFilter((prev) => toggleFilterToken(prev, "type:worktree"))}
            title="Toggle worktree lanes filter"
          >
            worktree
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={!canManageLane}
            onClick={() => {
              setLaneActionError(null);
              setDeleteForce(false);
              setDeleteMode("worktree");
              setDeleteRemoteName("origin");
              setDeleteConfirmText("");
              setManageOpen(true);
            }}
            title={canManageLane ? `Manage ${managedLane?.name}` : "Select a non-primary lane to manage"}
          >
            Manage lane
          </Button>

          <div className="h-4 w-px bg-border" />

          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={!canCreateLane}
            onClick={() => { setCreateLaneName(""); setCreateParentLaneId(""); setCreateOpen(true); }}
            title={canCreateLane ? "Create a new lane" : "Open a repo first"}
          >
            <Plus className="h-3 w-3 mr-0.5" /> Lane
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={!canCreateLane}
            onClick={() => { setAttachName(""); setAttachPath(""); setAttachOpen(true); }}
            title={canCreateLane ? "Attach an existing worktree" : "Open a repo first"}
          >
            <Link2 className="h-3 w-3 mr-0.5" /> Attach
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="h-7 px-2 text-[11px]"
            disabled={!selectedLaneId}
            onClick={() => {
              if (!selectedLaneId) return;
              window.ade.pty
                .create({ laneId: selectedLaneId, cols: 100, rows: 30, title: "Shell" })
                .then(({ sessionId }) => {
                  focusSession(sessionId);
                  navigate(`/lanes?laneId=${encodeURIComponent(selectedLaneId)}&sessionId=${encodeURIComponent(sessionId)}`);
                })
                .catch(() => {});
            }}
            title={selectedLaneId ? "Start a terminal session" : "Select a lane first"}
          >
            <Play className="h-3 w-3 mr-0.5" /> Terminal
          </Button>

          <div className="ml-auto text-[11px] text-muted-fg">
            {filteredLanes.length}/{sortedLanes.length} · j/k ↑↓ move · [ ] cycle · / filter
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {filteredLanes.map((lane) => {
          const isVisible = visibleLaneIds.includes(lane.id);
          const isSelected = selectedLaneId === lane.id;
          const isPrimary = lane.laneType === "primary";
          const isPinned = pinnedLaneIds.has(lane.id);
          const closable = isVisible && visibleLaneIds.length > 1 && !isPinned;
          const conflictStatus = conflictStatusByLane[lane.id];
          const chips = conflictChipsByLane[lane.id] ?? [];

          return (
            <button
              key={lane.id}
              type="button"
              className={cn(
                "inline-flex max-w-[320px] shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                isSelected
                  ? "border-accent bg-accent/25 text-fg ring-1 ring-accent/60"
                  : isVisible
                    ? "border-accent/35 bg-accent/10 text-fg"
                    : "border-border bg-card/70 text-muted-fg hover:border-muted-fg hover:text-fg",
                isPrimary && "border-emerald-500/70 bg-emerald-500/15"
              )}
              onClick={(event) => {
                handleLaneSelect(lane.id, {
                  extend: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
                });
              }}
              title={isPrimary ? "Primary lane (home workspace)" : "Lane"}
            >
              {isPrimary ? <Home className="h-3.5 w-3.5 text-emerald-700" /> : <Pin className={cn("h-3.5 w-3.5", isPinned ? "text-amber-700" : "text-muted-fg/60")} />}
              <span className={cn("h-2.5 w-2.5 rounded-full", conflictDotClass(conflictStatus?.status))} />
              <span className="truncate">{lane.name}</span>
              {isPrimary ? <span className="rounded border border-emerald-400 px-1 text-[10px] text-emerald-700">HOME</span> : null}
              {!isPrimary && isPinned ? <span className="rounded border border-amber-400 px-1 text-[10px] text-amber-800">PINNED</span> : null}
              {chips.slice(0, 1).map((chip, index) => (
                <span
                  key={`${chip.kind}:${chip.peerId ?? "base"}:${index}`}
                  className={cn(
                    "rounded border px-1 text-[10px] uppercase",
                    chip.kind === "high-risk"
                      ? "border-red-500/70 bg-red-900/30 text-red-200"
                      : "border-amber-500/70 bg-amber-900/30 text-amber-200"
                  )}
                  title={chip.peerId ? `${chipLabel(chip.kind)} with ${chip.peerId}` : chipLabel(chip.kind)}
                >
                  {chipLabel(chip.kind)}
                </span>
              ))}

              {!isPrimary ? (
                <span
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded border",
                    isPinned
                      ? "border-amber-400 bg-amber-100 text-amber-800"
                      : "border-border text-muted-fg hover:text-fg"
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

              {closable ? (
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted/60"
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

      <Group id="lanes-vertical-split" orientation="vertical" className="flex-1 min-h-0">
        <Panel id="stack-graph-panel" defaultSize={14} minSize={3} collapsible>
          <div className="flex h-full flex-col bg-card/35">
            <div className="shrink-0 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-fg">Stack graph</div>
            <StackGraph
              lanes={stackGraphLanes}
              selectedLaneId={selectedLaneId}
              onSelect={(id) => handleLaneSelect(id, { extend: false })}
            />
          </div>
        </Panel>
        <Separator className="relative h-1.5 shrink-0 cursor-row-resize border-y border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
          <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
            <GripHorizontal className="h-3 w-3" />
          </div>
        </Separator>
        <Panel id="lanes-main" minSize={50}>
          {visibleLaneIds.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
                description={filteredLanes.length === 0 ? "Adjust the lane filter." : "Select a lane tab to open changes and terminals."}
              />
            </div>
          ) : (
            <Group key={visibleLaneIds.join("|")} id="lanes-split-columns" orientation="horizontal" className="h-full w-full">
              {visibleLaneIds.map((laneId, index) => {
                const lane = lanesById.get(laneId);
                const defaultSize = Math.max(20, 100 / Math.max(1, visibleLaneIds.length));
                return (
                  <React.Fragment key={laneId}>
                    <Panel id={`lane-column:${laneId}`} minSize={18} defaultSize={defaultSize} className="h-full min-h-0 min-w-0">
                      <Group id={`lane-stack:${laneId}`} orientation="horizontal" className="h-full min-h-0 w-full">
                        <Panel id={`lane-changes:${laneId}`} minSize={30} defaultSize={58} className="h-full min-h-0">
                          <LaneDetail overrideLaneId={laneId} isPrimary={lane?.laneType === "primary"} />
                        </Panel>
                        <Separator className="relative w-2 shrink-0 cursor-col-resize border-x border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
                          <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
                            <GripVertical className="h-3 w-3" />
                          </div>
                        </Separator>
                        <Panel id={`lane-inspector:${laneId}`} minSize={22} defaultSize={42} className="h-full min-h-0">
                          <LaneInspector overrideLaneId={laneId} hideHeader />
                        </Panel>
                      </Group>
                    </Panel>

                    {index < visibleLaneIds.length - 1 ? (
                      <Separator className="relative w-2 shrink-0 cursor-col-resize border-x border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
                        <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
                          <GripVertical className="h-3 w-3" />
                        </div>
                      </Separator>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </Group>
          )}
        </Panel>
      </Group>

      <Dialog.Root open={manageOpen} onOpenChange={setManageOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border bg-card p-4 shadow-2xl focus:outline-none">
            <div className="mb-4 flex items-center justify-between gap-3">
              <Dialog.Title className="text-lg font-semibold">Manage lane</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">Esc</Button>
              </Dialog.Close>
            </div>

            {!managedLane ? (
              <div className="text-sm text-muted-fg">Select a lane first.</div>
            ) : managedLane.laneType === "primary" ? (
              <div className="text-sm text-muted-fg">Primary lane cannot be archived or deleted.</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded border border-border bg-bg/40 p-3 text-xs">
                  <div><span className="text-muted-fg">Lane:</span> {managedLane.name}</div>
                  <div><span className="text-muted-fg">Branch:</span> {managedLane.branchRef}</div>
                  <div className="truncate"><span className="text-muted-fg">Worktree:</span> {managedLane.worktreePath}</div>
                </div>

                <div className="rounded border border-border bg-bg/40 p-3">
                  <div className="mb-2 text-xs font-semibold">Archive</div>
                  <div className="mb-2 text-xs text-muted-fg">Hide lane from ADE without deleting worktree or branches.</div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={laneActionBusy}
                    onClick={() => {
                      archiveManagedLane().catch(() => {});
                    }}
                  >
                    Archive lane from ADE
                  </Button>
                </div>

                <div className="rounded border border-red-300 bg-red-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-red-900">Delete</div>
                  <div className="mb-2 text-xs text-red-800">
                    This removes the lane worktree from disk. Choose branch cleanup mode below.
                  </div>

                  <div className="mb-2 grid gap-2 md:grid-cols-3">
                    <label className="inline-flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs">
                      <input
                        type="radio"
                        name="lane-delete-mode"
                        checked={deleteMode === "worktree"}
                        onChange={() => setDeleteMode("worktree")}
                      />
                      Worktree only
                    </label>
                    <label className="inline-flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs">
                      <input
                        type="radio"
                        name="lane-delete-mode"
                        checked={deleteMode === "local_branch"}
                        onChange={() => setDeleteMode("local_branch")}
                      />
                      Worktree + local branch
                    </label>
                    <label className="inline-flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs">
                      <input
                        type="radio"
                        name="lane-delete-mode"
                        checked={deleteMode === "remote_branch"}
                        onChange={() => setDeleteMode("remote_branch")}
                      />
                      Worktree + local + remote
                    </label>
                  </div>

                  {deleteMode === "remote_branch" ? (
                    <div className="mb-2">
                      <label className="mb-1 block text-xs text-muted-fg">Remote name</label>
                      <input
                        value={deleteRemoteName}
                        onChange={(event) => setDeleteRemoteName(event.target.value)}
                        className="h-8 w-full rounded border border-border bg-card px-2 text-xs outline-none"
                        placeholder="origin"
                      />
                    </div>
                  ) : null}

                  <label className="mb-2 inline-flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={deleteForce}
                      onChange={(event) => setDeleteForce(event.target.checked)}
                    />
                    Force delete if worktree has uncommitted changes
                  </label>

                  <div className="mb-2">
                    <label className="mb-1 block text-xs text-muted-fg">
                      Type <span className="font-semibold text-red-900">{deletePhrase}</span> to confirm
                    </label>
                    <input
                      value={deleteConfirmText}
                      onChange={(event) => setDeleteConfirmText(event.target.value)}
                      className="h-8 w-full rounded border border-border bg-card px-2 text-xs outline-none"
                    />
                  </div>

                  {laneActionError ? <div className="mb-2 rounded border border-red-300 bg-red-100 px-2 py-1 text-xs text-red-900">{laneActionError}</div> : null}

                  <Button
                    size="sm"
                    variant="primary"
                    disabled={laneActionBusy || deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()}
                    onClick={() => {
                      deleteManagedLane().catch(() => {});
                    }}
                  >
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
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border bg-bg p-3 shadow-2xl focus:outline-none">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold">Create lane</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">Esc</Button>
              </Dialog.Close>
            </div>
            <div className="mt-3 space-y-2">
              <div className="text-xs text-muted-fg">Name</div>
              <input
                value={createLaneName}
                onChange={(e) => setCreateLaneName(e.target.value)}
                placeholder="e.g. feature/auth-refresh"
                className="h-10 w-full rounded border border-border bg-card/70 px-3 text-sm outline-none placeholder:text-muted-fg"
                autoFocus
              />
              <div className="space-y-1">
                <div className="text-xs text-muted-fg">Parent lane (optional)</div>
                <select
                  value={createParentLaneId}
                  onChange={(event) => setCreateParentLaneId(event.target.value)}
                  className="h-10 w-full rounded border border-border bg-card/70 px-3 text-sm outline-none"
                >
                  <option value="">None (base: {baseRef ?? "main"})</option>
                  {lanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>
                      {lane.name} ({lane.branchRef})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setCreateOpen(false); setCreateLaneName(""); setCreateParentLaneId(""); }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!createLaneName.trim().length}
                onClick={() => {
                  const name = createLaneName.trim();
                  const parentId = createParentLaneId || null;
                  const promise = parentId
                    ? window.ade.lanes.createChild({ name, parentLaneId: parentId })
                    : window.ade.lanes.create({ name });
                  promise
                    .then(async (lane) => {
                      await refreshLanes();
                      setCreateOpen(false);
                      setCreateLaneName("");
                      setCreateParentLaneId("");
                      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                    })
                    .catch(() => {});
                }}
              >
                {createParentLaneId ? "Create child lane" : "Create"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Attach Lane dialog */}
      <Dialog.Root open={attachOpen} onOpenChange={setAttachOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border bg-bg p-3 shadow-2xl focus:outline-none">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold">Attach lane</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">Esc</Button>
              </Dialog.Close>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <div className="mb-1 text-xs text-muted-fg">Lane name</div>
                <input
                  value={attachName}
                  onChange={(e) => setAttachName(e.target.value)}
                  placeholder="e.g. bugfix/from-other-worktree"
                  className="h-10 w-full rounded border border-border bg-card/70 px-3 text-sm outline-none placeholder:text-muted-fg"
                  autoFocus
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-fg">Attached path</div>
                <input
                  value={attachPath}
                  onChange={(e) => setAttachPath(e.target.value)}
                  placeholder="/absolute/path/to/existing/worktree"
                  className="h-10 w-full rounded border border-border bg-card/70 px-3 font-mono text-xs outline-none placeholder:text-muted-fg"
                />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setAttachOpen(false); setAttachName(""); setAttachPath(""); }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!attachPath.trim().length || !attachName.trim().length}
                onClick={() => {
                  const name = attachName.trim();
                  const attachedPath = attachPath.trim();
                  window.ade.lanes
                    .attach({ name, attachedPath })
                    .then(async (lane) => {
                      await refreshLanes();
                      setAttachOpen(false);
                      setAttachName("");
                      setAttachPath("");
                      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                    })
                    .catch(() => {});
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
