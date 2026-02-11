import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import * as Dialog from "@radix-ui/react-dialog";
import { GripVertical, Home, Pin, X } from "lucide-react";
import { LaneDetail } from "./LaneDetail";
import { LaneInspector } from "./LaneInspector";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import type { DeleteLaneArgs, LaneSummary } from "../../../shared/types";

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

export function LanesPage() {
  const [params] = useSearchParams();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [activeLaneIds, setActiveLaneIds] = useState<string[]>([]);
  const [pinnedLaneIds, setPinnedLaneIds] = useState<Set<string>>(new Set());
  const [laneFilter, setLaneFilter] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<"worktree" | "local_branch" | "remote_branch">("worktree");
  const [deleteRemoteName, setDeleteRemoteName] = useState("origin");
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);

  const sortedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const lanesById = useMemo(() => new Map(sortedLanes.map((lane) => [lane.id, lane])), [sortedLanes]);

  const filteredLanes = useMemo(() => {
    return sortedLanes.filter((lane) => laneMatchesFilter(lane, pinnedLaneIds.has(lane.id), laneFilter));
  }, [sortedLanes, laneFilter, pinnedLaneIds]);

  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    if (laneId) selectLane(laneId);
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, focusSession]);

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

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const targetIsTyping = isTypingTarget(event.target);

      if (!targetIsTyping && (event.key === "/" || (mod && key === "f"))) {
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

      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        stepLaneSelection(event.key === "]" ? 1 : -1);
        return;
      }

      const noMods = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (noMods && (event.key === "ArrowDown" || key === "j")) {
        event.preventDefault();
        stepLaneSelection(1);
        return;
      }
      if (noMods && (event.key === "ArrowUp" || key === "k")) {
        event.preventDefault();
        stepLaneSelection(-1);
        return;
      }

      if (noMods && event.key === "Enter" && filteredLaneIds.length > 0) {
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
  }, [filteredLaneIds, filteredSet, selectedLaneId, selectLane, pinnedLaneIds, lanesById, laneFilter, stepLaneSelection]);

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
          <div className="ml-auto text-[11px] text-muted-fg">
            {filteredLanes.length}/{sortedLanes.length} visible · Shift/Cmd/Ctrl-click split · j/k or ↑/↓ move · [ ] cycle · / or Cmd/Ctrl+F filter
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
              <span className="truncate">{lane.name}</span>
              {isPrimary ? <span className="rounded border border-emerald-400 px-1 text-[10px] text-emerald-700">HOME</span> : null}
              {!isPrimary && isPinned ? <span className="rounded border border-amber-400 px-1 text-[10px] text-amber-800">PINNED</span> : null}

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

      {visibleLaneIds.length === 0 ? (
        <div className="flex-1 min-h-0">
          <EmptyState
            title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
            description={filteredLanes.length === 0 ? "Adjust the lane filter." : "Select a lane tab to open changes and terminals."}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <Group key={visibleLaneIds.join("|")} id="lanes-split-columns" orientation="horizontal" className="h-full w-full">
            {visibleLaneIds.map((laneId, index) => {
              const lane = lanesById.get(laneId);
              const defaultSize = Math.max(20, 100 / Math.max(1, visibleLaneIds.length));
              return (
                <React.Fragment key={laneId}>
                  <Panel id={`lane-column:${laneId}`} minSize={18} defaultSize={defaultSize} className="min-w-0">
                    <Group id={`lane-stack:${laneId}`} orientation="horizontal" className="h-full w-full">
                      <Panel id={`lane-changes:${laneId}`} minSize={30} defaultSize={58}>
                        <LaneDetail overrideLaneId={laneId} isPrimary={lane?.laneType === "primary"} />
                      </Panel>
                      <Separator className="relative w-2 shrink-0 cursor-col-resize bg-border/60 transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent">
                        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
                        <div className="absolute inset-0 flex items-center justify-center text-bg/80">
                          <GripVertical className="h-3 w-3" />
                        </div>
                      </Separator>
                      <Panel id={`lane-inspector:${laneId}`} minSize={22} defaultSize={42}>
                        <LaneInspector overrideLaneId={laneId} hideHeader />
                      </Panel>
                    </Group>
                  </Panel>

                  {index < visibleLaneIds.length - 1 ? (
                    <Separator className="relative w-2 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent">
                      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
                      <div className="absolute inset-0 flex items-center justify-center text-bg/80">
                        <GripVertical className="h-3 w-3" />
                      </div>
                    </Separator>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Group>
        </div>
      )}

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
    </div>
  );
}
