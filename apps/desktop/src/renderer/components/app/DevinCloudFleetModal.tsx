import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CircleNotch,
  Warning,
  X,
} from "@phosphor-icons/react";

import type {
  DevinCloudFleetEntry,
  DevinCloudFleetResult,
} from "../../../shared/types";
import devinMark from "../../assets/provider-logos/devin.svg";
import { openExternalUrl } from "../../lib/openExternal";
import {
  DEVIN_BLUE,
  devinCloudErrorMessage,
  devinCloudRepoLabel,
  formatDevinCloudAge,
  repoMatchKey,
} from "../../lib/devinCloudUtils";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { FleetRow, SectionHeader, isDevinCloudFleetEntryActive } from "./DevinCloudFleetRow";

type FleetFilter = "all" | "active" | "needs_you" | "finished" | "failed";
/** Locked provenance chips: org-wide rows, the caller's own, or ADE-launched. */
type ProvenanceFilter = "all" | "mine" | "ade";

function filterMatches(entry: DevinCloudFleetEntry, filter: FleetFilter): boolean {
  switch (filter) {
    case "active":
      return isDevinCloudFleetEntryActive(entry);
    case "needs_you":
      return entry.fleetStatus === "needs_you";
    case "finished":
      return entry.fleetStatus === "finished";
    case "failed":
      return entry.fleetStatus === "error";
    default:
      return true;
  }
}

function provenanceMatches(entry: DevinCloudFleetEntry, provenance: ProvenanceFilter): boolean {
  switch (provenance) {
    case "ade":
      return entry.createdViaAde;
    case "mine":
      return entry.createdViaAde || entry.session.origin === "mine";
    default:
      return true;
  }
}

