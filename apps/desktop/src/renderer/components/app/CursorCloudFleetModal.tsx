import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CircleNotch,
  CloudArrowUp,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Cursor } from "@lobehub/icons";

import type {
  CursorAgentUsage,
  CursorCloudFleetEntry,
  CursorCloudFleetEvent,
  CursorCloudFleetResult,
} from "../../../shared/types";
import { isCursorCloudFleetEntryActive } from "../../../shared/cursorCloudFleetStatus";
import { openExternalUrl } from "../../lib/openExternal";
import { cursorCloudErrorMessage, repoMatchKey, cursorCloudRepoLabel, formatCursorCloudAge } from "../../lib/cursorCloudUtils";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { FleetRow, SectionHeader } from "./CursorCloudFleetRow";

const CURSOR_VIOLET = "#A78BFA";

type FleetFilter = "all" | "active" | "finished" | "failed";

function filterMatches(entry: CursorCloudFleetEntry, filter: FleetFilter): boolean {
  const status = entry.runStatus ?? entry.agent.status;
  switch (filter) {
    case "active":
      return isCursorCloudFleetEntryActive(entry);
    case "finished":
      return status === "finished";
    case "failed":
      return status === "error" || status === "expired";
    default:
      return true;
  }
}

export function CursorCloudFleetModal({
  projectRoot,
  projectName,
  onClose,
}: {
  projectRoot: string | null;
  projectName: string | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<CursorCloudFleetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [laneFilter, setLaneFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ agentId: string; message: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [usageByAgentId, setUsageByAgentId] = useState<Record<string, CursorAgentUsage>>({});
  const [pulledNotice, setPulledNotice] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const refresh = useCallback(async (soft: boolean) => {
    const generation = ++requestGeneration.current;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await window.ade.ai.cursorCloudFleet({ includeArchived: true, limit: 200 });
      if (generation !== requestGeneration.current) return;
      setResult(next);
      setKeyMissing(false);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      const message = cursorCloudErrorMessage(err);
      setKeyMissing(/api key/i.test(message));
      setError(message);
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Relay wake: a FINISHED/ERROR webhook refreshes the affected row's data.
  // There is deliberately no timer here — freshness comes from the relay or
  // from the user's hand.
  useEffect(() => {
    const unsubscribe = window.ade.ai.onCursorCloudFleetEvent((event: CursorCloudFleetEvent) => {
      if (!event?.agentId) return;
      if (document.visibilityState !== "visible") return;
      void refresh(true);
    });
    return unsubscribe;
  }, [refresh]);

  const entries = useMemo(() => result?.items ?? [], [result]);

  const laneOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (entry.ownership.laneId && entry.ownership.laneName) {
        seen.set(entry.ownership.laneId, entry.ownership.laneName);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [entries]);

  const visibleEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (!showArchived && entry.agent.archived) return false;
      if (laneFilter !== "all" && entry.ownership.laneId !== laneFilter) {
        // Unlinked rows survive a lane filter only when "all" is chosen.
        return false;
      }
      return filterMatches(entry, filter);
    });
  }, [entries, filter, laneFilter, showArchived]);

  const grouped = useMemo(() => {
    const active: CursorCloudFleetEntry[] = [];
    const byLane = new Map<string, { laneId: string; laneName: string; entries: CursorCloudFleetEntry[] }>();
    const unlinked = new Map<string, CursorCloudFleetEntry[]>();
    for (const entry of visibleEntries) {
      if (isCursorCloudFleetEntryActive(entry)) {
        active.push(entry);
        continue;
      }
      if (entry.ownership.laneId) {
        const key = entry.ownership.laneId;
        const group = byLane.get(key)
          ?? { laneId: key, laneName: entry.ownership.laneName ?? "Lane", entries: [] };
        group.entries.push(entry);
        byLane.set(key, group);
      } else {
        const key = repoMatchKey(entry.agent.repos?.[0]) + "|" + (entry.branch ?? "");
        const list = unlinked.get(key) ?? [];
        list.push(entry);
        unlinked.set(key, list);
      }
    }
    const recency = (entry: CursorCloudFleetEntry): number =>
      entry.agent.lastModified ?? entry.agent.createdAt ?? 0;
    active.sort((a, b) => recency(b) - recency(a));
    const lanes = [...byLane.values()];
    for (const group of lanes) {
      group.entries.sort((a, b) => recency(b) - recency(a));
    }
    lanes.sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));
    const unlinkedGroups = [...unlinked.entries()]
      .map(([key, list]) => ({
        key,
        label: list[0]?.agent.repos?.[0]
          ? `${cursorCloudRepoLabel(list[0].agent.repos[0])}${list[0].branch ? ` · ${list[0].branch}` : ""}`
          : "Unknown repo",
        entries: list.sort((a, b) => recency(b) - recency(a)),
      }))
      .sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));
    return { active, lanes, unlinkedGroups };
  }, [visibleEntries]);

  const totalCostCents = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const entry of visibleEntries) {
      const usage = usageByAgentId[entry.agent.agentId];
      const cents = usage?.cost?.chargedCents ?? usage?.cost?.rawCostCents;
      if (typeof cents === "number" && Number.isFinite(cents)) {
        sum += cents;
        any = true;
      }
    }
    return any ? sum : null;
  }, [usageByAgentId, visibleEntries]);

  const expandEntry = useCallback(async (agentId: string) => {
    setExpandedId((current) => (current === agentId ? null : agentId));
    setConfirmDeleteId(null);
    if (usageByAgentId[agentId]) return;
    try {
      const usage = await window.ade.ai.cursorCloudGetUsage({ agentId });
      setUsageByAgentId((current) => ({ ...current, [agentId]: usage }));
    } catch {
      // Cost is optional decoration; absence renders as no chip.
    }
  }, [usageByAgentId]);

  const openInAde = useCallback(async (entry: CursorCloudFleetEntry) => {
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    try {
      let laneId = entry.ownership.laneId;
      if (!laneId) {
        const resolved = await window.ade.ai.cursorCloudResolveLane(agentId);
        laneId = resolved.laneId;
      }
      const opened = await window.ade.ai.cursorCloudOpenChat({
        cloudAgentId: agentId,
        laneId,
        agentName: entry.agent.name,
      });
      if (opened.session) {
        announceWorkChatSessionCreated(projectRoot ?? "", opened.session);
      }
      onClose();
    } catch (err) {
      setRowError({ agentId, message: cursorCloudErrorMessage(err) });
    } finally {
      setBusyAgentId(null);
    }
  }, [onClose, projectRoot]);

  const stopRun = useCallback(async (entry: CursorCloudFleetEntry) => {
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    try {
      await window.ade.ai.cursorCloudStopRun(agentId);
      await refresh(true);
    } catch (err) {
      setRowError({ agentId, message: cursorCloudErrorMessage(err) });
    } finally {
      setBusyAgentId(null);
    }
  }, [refresh]);

  const pullIntoLane = useCallback(async (entry: CursorCloudFleetEntry) => {
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    try {
      const pulled = await window.ade.ai.cursorCloudPullIntoLane(agentId);
      setPulledNotice(
        pulled.status === "created_lane"
          ? `Created lane '${pulled.laneName}' and merged ${pulled.mergedBranch}.`
          : `Merged ${pulled.mergedBranch} into '${pulled.laneName}'.`,
      );
      void refreshLanes();
      await refresh(true);
    } catch (err) {
      setRowError({ agentId, message: cursorCloudErrorMessage(err) });
    } finally {
      setBusyAgentId(null);
    }
  }, [refresh, refreshLanes]);

  const toggleArchive = useCallback(async (entry: CursorCloudFleetEntry) => {
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    try {
      if (entry.agent.archived) await window.ade.ai.cursorCloudUnarchiveAgent(agentId);
      else await window.ade.ai.cursorCloudArchiveAgent(agentId);
      await refresh(true);
    } catch (err) {
      setRowError({ agentId, message: cursorCloudErrorMessage(err) });
    } finally {
      setBusyAgentId(null);
    }
  }, [refresh]);

  const deleteAgent = useCallback(async (entry: CursorCloudFleetEntry) => {
    const agentId = entry.agent.agentId;
    setBusyAgentId(agentId);
    setRowError(null);
    try {
      await window.ade.ai.cursorCloudDeleteAgent(agentId);
      setConfirmDeleteId(null);
      setResult((current) => current
        ? { ...current, items: current.items.filter((item) => item.agent.agentId !== agentId) }
        : current);
    } catch (err) {
      setRowError({ agentId, message: cursorCloudErrorMessage(err) });
    } finally {
      setBusyAgentId(null);
    }
  }, []);

  const archivedCount = useMemo(
    () => entries.filter((entry) => entry.agent.archived).length,
    [entries],
  );

  const relayBanner = (() => {
    if (!result || loading) return null;
    if (result.relayState === "ready") return null;
    if (result.relayState === "error") {
      return (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-500/[0.06] px-4 py-1.5 text-[11px] text-amber-100/80">
          <Warning size={12} weight="fill" />
          Live updates hit an error — statuses may be stale. Use refresh.
        </div>
      );
    }
    return (
      <div className="shrink-0 border-b border-white/[0.05] px-4 py-1.5 text-[11px] text-fg/45">
        Live updates not configured yet — this list updates on refresh and when agents finish.
      </div>
    );
  })();

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close Cursor Cloud fleet"
        className="fixed inset-0 z-[9998] cursor-default bg-black/55 backdrop-blur-md"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cursor Cloud fleet"
        className="fixed left-1/2 top-1/2 z-[9999] flex h-[min(760px,calc(100dvh-28px))] w-[min(880px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
        style={{
          borderColor: "rgba(167,139,250,0.32)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(167,139,250,0.14)",
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3.5 py-2" style={{ background: "rgba(167,139,250,0.055)" }}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              style={{ background: "rgba(167,139,250,0.14)", color: CURSOR_VIOLET }}
            >
              <Cursor.Avatar size={14} />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[12.5px] font-medium text-fg/92">Cursor Cloud</div>
              <div className="truncate text-[10.5px] text-fg/45">
                {projectName ? `${projectName} · ` : ""}fleet
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FleetFilter)}
              aria-label="Filter by status"
              className="h-7 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-fg/70 outline-none hover:border-white/[0.16]"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="finished">Finished</option>
              <option value="failed">Failed</option>
            </select>
            {laneOptions.length > 0 ? (
              <select
                value={laneFilter}
                onChange={(event) => setLaneFilter(event.target.value)}
                aria-label="Filter by lane"
                className="h-7 max-w-[140px] rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-fg/70 outline-none hover:border-white/[0.16]"
              >
                <option value="all">All lanes</option>
                {laneOptions.map((lane) => (
                  <option key={lane.id} value={lane.id}>{lane.name}</option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={() => void refresh(true)}
              disabled={loading || refreshing}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.07] text-fg/50",
                "transition-colors hover:border-white/[0.16] hover:text-fg/85 disabled:opacity-40",
              )}
              title="Refresh"
              aria-label="Refresh fleet"
            >
              <ArrowsClockwise size={12} weight="bold" className={refreshing ? "animate-spin" : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.07] text-fg/50 transition-colors hover:border-white/[0.16] hover:text-fg/85"
              aria-label="Close fleet view"
            >
              <X size={13} weight="bold" />
            </button>
          </div>
        </div>

        {relayBanner}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg/45">
              <CircleNotch size={18} weight="bold" className="animate-spin" />
              <span className="text-[12px]">Loading cloud agents…</span>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <Warning size={22} className="text-red-300/80" weight="fill" />
              <div className="max-w-[420px] text-[12.5px] leading-relaxed text-fg/70">
                {keyMissing
                  ? "Connect Cursor first — add an API key or log in via Settings → AI connections."
                  : `Could not load your cloud agents: ${error}`}
              </div>
              {keyMissing ? (
                <button
                  type="button"
                  className="rounded-md border border-violet-300/30 bg-violet-500/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-violet-100/90 transition-colors hover:bg-violet-500/[0.18]"
                  onClick={() => {
                    window.location.hash = `#${settingsRouteFor("agents.providers")}`;
                    onClose();
                  }}
                >
                  Open AI connections
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-md border border-white/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-fg/75 hover:border-white/[0.2]"
                  onClick={() => void refresh(false)}
                >
                  Retry
                </button>
              )}
            </div>
          ) : entries.length === 0 ? (
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
            <div className="space-y-4 px-4 py-3.5">
              {grouped.active.length > 0 ? (
                <section>
                  <SectionHeader label={`Active runs (${grouped.active.length})`} accent />
                  <div className="mt-1.5 space-y-1.5">
                    {grouped.active.map((entry) => (
                      <FleetRow
                        key={entry.agent.agentId}
                        entry={entry}
                        expanded={expandedId === entry.agent.agentId}
                        busy={busyAgentId === entry.agent.agentId}
                        confirmingDelete={confirmDeleteId === entry.agent.agentId}
                        usage={usageByAgentId[entry.agent.agentId]}
                        rowError={rowError?.agentId === entry.agent.agentId ? rowError.message : null}
                        onToggle={() => void expandEntry(entry.agent.agentId)}
                        onOpen={() => void openInAde(entry)}
                        onStop={() => void stopRun(entry)}
                        onPull={() => void pullIntoLane(entry)}
                        onArchive={() => void toggleArchive(entry)}
                        onRequestDelete={() => setConfirmDeleteId(entry.agent.agentId)}
                        onConfirmDelete={() => void deleteAgent(entry)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {grouped.lanes.map((group) => (
                <section key={group.laneId}>
                  <SectionHeader label={group.laneName} count={group.entries.length} />
                  <div className="mt-1.5 space-y-1.5">
                    {group.entries.map((entry) => (
                      <FleetRow
                        key={entry.agent.agentId}
                        entry={entry}
                        expanded={expandedId === entry.agent.agentId}
                        busy={busyAgentId === entry.agent.agentId}
                        confirmingDelete={confirmDeleteId === entry.agent.agentId}
                        usage={usageByAgentId[entry.agent.agentId]}
                        rowError={rowError?.agentId === entry.agent.agentId ? rowError.message : null}
                        onToggle={() => void expandEntry(entry.agent.agentId)}
                        onOpen={() => void openInAde(entry)}
                        onStop={() => void stopRun(entry)}
                        onPull={() => void pullIntoLane(entry)}
                        onArchive={() => void toggleArchive(entry)}
                        onRequestDelete={() => setConfirmDeleteId(entry.agent.agentId)}
                        onConfirmDelete={() => void deleteAgent(entry)}
                      />
                    ))}
                  </div>
                </section>
              ))}

              {grouped.unlinkedGroups.length > 0 ? (
                <section>
                  <SectionHeader
                    label="Unlinked"
                    hint="not started from a linked ADE chat"
                    count={grouped.unlinkedGroups.reduce((n, g) => n + g.entries.length, 0)}
                  />
                  <div className="mt-1.5 space-y-3">
                    {grouped.unlinkedGroups.map((group) => (
                      <div key={group.key}>
                        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.6px] text-fg/35">
                          {group.label}
                        </div>
                        <div className="space-y-1.5">
                          {group.entries.map((entry) => (
                            <FleetRow
                              key={entry.agent.agentId}
                              entry={entry}
                              expanded={expandedId === entry.agent.agentId}
                              busy={busyAgentId === entry.agent.agentId}
                              confirmingDelete={confirmDeleteId === entry.agent.agentId}
                              usage={usageByAgentId[entry.agent.agentId]}
                              rowError={rowError?.agentId === entry.agent.agentId ? rowError.message : null}
                              onToggle={() => void expandEntry(entry.agent.agentId)}
                              onOpen={() => void openInAde(entry)}
                              onStop={() => void stopRun(entry)}
                              onPull={() => void pullIntoLane(entry)}
                              onArchive={() => void toggleArchive(entry)}
                              onRequestDelete={() => setConfirmDeleteId(entry.agent.agentId)}
                              onConfirmDelete={() => void deleteAgent(entry)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {archivedCount > 0 && !showArchived ? (
                <div className="pt-1 text-center">
                  <button
                    type="button"
                    onClick={() => setShowArchived(true)}
                    className="text-[11px] text-fg/40 underline-offset-2 transition-colors hover:text-fg/70 hover:underline"
                  >
                    Show archived ({archivedCount})
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-2 text-[10.5px] text-fg/40">
          <div className="flex min-w-0 items-center gap-2">
            <span>
              {visibleEntries.length} agent{visibleEntries.length === 1 ? "" : "s"}
              {totalCostCents != null ? ` · $${(totalCostCents / 100).toFixed(2)} shown` : ""}
            </span>
            {result ? <span className="text-fg/25">· updated {formatCursorCloudAge(result.fetchedAt) ?? "just now"}</span> : null}
          </div>
          {showArchived ? (
            <button
              type="button"
              onClick={() => setShowArchived(false)}
              className="transition-colors hover:text-fg/70"
            >
              Hide archived
            </button>
          ) : (
            <a
              href="https://cursor.com/agents"
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                openExternalUrl("https://cursor.com/agents");
              }}
              className="inline-flex items-center gap-1 transition-colors hover:text-fg/70"
            >
              All agents on cursor.com
              <ArrowSquareOut size={10} weight="bold" />
            </a>
          )}
        </div>

        {/* Pulled notice toast */}
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
      </div>
    </>,
    document.body,
  );
}
