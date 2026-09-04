/**
 * The fleet, as a full-height page.
 *
 * This is `CursorCloudFleetModal` moved, minus everything that made it a modal.
 * No portal, no backdrop, no `role="dialog"`, no close button and no header
 * brand block: the PAGE is the placement now. The rail tab, the Work-rail pane
 * and the phone all mount this same component, and each of them already draws
 * its own frame with its own title — a second one inside the guest would be a
 * title bar under a title bar.
 *
 * What is kept, exactly:
 *
 * - the five bodies, with the compiled sentence for each
 * - search, status chips, and a Filters overlay (lane, archived, live-update URL)
 * - a flat recency list (Cursor's own agents index), plus the archived reveal
 * - an error banner when the relay is broken; no unconfigured nag
 * - the footer's `All agents on cursor.com` link, with no query parameters
 *
 * What moved out of the page entirely is the arithmetic. The compiled modal
 * grouped, sorted by recency, summed cost cents and formatted an age. The child
 * does all four now — `groups`, `age`, the cost on `CloudUsage` and `footer`
 * arrive finished — so a phone and a Mac reading the same fleet cannot print
 * different numbers, and a page in another time zone cannot claim a run
 * finished in the future.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CircleNotch,
  CloudArrowUp,
  Copy,
  Funnel,
  MagnifyingGlass,
  Warning,
  X,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import type { CloudFleetEntry, CloudFleetPage, CloudUsage } from "../types";
import {
  archiveAgent,
  copyWebhookUrl,
  deleteAgent,
  getFleetPage,
  openInAde,
  pullIntoLane,
  stopRun,
  unarchiveAgent,
} from "../host/actions";
import { forgetAgentPage, prefetchAgentPage } from "../host/agentPageCache";
import { closeSurface, openLink, openSettings } from "../host/ui";
import { useHostRefresh } from "../host/refresh";
import { useCollectionChanges, useHostEntities, useVisible } from "../host/useHostEntities";
import { loadFilters, loadSelectedAgentId, saveFilters, saveSelectedAgentId } from "../host/uiState";
import { CURSOR_VIOLET } from "../lib/cursorCloud";
import { AgentDetail } from "./AgentDetail";
import { FleetRow } from "./FleetRow";

type FleetFilter = "all" | "active" | "finished" | "failed";

type FleetFilters = {
  status: FleetFilter;
  lane: string;
  showArchived: boolean;
};

const DEFAULT_FILTERS: FleetFilters = { status: "all", lane: "all", showArchived: false };

const STATUS_CHIPS: { id: FleetFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Running" },
  { id: "finished", label: "Done" },
  { id: "failed", label: "Failed" },
];

/** How often the visible fleet re-reads Cursor when no webhook is wired. */
const FLEET_POLL_MS = 15_000;

/**
 * Cursor's own agents index, with NO query parameters.
 *
 * The compiled footer linked exactly this. A repo or project filter appended
 * here would send the reader somewhere the label "All agents on cursor.com"
 * does not promise.
 */
const CURSOR_AGENTS_URL = "https://cursor.com/agents";

function isDefaultFilters(filters: FleetFilters): boolean {
  return filters.status === DEFAULT_FILTERS.status
    && filters.lane === DEFAULT_FILTERS.lane
    && filters.showArchived === DEFAULT_FILTERS.showArchived;
}

function activeFilterCount(filters: FleetFilters): number {
  return (filters.status !== DEFAULT_FILTERS.status ? 1 : 0)
    + (filters.lane !== DEFAULT_FILTERS.lane ? 1 : 0)
    + (filters.showArchived ? 1 : 0);
}

type PendingLaneCreate = {
  agentId: string;
  suggestedName: string;
  branch: string | null;
};

/**
 * The stored-value validation the compiled modal never needed.
 *
 * It held its filters in React state and lost them on close. These survive in a
 * collection, so a value written by an older build — or by a hand editing the
 * row — has to be checked field by field rather than trusted.
 */