export function DevinCloudFleetModal({
  projectRoot,
  projectName,
  onClose,
}: {
  projectRoot: string | null;
  projectName: string | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<DevinCloudFleetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [provenance, setProvenance] = useState<ProvenanceFilter>("mine");
  const [laneFilter, setLaneFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ sessionId: string; message: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pulledNotice, setPulledNotice] = useState<string | null>(null);
  const [pulledTarget, setPulledTarget] = useState<{ laneId: string; laneName: string; title: string } | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const requestGeneration = useRef(0);

  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const refresh = useCallback(async (soft: boolean) => {
    const generation = ++requestGeneration.current;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      // Devin lists every org session; archived rows are only returned when
      // explicitly requested, matching the "Show archived" reveal below.
      const next = await window.ade.ai.devinCloudFleet({ includeArchived: true, force: !soft });
      if (generation !== requestGeneration.current) return;
      setResult(next);
      setKeyMissing(false);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      const message = devinCloudErrorMessage(err);
      setKeyMissing(/api (key|token)|token|credential|configure/i.test(message));
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

  // Devin has no webhook feed — presence-gated polling while the modal is open
  // keeps running rows fresh without a background poller for a closed surface.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh(true);
    };
    const interval = window.setInterval(tick, 15_000);
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
      if (!showArchived && entry.session.isArchived) return false;
      if (!provenanceMatches(entry, provenance)) return false;
      if (laneFilter !== "all" && entry.ownership.laneId !== laneFilter) {
        // Unlinked rows survive a lane filter only when "all" is chosen.
        return false;
      }
      return filterMatches(entry, filter);
    });
  }, [entries, filter, laneFilter, provenance, showArchived]);

  const grouped = useMemo(() => {
    const active: DevinCloudFleetEntry[] = [];
    const byLane = new Map<string, { laneId: string; laneName: string; entries: DevinCloudFleetEntry[] }>();
    const unlinked = new Map<string, DevinCloudFleetEntry[]>();
    for (const entry of visibleEntries) {
      if (isDevinCloudFleetEntryActive(entry)) {
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
        const key = (entry.session.repos[0] ? repoMatchKey(entry.session.repos[0]) : null) ?? "unknown";
        const list = unlinked.get(key) ?? [];
        list.push(entry);
        unlinked.set(key, list);
      }
    }
    const recency = (entry: DevinCloudFleetEntry): number =>
      entry.session.updatedAt ?? entry.session.createdAt ?? 0;
    // needs_you floats above every other active status — it is the loud tier.
    const needsYouWeight = (entry: DevinCloudFleetEntry): number =>
      entry.fleetStatus === "needs_you" ? 1 : 0;
    active.sort((a, b) => needsYouWeight(b) - needsYouWeight(a) || recency(b) - recency(a));
    const lanes = [...byLane.values()];
    for (const group of lanes) {
      group.entries.sort((a, b) => recency(b) - recency(a));
    }
    lanes.sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));
    const unlinkedGroups = [...unlinked.entries()]
      .map(([key, list]) => ({
        key,
        label: list[0]?.session.repos[0]
          ? devinCloudRepoLabel(list[0].session.repos[0])
          : "No repo bound",
        entries: list.sort((a, b) => recency(b) - recency(a)),
      }))
      .sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));
    return { active, lanes, unlinkedGroups };
  }, [visibleEntries]);

  const totalAcus = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const entry of visibleEntries) {
      const acus = entry.session.acusConsumed;
      if (typeof acus === "number" && Number.isFinite(acus)) {
        sum += acus;
        any = true;
      }
    }
    return any ? sum : null;
  }, [visibleEntries]);

  const expandEntry = useCallback(async (devinSessionId: string) => {
    setExpandedId((current) => (current === devinSessionId ? null : devinSessionId));
    setConfirmDeleteId(null);
  }, []);

  const openInAde = useCallback(async (entry: DevinCloudFleetEntry) => {
    const devinSessionId = entry.session.sessionId;
    setBusySessionId(devinSessionId);
    setRowError(null);
    try {
      // Linked lanes win; the ade:lane tag carries the second-best link; an
      // org row with neither opens against the project's primary lane — the
      // mirror needs a lane for context, and primary is the repo itself.
      const laneId = entry.ownership.laneId
        ?? entry.adeLaneId
        ?? lanes.find((lane) => lane.laneType === "primary")?.id
        ?? null;
      if (!laneId) throw new Error("No lane available to host this chat.");
      const opened = await window.ade.ai.devinCloudOpenChat({
        devinSessionId,
        laneId,
      });
      if (opened.session) {
        announceWorkChatSessionCreated(projectRoot ?? "", opened.session);
      }
      onClose();
    } catch (err) {
      setRowError({ sessionId: devinSessionId, message: devinCloudErrorMessage(err) });
    } finally {
      setBusySessionId(null);
    }
  }, [lanes, onClose, projectRoot]);

  const terminateSession = useCallback(async (entry: DevinCloudFleetEntry) => {
    const devinSessionId = entry.session.sessionId;
    setBusySessionId(devinSessionId);
    setRowError(null);
    try {
      await window.ade.ai.devinCloudTerminateSession(devinSessionId);
      await refresh(true);
    } catch (err) {
      setRowError({ sessionId: devinSessionId, message: devinCloudErrorMessage(err) });
    } finally {
      setBusySessionId(null);
    }
  }, [refresh]);

  const pullIntoLane = useCallback(async (entry: DevinCloudFleetEntry) => {
    const devinSessionId = entry.session.sessionId;
    setBusySessionId(devinSessionId);
    setRowError(null);
    try {
      const pulled = await window.ade.ai.devinCloudPullIntoLane(devinSessionId);
      setPulledNotice(
        pulled.status === "created_lane"
          ? `Created lane '${pulled.laneName}' and merged ${pulled.mergedBranch}.`
          : `Merged ${pulled.mergedBranch} into '${pulled.laneName}'.`,
      );
      setPulledTarget({
        laneId: pulled.laneId,
        laneName: pulled.laneName,
        title: entry.session.title ?? devinSessionId,
      });
      void refreshLanes();
      await refresh(true);
    } catch (err) {
      setRowError({ sessionId: devinSessionId, message: devinCloudErrorMessage(err) });
    } finally {
      setBusySessionId(null);
    }
  }, [refresh, refreshLanes]);

  /**
   * Continue in lane — the cloud→local reverse of hand-off: opens the local
   * `devin` CLI in the lane that just received the session's branch, seeded
   * with the session context as its kickoff prompt.
   */
  const continueInLane = useCallback(async () => {
    if (!pulledTarget || continueBusy) return;
    setContinueBusy(true);
    try {
      await window.ade.agentChat.launchCli({
        laneId: pulledTarget.laneId,
        provider: "devin",
        kickoffPrompt:
          `This lane carries the work pushed by Devin session "${pulledTarget.title}" — ` +
          `the branch is already merged here. Review it and continue where the cloud session left off.`,
        title: `Devin · ${pulledTarget.title}`,
        disposition: "foreground",
      });
      setPulledNotice(null);
      setPulledTarget(null);
      onClose();
    } catch (err) {
      setError(devinCloudErrorMessage(err));
    } finally {
      setContinueBusy(false);
    }
  }, [continueBusy, onClose, pulledTarget]);

  const toggleArchive = useCallback(async (entry: DevinCloudFleetEntry) => {
    const devinSessionId = entry.session.sessionId;
    setBusySessionId(devinSessionId);
    setRowError(null);
    try {
      if (entry.session.isArchived) await window.ade.ai.devinCloudUnarchiveSession(devinSessionId);
      else await window.ade.ai.devinCloudArchiveSession(devinSessionId);
      await refresh(true);
    } catch (err) {
      setRowError({ sessionId: devinSessionId, message: devinCloudErrorMessage(err) });
    } finally {
      setBusySessionId(null);
    }
  }, [refresh]);

  const deleteSession = useCallback(async (entry: DevinCloudFleetEntry) => {
    const devinSessionId = entry.session.sessionId;
    setBusySessionId(devinSessionId);
    setRowError(null);
    try {
      // Devin's delete is terminate-and-archive: the session stops and leaves
      // the fleet list, keeping its transcript reachable in app.devin.ai.
      await window.ade.ai.devinCloudTerminateSession(devinSessionId, { archive: true });
      setConfirmDeleteId(null);
      setResult((current) => current
        ? { ...current, items: current.items.filter((item) => item.session.sessionId !== devinSessionId) }
        : current);
    } catch (err) {
      setRowError({ sessionId: devinSessionId, message: devinCloudErrorMessage(err) });
    } finally {
      setBusySessionId(null);
    }
  }, []);

  const archivedCount = useMemo(
    () => entries.filter((entry) => entry.session.isArchived).length,
    [entries],
  );
  const noVisibleSessionsBecauseArchived = entries.length > 0 && visibleEntries.length === 0 && archivedCount > 0;

  const renderRow = (entry: DevinCloudFleetEntry) => (
    <FleetRow
      key={entry.session.sessionId}
      entry={entry}
      expanded={expandedId === entry.session.sessionId}
      busy={busySessionId === entry.session.sessionId}
      confirmingDelete={confirmDeleteId === entry.session.sessionId}
      rowError={rowError?.sessionId === entry.session.sessionId ? rowError.message : null}
      onToggle={() => void expandEntry(entry.session.sessionId)}
      onOpen={() => void openInAde(entry)}
      onStop={() => void terminateSession(entry)}
      onPull={() => void pullIntoLane(entry)}
      onArchive={() => void toggleArchive(entry)}
      onRequestDelete={() => setConfirmDeleteId(entry.session.sessionId)}
      onConfirmDelete={() => void deleteSession(entry)}
    />
  );

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close Devin Cloud fleet"
        className="fixed inset-0 z-[9998] cursor-default bg-black/55 backdrop-blur-md"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Devin Cloud fleet"
        className="fixed left-1/2 top-1/2 z-[9999] flex h-[min(760px,calc(100dvh-28px))] w-[min(880px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
        style={{
          borderColor: "rgba(37,99,235,0.32)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(37,99,235,0.14)",
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3.5 py-2" style={{ background: "rgba(37,99,235,0.055)" }}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-md"
              style={{ background: "rgba(37,99,235,0.14)", color: DEVIN_BLUE }}
            >
              <img src={devinMark} alt="" className="h-4 w-4" />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[12.5px] font-medium text-fg/92">Devin Cloud</div>
              <div className="truncate text-[10.5px] text-fg/45">
                {projectName ? `${projectName} · ` : ""}org fleet
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Provenance chips — launch provenance is a locked extra: "From
                ADE" filters to `ade`-tagged sessions, "Mine" to the caller's. */}
            <div className="flex items-center overflow-hidden rounded-md border border-white/[0.08]" role="group" aria-label="Filter by origin">
              {(["mine", "ade", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setProvenance(value)}
                  className={cn(
                    "px-2 py-1 text-[10.5px] font-medium transition-colors",
                    provenance === value
                      ? "bg-sky-500/20 text-sky-100/90"
                      : "bg-white/[0.02] text-fg/50 hover:text-fg/80",
                  )}
                  aria-pressed={provenance === value}
                >
                  {value === "mine" ? "Mine" : value === "ade" ? "From ADE" : "All"}
                </button>
              ))}
            </div>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FleetFilter)}
              aria-label="Filter by status"
              className="h-7 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-fg/70 outline-none hover:border-white/[0.16]"
            >
              <option value="all">All statuses</option>
              <option value="needs_you">Needs you</option>
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

        {result && !loading ? (
          <div className="shrink-0 border-b border-white/[0.05] px-4 py-1.5 text-[11px] text-fg/45">
            Devin has no live event feed — this list refreshes itself while open, and on demand.
          </div>
        ) : null}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg/45">
              <CircleNotch size={18} weight="bold" className="animate-spin" />
              <span className="text-[12px]">Loading Devin sessions…</span>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <Warning size={22} className="text-red-300/80" weight="fill" />
              <div className="max-w-[420px] text-[12.5px] leading-relaxed text-fg/70">
                {keyMissing
                  ? "Connect Devin first — add an API token in Settings → AI providers."
                  : `Could not load your Devin sessions: ${error}`}
              </div>
              {keyMissing ? (
                <button
                  type="button"
                  className="rounded-md border border-sky-300/30 bg-sky-500/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-sky-100/90 transition-colors hover:bg-sky-500/[0.18]"
                  onClick={() => {
                    window.location.hash = `#${settingsRouteFor("agents.providers")}`;
                    onClose();
                  }}
                >
                  Open AI providers
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
                className="grid h-10 w-10 place-items-center overflow-hidden rounded-xl"
                style={{ background: "rgba(37,99,235,0.10)", color: DEVIN_BLUE }}
              >
                <img src={devinMark} alt="" className="h-5 w-5" />
              </span>
              <div className="text-[13px] font-medium text-fg/80">No Devin sessions</div>
              <div className="max-w-[380px] text-[11.5px] leading-relaxed text-fg/45">
                Sessions you launch from a chat composer with Devin Cloud — and anything
                started at app.devin.ai — will show up here.
              </div>
            </div>
          ) : noVisibleSessionsBecauseArchived ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="text-[13px] font-medium text-fg/80">All matching sessions are archived</div>
              <div className="max-w-[380px] text-[11.5px] leading-relaxed text-fg/45">
                Reveal archived sessions to inspect or unarchive them.
              </div>
              <button
                type="button"
                onClick={() => setShowArchived(true)}
                className="rounded-md border border-sky-300/25 bg-sky-500/[0.10] px-3 py-1.5 text-[11.5px] font-medium text-sky-100/90 hover:bg-sky-500/[0.18]"
              >
                Show archived ({archivedCount})
              </button>
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <div className="text-[13px] font-medium text-fg/80">No sessions match these filters</div>
              <div className="max-w-[380px] text-[11.5px] leading-relaxed text-fg/45">
                Try the All chip — org sessions started by other people do not count as Mine.
              </div>
            </div>
          ) : (
            <div className="space-y-4 px-4 py-3.5">
              {grouped.active.length > 0 ? (
                <section>
                  <SectionHeader label={`Active sessions (${grouped.active.length})`} accent />
                  <div className="mt-1.5 space-y-1.5">
                    {grouped.active.map(renderRow)}
                  </div>
                </section>
              ) : null}

              {grouped.lanes.map((group) => (
                <section key={group.laneId}>
                  <SectionHeader label={group.laneName} count={group.entries.length} />
                  <div className="mt-1.5 space-y-1.5">
                    {group.entries.map(renderRow)}
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
                          {group.entries.map(renderRow)}
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
              {visibleEntries.length} session{visibleEntries.length === 1 ? "" : "s"}
              {totalAcus != null ? ` · ${Math.round(totalAcus * 10) / 10} ACU shown` : ""}
            </span>
            {result ? <span className="text-fg/25">· updated {formatDevinCloudAge(result.fetchedAt) ?? "just now"}</span> : null}
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
              href="https://app.devin.ai"
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                openExternalUrl("https://app.devin.ai");
              }}
              className="inline-flex items-center gap-1 transition-colors hover:text-fg/70"
            >
              All sessions on app.devin.ai
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
            {pulledTarget ? (
              <button
                type="button"
                disabled={continueBusy}
                onClick={() => void continueInLane()}
                className="ml-1 inline-flex items-center gap-1 rounded-md border border-emerald-300/30 px-2 py-0.5 text-[11px] font-medium text-emerald-100/90 transition-colors hover:bg-emerald-300/10 disabled:opacity-50"
              >
                {continueBusy ? "Opening…" : "Continue in lane"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPulledNotice(null);
                setPulledTarget(null);
              }}
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