function normalizeStoredFilters(parsed: Partial<FleetFilters>): FleetFilters {
  const status = parsed.status;
  return {
    status: status === "active" || status === "finished" || status === "failed" || status === "all"
      ? status
      : DEFAULT_FILTERS.status,
    lane: typeof parsed.lane === "string" && parsed.lane.length > 0 ? parsed.lane : DEFAULT_FILTERS.lane,
    showArchived: parsed.showArchived === true,
  };
}

/**
 * `filterMatches`, verbatim.
 *
 * The coarse agent-list status and the refined run status are both consulted,
 * in that order, because an agent Cursor has listed but never run has only the
 * first. `active` is the child's own answer rather than a re-derivation: it
 * runs the same `isCursorCloudFleetEntryActive` the compiled modal did, and two
 * implementations of that predicate is exactly how section placement and Stop
 * visibility drift apart.
 */
function filterMatches(entry: CloudFleetEntry, filter: FleetFilter): boolean {
  switch (filter) {
    case "active":
      return entry.active;
    case "finished":
      return entry.status === "finished";
    case "failed":
      return entry.status === "error" || entry.status === "expired";
    case "all":
      return true;
    default: {
      const exhaustive: never = filter;
      void exhaustive;
      return true;
    }
  }
}

function searchMatches(entry: CloudFleetEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    entry.agent.name,
    entry.agent.summary,
    entry.branch,
    entry.repoLabel,
    entry.envName,
    entry.ownership.laneName,
    entry.ownership.linearIssueId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export function Fleet({
  projectRoot,
  initialAgentId,
}: {
  projectRoot: string | null;
  /** A deeplink that landed on the fleet with an agent named. Opens its detail. */
  initialAgentId?: string | null;
}): React.ReactElement {
  const [page, setPage] = useState<CloudFleetPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FleetFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [webhookCopyMessage, setWebhookCopyMessage] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId ?? null);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ agentId: string; message: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [usageByAgentId, setUsageByAgentId] = useState<Record<string, CloudUsage>>({});
  const [pulledNotice, setPulledNotice] = useState<string | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [pendingLane, setPendingLane] = useState<PendingLaneCreate | null>(null);
  const [laneNameDraft, setLaneNameDraft] = useState("");
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);

  /**
   * The generation guard, and the two write counters that go with it.
   *
   * `requestGeneration` is the compiled modal's own: a soft refresh that
   * resolves after a later one must not paint. The two write counters exist
   * only because the filters and the selection are now read back
   * ASYNCHRONOUSLY from a collection — a hydrate that lands after the reader
   * already touched a select would otherwise clobber the choice they just made.
   */
  const requestGeneration = useRef(0);
  const filterWriteRef = useRef(0);
  const selectionWriteRef = useRef(0);

  const load = useCallback((soft: boolean) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    void getFleetPage()
      .then((next) => {
        if (requestGeneration.current !== generation) return;
        setPage(next);
      })
      .catch((err: unknown) => {
        if (requestGeneration.current !== generation) return;
        // A throw here is the bridge failing, not Cursor refusing: a Cursor
        // refusal arrives as `state: "error"` with the sentence already worded.
        setError(err instanceof Error ? err.message : "Could not load your cloud agents.");
      })
      .finally(() => {
        if (requestGeneration.current !== generation) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    if (!showFiltersPanel) return;
    const onDocClick = (event: MouseEvent) => {
      if (filtersPanelRef.current && !filtersPanelRef.current.contains(event.target as Node)) {
        setShowFiltersPanel(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showFiltersPanel]);

  /* ── Persistence ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const filterWritesAtStart = filterWriteRef.current;
    const selectionWritesAtStart = selectionWriteRef.current;
    void loadFilters(projectRoot, DEFAULT_FILTERS, normalizeStoredFilters).then((stored) => {
      if (filterWriteRef.current !== filterWritesAtStart) return;
      setFilters(stored);
    });
    void loadSelectedAgentId(projectRoot).then((stored) => {
      if (selectionWriteRef.current !== selectionWritesAtStart) return;
      // A deeplink's agent outranks the remembered one: the reader asked for
      // that agent in this act, and the stored id is only where they were last.
      setSelectedAgentId((current) => current ?? stored);
    });
  }, [projectRoot]);

  const updateFilters = useCallback((next: Partial<FleetFilters>) => {
    filterWriteRef.current += 1;
    setFilters((current) => {
      const merged = { ...current, ...next };
      // Fire and forget: losing a filter preference must never block the list,
      // and `saveFilters` swallows a collection failure of its own.
      void saveFilters(projectRoot, merged, isDefaultFilters(merged));
      return merged;
    });
  }, [projectRoot]);

  const selectAgent = useCallback((agentId: string | null) => {
    selectionWriteRef.current += 1;
    setSelectedAgentId(agentId);
    void saveSelectedAgentId(projectRoot, agentId);
  }, [projectRoot]);

  /* ── Freshness: the relay, a poll while it is missing, and the reader's hand. ─── */

  const softRefresh = useCallback(() => load(true), [load]);

  /**
   * A wake the reader did not ask for is only honoured while they can see it.
   *
   * The compiled modal's relay handler opened with
   * `if (document.visibilityState !== "visible") return;` — a hidden surface
   * answering every finished run is work nobody can see, and a guest pays for
   * it in the host's process. `useVisible` is the other half of that bargain:
   * whatever arrived while the placement was hidden is picked up the moment it
   * is shown again, so the guard costs no freshness.
   */
  const backgroundRefresh = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    load(true);
  }, [load]);

  useCollectionChanges(backgroundRefresh, "fleet");
  useHostEntities(["lane", "session"], backgroundRefresh);
  useVisible(softRefresh);
  // The reader's own hand always wins: a pull-down is never skipped.
  useHostRefresh(softRefresh);

  /**
   * Cursor has no API to register a webhook. While the relay is not `ready`,
   * poll the fleet so the list does not sit on a guilt banner. A ready relay
   * still wakes us through `useCollectionChanges`.
   */
  useEffect(() => {
    const state = page?.webhook?.state;
    if (!state || state === "ready") return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      load(true);
    };
    const handle = window.setInterval(tick, FLEET_POLL_MS);
    return () => window.clearInterval(handle);
  }, [load, page?.webhook?.state]);

  useEffect(() => {
    if (showFiltersPanel) return;
    setWebhookCopyMessage(null);
  }, [showFiltersPanel]);

  /* ── Row actions ──────────────────────────────────────────────────────── */

  /**
   * One shape for every mutation.
   *
   * The compiled modal wrote the same seven lines around each of its six
   * actions — busy on, clear the row error, await, refresh, catch into the row
   * error, busy off. The one difference here is that a refusal is a resolved
   * `{ok:false, message}` rather than a throw, so both paths land in the same
   * place.
   */
  const runAction = useCallback((
    agentId: string,
    run: () => Promise<{ ok: boolean; message?: string | null }>,
    options?: { onOk?: (message: string | null) => void },
  ) => {
    setBusyAgentId(agentId);
    setRowError(null);
    void run()
      .then((result) => {
        if (!result.ok) {
          setRowError({ agentId, message: result.message || "Cursor refused that." });
          return;
        }
        options?.onOk?.(result.message ?? null);
        load(true);
      })
      .catch((err: unknown) => {
        setRowError({
          agentId,
          message: err instanceof Error ? err.message : "Cursor Cloud request failed.",
        });
      })
      .finally(() => setBusyAgentId(null));
  }, [load]);

  const onOpen = useCallback((entry: CloudFleetEntry) => {
    // The compiled modal closed itself once the chat existed, because the app
    // navigated to it behind the backdrop. `closeSurface` is that same act and
    // is a no-op in a tab or a pane, which is the host's call and not this
    // page's guess.
    //
    // `needsLane` is not a row error: the agent has a branch but no local
    // lane yet, and the next step is a create-from-primary confirm.
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    void openInAde(agentId)
      .then((result) => {
        if (result.needsLane === true) {
          const suggestedName = typeof result.suggestedName === "string" && result.suggestedName.trim()
            ? result.suggestedName.trim()
            : entry.branch ?? entry.agent.name ?? "cloud-agent";
          setPendingLane({
            agentId,
            suggestedName,
            branch: typeof result.branch === "string" ? result.branch : entry.branch,
          });
          setLaneNameDraft(suggestedName);
          return;
        }
        if (!result.ok) {
          setRowError({ agentId, message: result.message || "Cursor refused that." });
          return;
        }
        void closeSurface();
        load(true);
      })
      .catch((err: unknown) => {
        setRowError({
          agentId,
          message: err instanceof Error ? err.message : "Cursor Cloud request failed.",
        });
      })
      .finally(() => setBusyAgentId(null));
  }, [load]);

  const onConfirmCreateLane = useCallback(() => {
    if (!pendingLane) return;
    const name = laneNameDraft.trim() || pendingLane.suggestedName;
    runAction(pendingLane.agentId, () => openInAde(pendingLane.agentId, {
      createLane: true,
      laneName: name,
    }), {
      onOk: () => {
        setPendingLane(null);
        void closeSurface();
      },
    });
  }, [laneNameDraft, pendingLane, runAction]);

  const onStop = useCallback((entry: CloudFleetEntry) => {
    runAction(entry.agent.agentId, () => stopRun(entry.agent.agentId));
  }, [runAction]);

  const onPull = useCallback((entry: CloudFleetEntry) => {
    runAction(entry.agent.agentId, () => pullIntoLane(entry.agent.agentId), {
      // The child words the sentence — "Created lane 'x' and merged y." or
      // "Merged y into 'x'." — because only it knows which of the two happened.
      onOk: (message) => setPulledNotice(message),
    });
  }, [runAction]);

  const onArchive = useCallback((entry: CloudFleetEntry) => {
    runAction(
      entry.agent.agentId,
      () => (entry.agent.archived
        ? unarchiveAgent(entry.agent.agentId)
        : archiveAgent(entry.agent.agentId)),
    );
  }, [runAction]);

  const onDelete = useCallback((entry: CloudFleetEntry) => {
    setConfirmDeleteId(null);
    if (selectedAgentId === entry.agent.agentId) selectAgent(null);
    // An agent deleted on Cursor must not still be paintable from memory.
    forgetAgentPage(entry.agent.agentId);
    runAction(entry.agent.agentId, () => deleteAgent(entry.agent.agentId));
  }, [runAction, selectAgent, selectedAgentId]);

  const onToggleRow = useCallback((entry: CloudFleetEntry) => {
    setConfirmDeleteId(null);
    selectAgent(selectedAgentId === entry.agent.agentId ? null : entry.agent.agentId);
  }, [selectAgent, selectedAgentId]);

  const rememberUsage = useCallback((agentId: string, usage: CloudUsage | null) => {
    if (!usage) return;
    setUsageByAgentId((current) => ({ ...current, [agentId]: usage }));
  }, []);

  /* ── What actually draws ──────────────────────────────────────────────── */

  /**
   * The child still groups for the TUI/vocabulary panel. This page draws a
   * flat recency list, like Cursor's own agents index, and only hides rows
   * the filters and search asked to hide.
   *
   * The lane filter still hides every unlinked row: an unlinked agent has no
   * `ownership.laneId`, so it can never equal the chosen lane. "Show me lane
   * X" is not a request to also see agents that belong to no lane at all.
   */
  const keep = useCallback((entry: CloudFleetEntry): boolean => {
    if (!filters.showArchived && entry.agent.archived) return false;
    if (filters.lane !== "all" && entry.ownership.laneId !== filters.lane) return false;
    if (!searchMatches(entry, search)) return false;
    return filterMatches(entry, filters.status);
  }, [filters, search]);

  const visibleEntries = useMemo(() => {
    const rows = (page?.entries ?? []).filter(keep);
    rows.sort((a, b) => (b.agent.createdAt ?? 0) - (a.agent.createdAt ?? 0));
    return rows;
  }, [keep, page]);

  /** The open row, straight from the list the fleet already holds. */
  const selectedEntry = useMemo(
    () => visibleEntries.find((entry) => entry.agent.agentId === selectedAgentId) ?? null,
    [selectedAgentId, visibleEntries],
  );

  /**
   * Warm the rows either side of the open one.
   *
   * Reading a fleet is a walk, and the two rows a reader can reach with one
   * press are the two above and below. Fetching them while the reader is
   * looking at this one turns the next press into a paint rather than a wait,
   * and costs two reads that the memory in `agentPageCache` then reuses.
   */
  useEffect(() => {
    if (!selectedAgentId) return;
    const index = visibleEntries.findIndex((entry) => entry.agent.agentId === selectedAgentId);
    if (index < 0) return;
    prefetchAgentPage(visibleEntries[index - 1]?.agent.agentId);
    prefetchAgentPage(visibleEntries[index + 1]?.agent.agentId);
  }, [selectedAgentId, visibleEntries]);

  const laneOptions = page?.laneOptions ?? [];
  const archivedCount = page?.archivedCount ?? 0;
  const state = error ? "error" : page?.state ?? "loading";
  const errorSentence = error ?? page?.error ?? "";

  const rowProps = (entry: CloudFleetEntry) => ({
    entry,
    expanded: selectedAgentId === entry.agent.agentId,
    selected: selectedAgentId === entry.agent.agentId,
    busy: busyAgentId === entry.agent.agentId,
    confirmingDelete: confirmDeleteId === entry.agent.agentId,
    usage: usageByAgentId[entry.agent.agentId],
    rowError: rowError?.agentId === entry.agent.agentId ? rowError.message : null,
    onToggle: () => onToggleRow(entry),
    onOpen: () => onOpen(entry),
    onStop: () => onStop(entry),
    onPull: () => onPull(entry),
    onArchive: () => onArchive(entry),
    onRequestDelete: () => setConfirmDeleteId(
      confirmDeleteId === entry.agent.agentId ? null : entry.agent.agentId,
    ),
    onConfirmDelete: () => onDelete(entry),
  });

  const relayBanner = (() => {
    const webhook = page?.webhook;
    if (!webhook || loading) return null;
    if (webhook.state === "ready") return null;
    if (webhook.state === "error") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-500/[0.06] px-4 py-1.5 text-[11px] text-amber-100/80">
          <Warning size={12} weight="fill" />
          Live updates hit an error — statuses may be stale. Use refresh.
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
         * The toolbar.
         *
         * Filters live in an overlay so the header stays one row, the same
         * pattern Graph uses. Refresh stays on the bar.
         */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-white/10 px-3.5 py-2">
          <div className="flex items-center gap-1.5">
            <label className="relative min-w-0 flex-1">
              <MagnifyingGlass
                size={12}
                weight="bold"
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg/35"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                className="h-7 w-full rounded-md border border-white/[0.08] bg-white/[0.03] pl-7 pr-2 text-[11px] text-fg/80 outline-none placeholder:text-fg/35 hover:border-white/[0.16] focus:border-violet-300/35"
              />
            </label>
            <div className="relative" ref={filtersPanelRef}>
              <button
                type="button"
                onClick={() => setShowFiltersPanel((current) => !current)}
                aria-expanded={showFiltersPanel}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium",
                  showFiltersPanel || activeFilterCount(filters) > 0
                    ? "border-violet-300/30 bg-violet-500/[0.10] text-violet-100/90"
                    : "border-white/[0.07] text-fg/60 hover:border-white/[0.16] hover:text-fg/85",
                )}
              >
                <Funnel size={12} weight="bold" />
                Filters
                {activeFilterCount(filters) > 0 ? (
                  <span className="rounded-full bg-violet-400/30 px-1.5 py-px text-[10px]">
                    {activeFilterCount(filters)}
                  </span>
                ) : null}
              </button>
              {showFiltersPanel ? (
                <div className="absolute right-0 top-8 z-40 w-[280px] rounded-lg border border-white/[0.10] bg-[#17151f] p-2.5 shadow-xl shadow-black/50">
                  {laneOptions.length > 0 ? (
                    <>
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.8px] text-fg/40">
                        Lane
                      </div>
                      <select
                        value={filters.lane}
                        onChange={(event) => updateFilters({ lane: event.target.value })}
                        aria-label="Filter by lane"
                        className="mb-2 h-7 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-fg/70 outline-none hover:border-white/[0.16]"
                      >
                        <option value="all">All lanes</option>
                        {laneOptions.map((lane) => (
                          <option key={lane.id} value={lane.id}>{lane.name}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  <label className="mb-2 flex items-center gap-2 text-[11px] text-fg/70">
                    <input
                      type="checkbox"
                      checked={filters.showArchived}
                      onChange={(event) => updateFilters({ showArchived: event.target.checked })}
                    />
                    Show archived
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      void copyWebhookUrl().then((result) => {
                        setWebhookCopyMessage(result.ok ? "Copied live-update URL" : (result.message ?? "Could not copy"));
                      });
                    }}
                    className="mb-2 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.10] px-2 text-[11px] text-fg/70 hover:border-white/[0.2] hover:text-fg/90"
                  >
                    <Copy size={11} weight="bold" />
                    {webhookCopyMessage ?? "Copy live-update URL"}
                  </button>
                  <div className="flex justify-end gap-1.5 border-t border-white/[0.06] pt-2">
                    <button
                      type="button"
                      onClick={() => updateFilters(DEFAULT_FILTERS)}
                      className="h-7 rounded-md px-2 text-[11px] text-fg/50 hover:text-fg/80"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowFiltersPanel(false)}
                      className="h-7 rounded-md border border-white/[0.10] px-2 text-[11px] text-fg/75 hover:border-white/[0.2]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={loading || refreshing}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.07] text-fg/50",
                "transition-colors hover:border-white/[0.16] hover:text-fg/85 disabled:opacity-40",
              )}
              title="Refresh"
              aria-label="Refresh fleet"
            >
              <ArrowsClockwise size={12} weight="bold" className={refreshing ? "animate-spin" : undefined} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
            {STATUS_CHIPS.map((chip) => {
              const pressed = filters.status === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => updateFilters({ status: chip.id })}
                  className={cn(
                    "h-6 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
                    pressed
                      ? "border-violet-300/35 bg-violet-500/[0.14] text-violet-100/95"
                      : "border-white/[0.08] text-fg/55 hover:border-white/[0.16] hover:text-fg/80",
                  )}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {relayBanner}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {state === "loading" ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg/45">
              <CircleNotch size={18} weight="bold" className="animate-spin" />
              <span className="text-[12px]">Loading cloud agents…</span>
            </div>
          ) : state === "no-key" || state === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <Warning size={22} className="text-red-300/80" weight="fill" />
              <div className="max-w-[420px] text-[12.5px] leading-relaxed text-fg/70">
                {state === "no-key"
                  ? "Connect Cursor first — add an API key or log in via Settings → AI connections."
                  : `Could not load your cloud agents: ${errorSentence}`}
              </div>
              {state === "no-key" ? (
                <button
                  type="button"
                  className="rounded-md border border-violet-300/30 bg-violet-500/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-violet-100/90 transition-colors hover:bg-violet-500/[0.18]"
                  /*
                   * The compiled button wrote `window.location.hash`. A guest
                   * has its own document and its own hash, and writing one here
                   * would navigate the PAGE rather than the app; the host owns
                   * its routes, so it is asked instead.
                   */
                  onClick={() => void openSettings({ entryId: "agents.providers" })}
                >
                  Open AI connections
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-md border border-white/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-fg/75 hover:border-white/[0.2]"
                  onClick={() => load(false)}
                >
                  Retry
                </button>
              )}
            </div>
          ) : state === "empty" ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <span
                className="grid h-10 w-10 place-items-center rounded-xl"
                style={{ background: "rgba(167,139,250,0.10)", color: CURSOR_VIOLET }}
              >
                <CloudArrowUp size={20} weight="fill" />
              </span>
              <div className="text-[13px] font-medium text-fg/80">No cloud agents for this project</div>
              <div className="max-w-[380px] text-[11.5px] leading-relaxed text-fg/45">
                Agents you launch from any chat composer with a Cursor model — and anything on cursor.com
                for this repo — will show up here.
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 px-4 py-3">
              {visibleEntries.length === 0 ? (
                <div className="px-2 py-10 text-center text-[12px] text-fg/45">
                  No agents match these filters.
                </div>
              ) : (
                visibleEntries.map((entry) => (
                  <FleetRow key={entry.agent.agentId} {...rowProps(entry)} />
                ))
              )}

              {archivedCount > 0 && !filters.showArchived ? (
                <div className="pt-1 text-center">
                  <button
                    type="button"
                    onClick={() => updateFilters({ showArchived: true })}
                    className="text-[11px] text-fg/40 underline-offset-2 transition-colors hover:text-fg/70 hover:underline"
                  >
                    Show archived ({archivedCount})
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-2 text-[10.5px] text-fg/40">
          {/* `12 agents · updated just now` — worded and counted by the child. */}
          <span className="min-w-0 truncate">{page?.footer ?? ""}</span>
          {filters.showArchived ? (
            <button
              type="button"
              onClick={() => updateFilters({ showArchived: false })}
              className="shrink-0 transition-colors hover:text-fg/70"
            >
              Hide archived
            </button>
          ) : (
            <button
              type="button"
              /*
               * No query parameters, deliberately. The compiled link was the
               * bare agents index — Cursor's own list, not this project's — and
               * appending a repo filter would send the reader somewhere the
               * label does not promise.
               */
              onClick={() => void openLink(CURSOR_AGENTS_URL)}
              className="inline-flex shrink-0 items-center gap-1 transition-colors hover:text-fg/70"
            >
              All agents on cursor.com
              <ArrowSquareOut size={10} weight="bold" />
            </button>
          )}
        </div>

        {pulledNotice ? (
          <div
            role="status"
            className="absolute bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-emerald-400/25 bg-[#101a14]/95 px-3.5 py-2 text-[11.5px] text-emerald-100/90 shadow-lg"
          >
            {pulledNotice}
            <button
              type="button"
              onClick={() => setPulledNotice(null)}
              className="ml-1 text-emerald-100/50 hover:text-emerald-100/90"
              aria-label="Dismiss"
            >
              <X size={11} weight="bold" />
            </button>
          </div>
        ) : null}

        {pendingLane ? (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 px-4"
            role="dialog"
            aria-labelledby="cloud-create-lane-title"
          >
            <div className="w-full max-w-[380px] rounded-xl border border-white/[0.10] bg-[#17151f] p-4 shadow-xl shadow-black/50">
              <div id="cloud-create-lane-title" className="text-[13px] font-semibold text-fg/90">
                Create a local lane
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-fg/55">
                This cloud agent has no local lane yet
                {pendingLane.branch ? ` for ${pendingLane.branch}` : ""}.
                Create one from the primary, then open the chat in ADE.
              </p>
              <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.8px] text-fg/40">
                Lane name
                <input
                  value={laneNameDraft}
                  onChange={(event) => setLaneNameDraft(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-white/[0.10] bg-white/[0.03] px-2 text-[12px] font-normal normal-case tracking-normal text-fg outline-none"
                />
              </label>
              <div className="mt-3 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setPendingLane(null)}
                  className="h-7 rounded-md px-2 text-[11px] text-fg/55 hover:text-fg/85"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onConfirmCreateLane}
                  disabled={busyAgentId === pendingLane.agentId}
                  className="h-7 rounded-md border border-violet-300/30 bg-violet-500/[0.12] px-2.5 text-[11px] font-semibold text-violet-100/90 disabled:opacity-40"
                >
                  Create lane and open
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/*
       * The detail.
       *
       * One node, two layouts, and no user-agent branch anywhere: at 860px and
       * up it is a right pane beside the list; below that the same element is
       * fixed over the whole viewport, because a 380px pane next to a 320px
       * list is two unreadable columns rather than one readable one.
       */}
      {selectedAgentId ? (
        <div className="fixed inset-0 z-30 min-[860px]:relative min-[860px]:inset-auto min-[860px]:z-auto min-[860px]:w-[380px] min-[860px]:shrink-0 min-[860px]:border-l min-[860px]:border-white/[0.07]">
          <AgentDetail
            agentId={selectedAgentId}
            initialEntry={selectedEntry}
            onClose={() => selectAgent(null)}
            onUsage={rememberUsage}
            onChanged={softRefresh}
          />
        </div>
      ) : null}
    </div>
  );
}
